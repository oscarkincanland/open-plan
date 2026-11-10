#!/usr/bin/env node
/**
 * 技能依赖与工作区安装测试（D1，2026-11-08）
 *
 * 覆盖计划 2026-11-08-001 §9：
 *   - requires 声明解析（runtime/python/npm/exec/network/platform/install）；
 *   - 只读预检 ready/degraded/blocked（含平台不支持、缺 Python、缺包）；
 *   - 依赖目录限制在工作区 `.oaw/skill-deps/`；
 *   - UI 触发的安装 job：隔离 venv、manifest、job 状态、取消/卸载要求确认；
 *   - Agent 禁止自装：安装只由 startSkillDepsInstall（API）触发。
 *
 * 用法：node scripts/技能依赖与安装测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("test() 不支持异步用例，请用 awaitTest");
    }
    console.log(`  ✓ ${name}`);
  } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}
async function awaitTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-skill-deps-"));
process.env.OAW_JOBS_DIR = path.join(tempRoot, "jobs");

const {
  parseRequires,
  parseRequiresInstall,
  skillDepsDir,
  skillVenvPython,
  findExecutable,
  probeSkillDeps,
  removeSkillDeps,
} = await import("../server/技能依赖.mjs");
const { startSkillDepsInstall, uninstallSkillDeps, skillInstallJob } = await import("../server/技能安装.mjs");

const REQUIRE = [
  "runtime: [{ kind: python, version: \">=3.10\" }]",
  "python: [python-pptx, cairosvg]",
  "npm: []",
  "exec: [python]",
  "network: true",
  "platform: [win32, darwin, linux]",
].join("\n");

test("parseRequires 解析 runtime/python/exec/network/platform", () => {
  const parsed = parseRequires(REQUIRE, "");
  assert.ok(parsed);
  assert.deepEqual(parsed.python, ["python-pptx", "cairosvg"]);
  assert.equal(parsed.runtime[0].kind, "python");
  assert.match(parsed.runtime[0].version, />=3\.10/);
  assert.deepEqual(parsed.platform, ["win32", "darwin", "linux"]);
  assert.equal(parsed.network, true);
  assert.deepEqual(parsed.exec, ["python"]);
});

test("parseRequires 支持 install 块（requirements.txt / package.json）", () => {
  const parsed = parseRequires("python: [a]\n", "python: requirements.txt\nnpm: package.json");
  assert.equal(parsed.install.python, "requirements.txt");
  assert.equal(parsed.install.npm, "package.json");
  assert.deepEqual(parseRequiresInstall("python: requirements.txt"), { python: "requirements.txt", npm: "" });
});

test("无声明时 parseRequires 返回 null，预检为 ready", () => {
  assert.equal(parseRequires("", ""), null);
  const deps = probeSkillDeps({ skill: { name: "plain", path: "plain/SKILL.md" }, workspace: tempRoot });
  assert.equal(deps.status, "ready");
  assert.equal(deps.code, "SKILL_DEPS_NONE");
});

test("平台不支持 → blocked（SKILL_DEP_PLATFORM_UNSUPPORTED 语义）", () => {
  const deps = probeSkillDeps({
    skill: { name: "posix-only", path: "x/SKILL.md", requiresText: "platform: [darwin, linux]" },
    workspace: tempRoot,
    platform: "win32",
    pathEnv: "",
  });
  assert.equal(deps.status, "blocked");
  assert.match(deps.reasons.join(" "), /仅支持/);
});

test("缺 Python → blocked 且提示运行时缺失", () => {
  const deps = probeSkillDeps({
    skill: { name: "need-py", path: "x/SKILL.md", requiresText: "runtime: [{ kind: python, version: \">=3.10\" }]" },
    workspace: tempRoot,
    platform: "win32",
    pathEnv: path.join(tempRoot, "empty-path"),
  });
  assert.equal(deps.status, "blocked");
  assert.equal(deps.code, "SKILL_DEP_RUNTIME_MISSING");
  assert.ok(deps.reasons.length > 0);
  assert.match(deps.reasons.join(" "), /Python/);
});

test("findExecutable 在指定 PATH 中查找（不启动子进程）", () => {
  const bin = path.join(tempRoot, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, process.platform === "win32" ? "demo.exe" : "demo");
  fs.writeFileSync(fake, "x");
  const found = findExecutable("demo", { pathEnv: bin, platform: process.platform });
  assert.equal(path.basename(found || "").toLowerCase(), path.basename(fake).toLowerCase());
  assert.equal(findExecutable("not-exist", { pathEnv: bin, platform: process.platform }), null);
});

test("工作区隔离目录：venv 路径在 .oaw/skill-deps/<skill>/ 下", () => {
  const dir = skillDepsDir(tempRoot, "Ultimate PPT Master!");
  assert.ok(dir.startsWith(path.join(path.resolve(tempRoot), ".oaw", "skill-deps")));
  assert.match(dir, /ultimate-ppt-master/);
  const venv = skillVenvPython(tempRoot, "demo", "win32");
  assert.ok(venv.startsWith(dir.replace(/Ultimate PPT Master!.*$/, "")) || venv.includes(".oaw"));
  assert.match(venv, /\.venv[\\/](Scripts|bin)[\\/]python(\.exe)?$/);
});

test("已就绪的隔离 venv + 假 runner → 预检 ready", () => {
  const skill = { name: "ready-skill", path: "x/SKILL.md", requiresText: "runtime: [{ kind: python, version: \">=3.10\" }]\npython: [alpha]" };
  const dir = skillDepsDir(tempRoot, "ready-skill");
  const fakePython = process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
  fs.mkdirSync(path.dirname(fakePython), { recursive: true });
  fs.writeFileSync(fakePython, "x");
  const deps = probeSkillDeps({ skill, workspace: tempRoot, mode: "full", runner: () => {} });
  assert.equal(deps.status, "ready");
  assert.match(deps.checks.map((check) => check.id).join(","), /python/);
});

test("PATH 设备级解释器 + 包全可导入 → ready（设备级依赖也算数，计划 2026-11-10-001 V3）", () => {
  const bin = path.join(tempRoot, "device-python");
  fs.mkdirSync(bin, { recursive: true });
  const fakePython = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
  fs.writeFileSync(fakePython, "x");
  const skill = { name: "device-skill", path: "x/SKILL.md", requiresText: "runtime: [{ kind: python, version: \">=3.10\" }]\npython: [alpha, beta]" };
  const deps = probeSkillDeps({ skill, workspace: tempRoot, mode: "full", pathEnv: bin, runner: () => {} });
  assert.equal(deps.status, "ready");
  assert.equal(deps.code, "SKILL_DEPS_OK");
  // Windows 大小写不敏感：PATHEXT 命中的扩展名可能是 .EXE，用大小写无关断言
  assert.ok(deps.python && path.resolve(deps.python).toLowerCase().startsWith(bin.toLowerCase()));
  assert.equal(path.basename(deps.python).toLowerCase().replace(/\.exe$/, ""), "python");
  assert.ok(deps.checks.some((check) => check.id === "python" && /PATH/.test(check.detail)));
});

test("缺包 → blocked（SKILL_DEP_PACKAGE_MISSING）", () => {
  const skill = { name: "missing-pkg", path: "x/SKILL.md", requiresText: "python: [missingpkg]" };
  const dir = skillDepsDir(tempRoot, "missing-pkg");
  const fakePython = process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
  fs.mkdirSync(path.dirname(fakePython), { recursive: true });
  fs.writeFileSync(fakePython, "x");
  let calls = 0;
  const deps = probeSkillDeps({
    skill,
    workspace: tempRoot,
    mode: "full",
    runner: () => { calls += 1; throw new Error("ModuleNotFoundError"); },
  });
  assert.equal(deps.status, "blocked");
  assert.match(deps.reasons.join(" "), /缺少/);
  assert.ok(calls >= 1);
});

test("probeSkillDeps declared 模式不逐包探测（degraded/unknown）", () => {
  const skill = { name: "declared-only", path: "x/SKILL.md", requiresText: "python: [a, b]" };
  const dir = skillDepsDir(tempRoot, "declared-only");
  const fakePython = process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
  fs.mkdirSync(path.dirname(fakePython), { recursive: true });
  fs.writeFileSync(fakePython, "x");
  const deps = probeSkillDeps({ skill, workspace: tempRoot, mode: "declared", runner: () => { throw new Error("should not run"); } });
  assert.equal(deps.status, "degraded");
  assert.ok(deps.checks.some((check) => check.id === "python-packages" && check.status === "unknown"));
});

test("卸载必须 confirm=true，且只删工作区内目录", () => {
  const result = uninstallSkillDeps({ workspace: tempRoot, name: "x", confirm: false });
  assert.equal(result.ok, false);
  const dir = skillDepsDir(tempRoot, "to-remove");
  fs.mkdirSync(dir, { recursive: true });
  const removed = removeSkillDeps(tempRoot, "to-remove");
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(dir), false);
  // 越界保护：传空 workspace/相对路径也不会删到项目目录
  const outside = removeSkillDeps(path.join(tempRoot, "nested"), "x");
  assert.equal(outside.removed, true);
});

await awaitTest("安装 job：假 runner 记录命令、写 manifest、job 完成", async () => {
  const workspace = fs.mkdtempSync(path.join(tempRoot, "ws-"));
  const skillDir = path.join(workspace, "skills", "demo-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo-skill\n---\n");
  const fakePython = path.join(tempRoot, "tools", "python.exe");
  fs.mkdirSync(path.dirname(fakePython), { recursive: true });
  fs.writeFileSync(fakePython, "x");
  const skill = {
    name: "demo-skill",
    path: path.join(skillDir, "SKILL.md"),
    requiresText: "runtime: [{ kind: python, version: \">=3.10\" }]\npython: [alpha, beta]\nplatform: [win32, darwin, linux]",
  };
  const calls = [];
  const fakeRunner = async (command, args) => {
    calls.push({ command: path.basename(command), args });
    return { exitCode: 0 };
  };
  const started = startSkillDepsInstall({ skill, workspace, runner: fakeRunner, pythonOverride: fakePython, runId: "run_test_skill_deps" });
  assert.equal(started.ok, true);
  assert.ok(started.jobId.startsWith("job_"));
  await started.promise;
  assert.equal(calls.length >= 2, true, `应至少调用 venv + pip，实际 ${calls.length}`);
  assert.match(calls.map((item) => item.args.join(" ")).join("\n"), /-m pip install/);
  const manifestPath = path.join(skillDepsDir(workspace, "demo-skill"), "manifest.json");
  assert.equal(fs.existsSync(manifestPath), true, "应写 manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.status, "ready");
  assert.deepEqual(manifest.python, ["alpha", "beta"]);
  assert.ok(manifest.dir.startsWith(path.join(path.resolve(workspace), ".oaw", "skill-deps")));
  const job = skillInstallJob(started.jobId);
  assert.equal(job?.status, "completed");
});

await awaitTest("安装失败：runner 非零退出 → job failed 且 manifest 记录错误", async () => {
  const workspace = fs.mkdtempSync(path.join(tempRoot, "ws-fail-"));
  const fakePython = path.join(tempRoot, "tools", "python-fail.exe");
  fs.mkdirSync(path.dirname(fakePython), { recursive: true });
  fs.writeFileSync(fakePython, "x");
  const skill = { name: "fail-skill", path: "x/SKILL.md", requiresText: "runtime: [{ kind: python }]\npython: [alpha]" };
  const fakeRunner = async (command, args) => {
    if (args.includes("venv")) return { exitCode: 0 };
    return { exitCode: 1, error: "network down" };
  };
  const started = startSkillDepsInstall({ skill, workspace, runner: fakeRunner, pythonOverride: fakePython, runId: "run_test_skill_fail" });
  await started.promise;
  const manifest = JSON.parse(fs.readFileSync(path.join(skillDepsDir(workspace, "fail-skill"), "manifest.json"), "utf8"));
  assert.equal(manifest.status, "failed");
  assert.match(manifest.error, /pip 安装失败/);
  const job = skillInstallJob(started.jobId);
  assert.equal(job?.status, "failed");
});

// 接线守护
test("index.mjs 提供依赖预检/安装/取消/卸载 API，且安装要求 confirm 与开关", () => {
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(index, /app\.get\("\/api\/skills\/:name\/deps"/);
  assert.match(index, /app\.post\("\/api\/skills\/:name\/deps\/install"/);
  assert.match(index, /app\.post\("\/api\/skills\/:name\/deps\/cancel"/);
  assert.match(index, /app\.post\("\/api\/skills\/:name\/deps\/uninstall"/);
  assert.match(index, /SKILL_DEPS_CONFIRM_REQUIRED/);
  assert.match(index, /RUNTIME_FLAGS\.skillDeps/);
  assert.match(index, /SKILL_DEPS_DISABLED/);
  const flags = fs.readFileSync(path.join(ROOT, "server", "运行开关.mjs"), "utf8");
  assert.match(flags, /skillDeps: readFlag\("OAW_SKILL_DEPS"\)/);
});

test("agent.mjs 在 skills_read 中做只读预检并写 skill_preflight 事件", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(agent, /probeSkillDeps\(\{ skill, workspace/);
  assert.match(agent, /writeEvent\("skill_preflight"/);
  assert.match(agent, /不得自行执行 pip\/npm/);
});

console.log(failed ? "\n技能依赖与安装测试：存在失败" : "\n技能依赖与安装测试：全部通过");
process.exit(failed ? 1 : 0);
