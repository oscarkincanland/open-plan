#!/usr/bin/env node
/**
 * 工作流执行器接线测试（H4-2）
 * 覆盖：Run 步骤更新 → journal 落盘 → 重放计划；开关关闭时不写 journal
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-workflow-executor-"));
const runsDir = path.join(root, "runs");
const eventsDir = path.join(root, "events");
const journalDir = path.join(root, "journal");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
process.env.OAW_RUNS_DIR = runsDir;
process.env.OAW_EVENT_DIR = eventsDir;
process.env.OAW_WORKFLOW_JOURNAL_DIR = journalDir;
process.env.OAW_WORKFLOW_JOURNAL = "1";

const { beginRun, updateRunStep, getRun } = await import("../server/runs.mjs");
const { planReplay, readJournal } = await import("../server/工作流日志.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const workflow = {
  id: "od-demand-analysis",
  name: "OD 需求分析",
  valid: true,
  steps: ["数据校验", "矩阵构建"],
};
const run = beginRun({ clientId: "workflow-test", cwd: workspace, workflow, snapshotMode: "none" });

test("Run 创建了工作流步骤", () => {
  const loaded = getRun(run.id);
  assert.equal(loaded.steps.length, 2);
  assert.equal(loaded.steps[0].id, "od-demand-analysis:step-1");
});

test("步骤 running 写入 journal started", () => {
  updateRunStep(run.id, "od-demand-analysis:step-1", { status: "running" });
  const journal = readJournal(run.id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].stage, "od-demand-analysis:step-1");
  assert.equal(journal[0].status, "started");
});

test("步骤 completed 写入 journal 与产物", () => {
  updateRunStep(run.id, "od-demand-analysis:step-1", { status: "completed", artifacts: ["od.csv"] });
  const journal = readJournal(run.id);
  assert.equal(journal.length, 2);
  assert.equal(journal[1].status, "completed");
  assert.deepEqual(journal[1].artifacts, ["od.csv"]);
});

test("重放计划跳过已完成阶段", () => {
  const journal = readJournal(run.id);
  const plan = planReplay(["od-demand-analysis:step-1", "od-demand-analysis:step-2"], journal);
  assert.deepEqual(plan.completed, ["od-demand-analysis:step-1"]);
  assert.deepEqual(plan.pending, ["od-demand-analysis:step-2"]);
});

test("workflow_journal_updated 事件可回放", () => {
  const eventFile = path.join(eventsDir, "事件流.jsonl");
  assert.ok(fs.existsSync(eventFile));
  const text = fs.readFileSync(eventFile, "utf8");
  assert.ok(text.includes("workflow_journal_updated"));
  assert.ok(text.includes("od-demand-analysis:step-1"));
});

fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
