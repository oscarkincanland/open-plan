#!/usr/bin/env node
/**
 * 环境能力测试
 * 覆盖：Windows 上的 shell 解析（Git Bash 优先、跳过 WSL 旧启动器、显式覆盖）
 *      bash 可用性探测与缓存 / 结构化错误 / 提示文案 / 文本改写规则
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  probeBashAvailability,
  resetBashAvailabilityCache,
  resolveBashShell,
  pickBashShellFromCandidates,
  bashUnavailableError,
  bashEnvironmentHint,
  bashShellHint,
  bashWorkspaceRule,
  bashEnvironmentInfo,
} = await import(pathToFileURL(path.join(ROOT, "server", "环境能力.mjs")).href);

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

console.log("\n▶ shell 解析");

test("显式指定 OAW_BASH_SHELL 优先生效", () => {
  const resolved = resolveBashShell({ env: { OAW_BASH_SHELL: "D:/custom/bash.exe" }, platform: "win32" });
  assert.equal(resolved.shell, "D:/custom/bash.exe");
  assert.equal(resolved.kind, "custom");
});

test("非 Windows 直接用系统 bash", () => {
  const resolved = resolveBashShell({ env: {}, platform: "linux" });
  assert.equal(resolved.shell, "bash");
  assert.equal(resolved.kind, "native");
});

test("候选里跳过 WSL 旧启动器（无发行版时只会输出 UTF-16 乱码）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-shell-"));
  try {
    const system32 = path.join(dir, "Windows", "System32");
    fs.mkdirSync(system32, { recursive: true });
    const legacy = path.join(system32, "bash.exe");
    const real = path.join(dir, "real-bash.exe");
    fs.writeFileSync(legacy, "");
    fs.writeFileSync(real, "");
    assert.equal(pickBashShellFromCandidates([legacy]), "", "System32\\bash.exe 不应被选中");
    assert.equal(pickBashShellFromCandidates([legacy, real]), real);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("解析出的 shell 必须是真实存在的文件", () => {
  const resolved = resolveBashShell();
  if (!resolved.shell) {
    assert.equal(resolved.kind, "none");
    assert.ok(resolved.reason, "找不到 shell 时必须给出原因");
    return;
  }
  assert.ok(fs.existsSync(resolved.shell), `shell 不存在: ${resolved.shell}`);
});

test("Pi settings.json 的 shellPath 优先生效（产品与 SDK 用同一个 shell）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-shell-setting-"));
  try {
    const shellFile = path.join(dir, "bash.exe");
    fs.writeFileSync(shellFile, "");
    const settingsFile = path.join(dir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ shellPath: shellFile }), "utf8");
    const resolved = resolveBashShell({ env: {}, platform: "win32", settingsPaths: [settingsFile] });
    assert.equal(resolved.shell, shellFile);
    assert.equal(resolved.kind, "configured");
    assert.equal(resolved.source, "settings.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings.json 指向不存在的 shell 时回落到自动探测", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-shell-setting-bad-"));
  try {
    const settingsFile = path.join(dir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ shellPath: path.join(dir, "missing.exe") }), "utf8");
    const resolved = resolveBashShell({ env: {}, platform: "win32", settingsPaths: [settingsFile] });
    assert.notEqual(resolved.kind, "configured", "路径不存在时不应采用设置值");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log("\n▶ bash 探测");

test("探测结果结构完整且带时间戳", () => {
  resetBashAvailabilityCache();
  const probe = probeBashAvailability();
  assert.equal(typeof probe.available, "boolean");
  assert.ok(probe.platform);
  assert.ok(probe.probedAt);
  assert.ok("shell" in probe);
  assert.ok("shellKind" in probe);
});

test("探测结果被缓存（二次调用不再重探）", () => {
  resetBashAvailabilityCache();
  const first = probeBashAvailability();
  const second = probeBashAvailability();
  assert.equal(first.probedAt, second.probedAt, "同一次进程内不应重复探测");
});

test("探测判据是「能否真的执行命令」而非 wsl --status", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "环境能力.mjs"), "utf8");
  assert.ok(!source.includes('"--status"'), "不能用 wsl.exe --status 判定：未装发行版时它也返回 0");
  assert.ok(source.includes("__oaw_probe__"), "应实际执行一次命令来判定可用性");
});

test("探测失败原因不包含 UTF-16 乱码（模型看不懂）", () => {
  const probe = probeBashAvailability();
  if (!probe.available) {
    assert.ok(!/�/.test(probe.reason), "原因文案不得含替换字符");
    assert.ok(probe.reason.length < 200, "原因文案应简短可读");
  }
});

console.log("\n▶ 提示与规则");

test("不可用时给出结构化错误与可执行建议", () => {
  const unavailable = bashUnavailableError();
  assert.equal(unavailable.code, "bash_unavailable");
  assert.ok(unavailable.message.includes("bash"), "错误文案应点明 bash");
  assert.ok(unavailable.suggestion.includes("officecli"), "建议应指向可用工具");
  assert.ok(unavailable.suggestion.includes("read"), "建议应指向可用工具");
  assert.ok(unavailable.suggestion.includes("edit"), "建议应指向 edit");
});

test("环境提示：不可用时提示改用其它工具，可用时为空", () => {
  const probe = probeBashAvailability();
  const hint = bashEnvironmentHint();
  if (probe.available) {
    assert.equal(hint, "", "可用时不应添加提示");
  } else {
    assert.ok(hint.includes("NOT available"), "不可用时应明确告知模型");
    assert.ok(hint.includes("Do not retry"), "不可用时应劝阻重试");
  }
});

test("shell 语义提示：可用时说明路径写法，不可用时为空", () => {
  const probe = probeBashAvailability();
  const hint = bashShellHint();
  if (!probe.available) {
    assert.equal(hint, "");
    return;
  }
  assert.ok(hint.includes("bash"), "应说明由哪种 shell 提供");
  assert.ok(hint.includes("/") , "应给出路径写法提示");
});

test("工作区规则包含「文本改写用 edit、不用 sed」与 bash 使用边界", () => {
  const rule = bashWorkspaceRule();
  assert.ok(rule.includes("edit"), "应指明用 edit 改写文本");
  assert.ok(rule.includes("sed"), "应明确禁止用 sed 改写文本");
  assert.ok(rule.includes("officecli"), "应指明文档走 officecli");
  assert.ok(rule.includes("bash"), "应说明 bash 的使用边界");
});

test("工作区规则与探测结果一致（可用时说明可用）", () => {
  const probe = probeBashAvailability();
  const rule = bashWorkspaceRule();
  if (probe.available) assert.ok(rule.includes("可用"), "可用时应说明 bash 可用");
  else assert.ok(rule.includes("不可用"), "不可用时应说明 bash 不可用");
});

test("诊断快照结构完整（供 /api/agent/diagnostics 展示）", () => {
  const info = bashEnvironmentInfo();
  assert.equal(typeof info.available, "boolean");
  assert.ok("shell" in info);
  assert.ok("shellKind" in info);
  assert.ok("shellSource" in info);
  assert.ok("reason" in info);
  assert.ok(info.probedAt);
  if (info.available) assert.ok(info.shell, "可用时必须给出实际使用的 shell");
});

console.log(failed ? "\n✗ 环境能力测试存在失败项\n" : "\n✓ 环境能力测试全部通过\n");
process.exit(failed ? 1 : 0);
