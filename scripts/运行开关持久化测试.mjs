/**
 * 运行开关持久化回归（test:runtime-flags-file，2026-11-11）。
 *
 * 背景：创作画布等能力此前只认启动进程的环境变量，服务换个终端/快捷方式重启就会
 * "时有时无"（实测：10:40 那次重启没带 OAW_CREATIVE_CANVAS，画布消失）。
 * 现在优先级为「环境变量 > .oaw/runtime-flags.json > 代码默认」。
 *
 * 这里用 OAW_RUNTIME_FLAGS_FILE 指向临时文件，逐条验证：
 *  1. 无环境变量 + 文件开 → 开，来源 file；
 *  2. 环境变量显式关（优先级更高）→ 关，来源 env；
 *  3. 文件缺失/损坏 → 关，来源 default（不误开）；
 *  4. 文件里的未知键被忽略，不影响其它开关；
 *  5. 服务端 /api/status 暴露开关来源与文件路径（排查"为什么这次是关的"）。
 *
 * 运行：node scripts/运行开关持久化测试.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const passed = [];
function check(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-flags-"));
const flagsFile = path.join(tmpDir, "runtime-flags.json");

/** 在干净的子进程里读开关，避免父进程 env 干扰。 */
function readFlagInChild(extraEnv = {}) {
  const base = { ...process.env, OAW_RUNTIME_FLAGS_FILE: flagsFile };
  delete base.OAW_CREATIVE_CANVAS; // 先清父进程干扰，再应用用例指定的环境变量
  const env = { ...base, ...extraEnv };
  const script = "import('./server/运行开关.mjs').then((m) => process.stdout.write(JSON.stringify({"
    + "value: m.RUNTIME_FLAGS.creativeCanvas,"
    + "source: m.flagSource('OAW_CREATIVE_CANVAS'),"
    + "file: m.RUNTIME_FLAGS_FILE })));";
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

try {
  console.log("▶ 持久化文件优先级");

  check("文件写 creativeCanvas:true 且无环境变量 → 开，来源 file", () => {
    fs.writeFileSync(flagsFile, JSON.stringify({ creativeCanvas: true }), "utf8");
    const result = readFlagInChild();
    assert.equal(result.value, true, "文件开启应生效");
    assert.equal(result.source, "file", `来源应为 file，实际 ${result.source}`);
    assert.equal(result.file, flagsFile, "应使用测试指定的文件路径");
  });

  check("环境变量显式关优先于文件 → 关，来源 env", () => {
    const result = readFlagInChild({ OAW_CREATIVE_CANVAS: "0" });
    assert.equal(result.value, false, "显式关闭必须压倒文件里的开");
    assert.equal(result.source, "env");
  });

  check("环境变量显式开优先于文件关 → 开，来源 env", () => {
    fs.writeFileSync(flagsFile, JSON.stringify({ creativeCanvas: false }), "utf8");
    const result = readFlagInChild({ OAW_CREATIVE_CANVAS: "1" });
    assert.equal(result.value, true);
    assert.equal(result.source, "env");
  });

  check("文件缺失 → 关，来源 default（不误开）", () => {
    fs.rmSync(flagsFile, { force: true });
    const result = readFlagInChild();
    assert.equal(result.value, false, "没有配置时必须默认关，与历史基线一致");
    assert.equal(result.source, "default");
  });

  check("文件损坏 → 关，来源 default（不抛错）", () => {
    fs.writeFileSync(flagsFile, "{ this is not json", "utf8");
    const result = readFlagInChild();
    assert.equal(result.value, false);
    assert.equal(result.source, "default");
  });

  check("未知键被忽略，不影响目标开关", () => {
    fs.writeFileSync(flagsFile, JSON.stringify({ someUnknownFlag: true, creativeCanvas: true }), "utf8");
    const result = readFlagInChild();
    assert.equal(result.value, true);
    assert.equal(result.source, "file");
  });

  console.log("▶ 服务端诊断字段");

  check("/api/status 暴露 runtimeFlagSources 与 runtimeFlagsFile", () => {
    const source = fs.readFileSync(path.join(root, "server", "index.mjs"), "utf8");
    assert.match(source, /runtimeFlagSources:\s*\{\s*creativeCanvas:\s*flagSource\("OAW_CREATIVE_CANVAS"\)\s*\}/, "状态接口应给出开关来源");
    assert.match(source, /runtimeFlagsFile:\s*RUNTIME_FLAGS_FILE/, "状态接口应给出持久化文件路径");
  });

  check("运行开关 CLI 存在于 scripts 且可只读列出来源", () => {
    const cli = path.join(root, "scripts", "运行开关.mjs");
    assert.ok(fs.existsSync(cli), "应有 scripts/运行开关.mjs");
    const stdout = execFileSync(process.execPath, [cli, "list"], { cwd: root, encoding: "utf8", env: { ...process.env, OAW_RUNTIME_FLAGS_FILE: flagsFile } });
    assert.match(stdout, /creativeCanvas/, "list 输出应包含 canonical 开关名");
    assert.match(stdout, /持久化文件/, "list 输出应给出文件位置");
  });
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

if (!process.exitCode) {
  console.log(`\n运行开关持久化回归：通过（${passed.length} 项）`);
}
