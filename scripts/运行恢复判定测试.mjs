#!/usr/bin/env node
/**
 * WP-R1 / WP-P2 回归测试：
 * 1. 恢复判定以客观完成证据为准：有终稿/agent_end → completed，不再误判 failed；
 * 2. 失败/恢复收尾不得清空已产出的 artifacts；
 * 3. 长期未收口（默认 6 小时）的 Run 自动收尾，避免无限悬挂；
 * 4. 启动顺序：recoverActiveRuns 必须在 listen 之后（源码契约）；
 * 5. P2：Run JSON 用紧凑写（源码契约）。
 *
 * 用法: node scripts/运行恢复判定测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-recover-"));
const runsDir = path.join(tmp, "runs");
const eventsDir = path.join(tmp, "events");
const locksDir = path.join(tmp, "locks");
const workspace = path.join(tmp, "workspace");
for (const dir of [runsDir, eventsDir, locksDir, workspace]) fs.mkdirSync(dir, { recursive: true });

process.env.OAW_RUNS_DIR = runsDir;
process.env.OAW_EVENT_DIR = eventsDir;
process.env.OAW_WRITE_LOCK_DIR = locksDir;
process.env.OAW_RUN_RECOVER_MAX_AGE_MS = String(6 * 60 * 60_000);

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const nowIso = () => new Date().toISOString();
const oldIso = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();

function makeRun(id, overrides = {}) {
  const base = {
    id,
    version: 2,
    status: "recovering",
    clientId: "c1",
    threadId: "t1",
    sessionId: "s1",
    cwd: workspace,
    task: { mode: "agent", goal: "测试" },
    steps: [],
    events: [{ seq: 1, type: "run_started", at: nowIso(), data: {} }],
    eventSeq: 1,
    before: { root: workspace, files: {}, size: 0, truncated: false },
    after: null,
    artifacts: [],
    snapshotMode: "none",
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  return { ...base, ...overrides };
}

function writeRun(run) {
  fs.writeFileSync(path.join(runsDir, `${run.id}.json`), JSON.stringify(run, null, 2));
}
const readRun = (id) => JSON.parse(fs.readFileSync(path.join(runsDir, `${id}.json`), "utf8"));

const { recoverActiveRuns } = await import(pathToFileURL(path.resolve(ROOT, "server/runs.mjs")).href);

console.log("\n▶ R1 恢复判定");

{
  writeRun(makeRun("run_recovered_with_final", {
    finalText: "汇报材料已交付完成。",
    completion: { status: "success", source: "explicit", summary: "已完成", runId: "run_recovered_with_final" },
    artifacts: [{ artifactId: "artifact_old", path: "交付.docx", status: "ready" }],
  }));
  recoverActiveRuns();
  test("recovering + 终稿 → completed（不再误判失败）", () => {
    const run = readRun("run_recovered_with_final");
    assert.equal(run.status, "completed");
    assert.equal(run.completion?.source, "recovered");
    assert.match(String(run.completion?.summary || ""), /汇报材料/);
  });
  test("恢复性完成保留已有产物", () => {
    const run = readRun("run_recovered_with_final");
    assert.equal(run.artifacts.length, 1);
    assert.equal(run.artifacts[0].path, "交付.docx");
  });
}

{
  writeRun(makeRun("run_recovered_no_evidence", {
    artifacts: [{ artifactId: "artifact_keep", path: "半成品.md", status: "ready" }],
  }));
  recoverActiveRuns();
  test("recovering + 无终稿 → failed（保持原有语义）", () => {
    const run = readRun("run_recovered_no_evidence");
    assert.equal(run.status, "failed");
    assert.match(String(run.error || run.summary || ""), /服务重启|收尾/);
  });
  test("失败收尾不清空已有产物（标记 preserved）", () => {
    const run = readRun("run_recovered_no_evidence");
    assert.equal(run.artifacts.length, 1);
    assert.equal(run.artifacts[0].path, "半成品.md");
    assert.equal(run.artifacts[0].preserved, true);
  });
}

{
  writeRun(makeRun("run_stale_with_final", { status: "running", startedAt: oldIso(7), finalText: "早已完成" }));
  recoverActiveRuns();
  test("长期未收口 + 终稿 → completed", () => {
    const run = readRun("run_stale_with_final");
    assert.equal(run.status, "completed");
    assert.equal(run.completion?.source, "recovered");
  });
}

{
  writeRun(makeRun("run_stale_no_final", { status: "running", startedAt: oldIso(7) }));
  recoverActiveRuns();
  test("长期未收口 + 无终稿 → failed（错误说明超时）", () => {
    const run = readRun("run_stale_no_final");
    assert.equal(run.status, "failed");
    assert.match(String(run.error || ""), /未收口/);
  });
}

{
  writeRun(makeRun("run_recent_running", { status: "running" }));
  recoverActiveRuns();
  test("近期 running → 标记 recovering（交给用户继续）", () => {
    assert.equal(readRun("run_recent_running").status, "recovering");
  });
}

{
  writeRun(makeRun("run_agent_end_only", {
    status: "running",
    events: [
      { seq: 1, type: "run_started", at: nowIso(), data: {} },
      { seq: 2, type: "agent_end", at: nowIso(), data: { turns: 3 } },
    ],
    eventSeq: 2,
  }));
  recoverActiveRuns(); // 第一次 → recovering
  recoverActiveRuns(); // 第二次 → 有 agent_end，按完成收尾
  test("仅有 agent_end（无 finalText）也按完成收尾", () => {
    const run = readRun("run_agent_end_only");
    assert.equal(run.status, "completed");
    assert.equal(run.completion?.source, "recovered");
  });
}

console.log("\n▶ R1 启动顺序与 P2 写放大契约");

{
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8").replace(/\r\n/g, "\n");
  test("recoverActiveRuns 不再在模块顶层执行", () => {
    assert.doesNotMatch(index, /\nconst recoveredRunIds = recoverActiveRuns\(\);/);
    assert.match(index, /httpServer = app\.listen\([\s\S]{0,1600}?recoverActiveRuns\(\)/);
  });
  const runs = fs.readFileSync(path.join(ROOT, "server", "runs.mjs"), "utf8");
  test("Run 记录使用紧凑 JSON（不再 pretty-print）", () => {
    assert.match(runs, /atomicWriteFile\(file, JSON\.stringify\(value\), "utf8"\)/);
    assert.doesNotMatch(runs, /atomicWriteJson\(file, value\)/);
  });
}

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(failed ? "\n✗ 运行恢复判定测试存在失败" : "\n✓ 运行恢复判定测试全部通过");
process.exitCode = failed ? 1 : 0;
