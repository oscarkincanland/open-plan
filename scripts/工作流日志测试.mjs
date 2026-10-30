#!/usr/bin/env node
/**
 * 工作流 journal 测试
 * 覆盖：追加/读取 / 最后成功阶段 / 重放计划 / 非幂等阶段跳过
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-workflow-"));
process.env.OAW_WORKFLOW_JOURNAL_DIR = dir;

const { appendJournal, clearJournal, lastSuccessfulStage, planReplay, readJournal } = await import("../server/工作流日志.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

appendJournal("run1", { stage: "collect", status: "started" });
appendJournal("run1", { stage: "collect", status: "completed", artifacts: ["a.md"] });
appendJournal("run1", { stage: "analyze", status: "started" });
appendJournal("run1", { stage: "analyze", status: "failed", error: "boom" });

test("journal 追加与读取", () => {
  const records = readJournal("run1");
  assert.equal(records.length, 4);
  assert.equal(records[1].status, "completed");
  assert.deepEqual(records[1].artifacts, ["a.md"]);
});

test("最后成功阶段", () => {
  assert.equal(lastSuccessfulStage("run1").stage, "collect");
});

test("重放计划从第一个未完成阶段开始", () => {
  const plan = planReplay(["collect", "analyze", "report"], readJournal("run1"));
  assert.deepEqual(plan.completed, ["collect"]);
  assert.deepEqual(plan.pending, ["analyze", "report"]);
  assert.deepEqual(plan.rerun, ["analyze", "report"]);
});

test("非幂等阶段被标记跳过", () => {
  appendJournal("run1", { stage: "publish", status: "failed", idempotent: false });
  const plan = planReplay(["collect", "publish", "report"], readJournal("run1"));
  assert.deepEqual(plan.skipped, ["publish"]);
});

test("清理 journal", () => {
  clearJournal("run1");
  assert.equal(readJournal("run1").length, 0);
});

fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
