#!/usr/bin/env node
/**
 * 运行终态载荷测试（2026-11-06，019 后续）
 *
 * 覆盖两处审查发现的服务端缺陷：
 *   1. `run_finished.data.artifacts` 曾经写成数量（number），与事件注册表 schema
 *      （array）和前端 run 总结卡（读 `.path`）不一致；现必须与 SSE 同形状。
 *   2. Run 事件流超过 800 条时静默丢弃，回放"少事件但无提示"；现必须留痕
 *      （`eventsTruncated` / `eventsDropped`）。
 *
 * 用法：node scripts/运行终态载荷测试.mjs
 * 退出码：0 = 全部通过。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-run-payload-"));
// 必须在 import runs.mjs 之前设置：模块在加载时读取这些环境变量。
process.env.OAW_RUNS_DIR = path.join(tmp, "runs");
process.env.OAW_EVENT_DIR = path.join(tmp, "events");
process.env.OAW_WRITE_LOCK_DIR = path.join(tmp, "locks");
process.env.OAW_INSTANCE_DIR = path.join(tmp, "instances");
process.env.OAW_GOAL_DIR = path.join(tmp, "goals");
process.env.OAW_DISABLE_RECOVERY = "1";

const { beginRun, recordRunEvent, finishRun, getRun } = await import("../server/runs.mjs");

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

console.log("▶ run_finished 载荷形状");

const run = beginRun({ clientId: "payload-test", threadId: "payload-test", cwd: tmp, snapshotMode: "none" });
recordRunEvent(run.id, "tool_start", { name: "bash", toolCallId: "c1", input: "echo hi" });
recordRunEvent(run.id, "tool_end", { name: "bash", toolCallId: "c1", isError: false, result: "hi" });
finishRun(run.id, { status: "completed", summary: "载荷测试" });

const finishedRun = getRun(run.id);
const finishedEvent = (finishedRun?.events || []).find((event) => event?.type === "run_finished");

test("run_finished 事件存在", () => {
  assert.ok(finishedEvent, "未找到 run_finished 事件");
});

test("artifacts 是数组（与注册表 schema / 前端投影一致）", () => {
  assert.ok(Array.isArray(finishedEvent.data.artifacts), `期望数组，实际 ${typeof finishedEvent.data.artifacts}`);
});

test("保留 artifactCount 便于列表/徽标少传字节", () => {
  assert.equal(typeof finishedEvent.data.artifactCount, "number");
  assert.equal(finishedEvent.data.artifactCount, finishedEvent.data.artifacts.length);
});

test("artifacts 条目只携带展示所需字段", () => {
  for (const item of finishedEvent.data.artifacts) {
    assert.equal(typeof item.path, "string");
    assert.ok(item.path.length > 0);
    assert.ok(!("content" in item) && !("preview" in item), "终态载荷不应携带全文/预览");
  }
});

test("eventsTruncated 是布尔（供前端提示回放不完整）", () => {
  assert.equal(typeof finishedEvent.data.eventsTruncated, "boolean");
  assert.equal(finishedEvent.data.eventsTruncated, false, "正常长度的 Run 不应标记截断");
});

console.log("▶ Run 事件流上限留痕");

const longRun = beginRun({ clientId: "payload-test", threadId: "payload-test", cwd: tmp, snapshotMode: "none" });
for (let i = 0; i < 860; i += 1) {
  recordRunEvent(longRun.id, "tool_call_progress", { toolCallId: `c${i}`, phase: "start", name: "bash" });
}
const longView = getRun(longRun.id);

test("事件数不超过上限 800", () => {
  assert.ok(longView.events.length <= 800, `实际 ${longView.events.length}`);
});

test("超限留痕：eventsTruncated + eventsDropped", () => {
  assert.equal(longView.eventsTruncated, true);
  assert.ok(Number(longView.eventsDropped) > 0, `eventsDropped=${longView.eventsDropped}`);
});

finishRun(longRun.id, { status: "completed", summary: "长事件流" });

test("终态记录本身不被丢弃", () => {
  const view = getRun(longRun.id);
  assert.ok((view.events || []).some((event) => event?.type === "run_finished"));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error("\n✗ 运行终态载荷存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 运行终态载荷全部通过\n");
