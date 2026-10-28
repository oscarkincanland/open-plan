#!/usr/bin/env node
/**
 * 产物归属与 Run 终态回归：
 *   1. touchedPaths 同时含具体路径与 "." 时，只能按具体路径归属；
 *   2. 只有 "." 的写入只能得到 run-window（疑似），不得自动进入交付候选；
 *   3. Run 终态后到达的 agent_end/assistant_final 只能进 lateEvents，
 *      不得再进入 Run 事件流（否则前端会复活运行态）。
 *
 * 用法: node scripts/产物归属与终态测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "规聚产物归属-"));
process.env.OAW_RUNS_DIR = path.join(temp, "runs");
process.env.OAW_EVENT_DIR = path.join(temp, "events");
process.env.OAW_WRITE_LOCK_DIR = path.join(temp, "locks");

const {
  beginRun,
  finishRun,
  filterRunChanges,
  getRun,
  isRunTerminal,
  recordRunEvent,
} = await import("../server/runs.mjs");

const workspace = path.join(temp, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "before.txt"), "before");

try {
  // 1. 具体路径 + "."：其他文件不得被吸收
  const run1 = beginRun({ clientId: "test", threadId: "t1", sessionId: "s1", cwd: workspace, task: { mode: "agent" } });
  fs.writeFileSync(path.join(workspace, "a.docx"), "A");
  fs.writeFileSync(path.join(workspace, "other-run.xlsx"), "OTHER");
  recordRunEvent(run1.id, "write_started", { path: "a.docx" });
  recordRunEvent(run1.id, "write_started", { path: "." });
  finishRun(run1.id, { status: "completed", summary: "case1" });
  const saved1 = getRun(run1.id);
  assert.deepEqual(saved1.artifacts.map((item) => item.path).sort(), ["a.docx"], "具体路径存在时不得吸收其他文件");
  assert.equal(saved1.artifacts[0].source, "write-ledger", "具体台账路径应为 write-ledger");
  assert.equal(saved1.artifacts[0].autoDeliverable, true, "台账确认的产物应可自动交付");

  // 2. 只有 "."：run-window 疑似，不得自动交付
  const run2 = beginRun({ clientId: "test", threadId: "t1", sessionId: "s1", cwd: workspace, task: { mode: "agent" } });
  fs.writeFileSync(path.join(workspace, "window.txt"), "W");
  recordRunEvent(run2.id, "write_started", { path: "." });
  finishRun(run2.id, { status: "completed", summary: "case2" });
  const saved2 = getRun(run2.id);
  const windowArtifact = saved2.artifacts.find((item) => item.path === "window.txt");
  assert.ok(windowArtifact, "工作区级写入应保留窗口内变更");
  assert.equal(windowArtifact.source, "run-window", "只有工作区级写入时来源应为 run-window");
  assert.equal(windowArtifact.autoDeliverable, false, "疑似变更不得自动进入交付候选");

  // 3. 终态围栏：迟到事件只进 lateEvents
  const late = recordRunEvent(run1.id, "agent_end", { turns: 1 });
  assert.equal(late, null, "终态后的事件不得再更新 Run 投影");
  const saved1b = getRun(run1.id);
  assert.ok((saved1b.lateEvents || []).some((item) => item.type === "agent_end"), "迟到事件应写入 lateEvents");
  assert.equal((saved1b.events || []).some((item) => item.type === "agent_end"), false, "迟到事件不得进入 Run 事件流");
  assert.equal(isRunTerminal(run1.id), true, "终态缓存应命中");

  // 4. filterRunChanges 纯函数回归
  const filtered = filterRunChanges(
    { touchedPaths: [".", "a.docx"], cwd: workspace },
    [{ path: "a.docx" }, { path: "other-run.xlsx" }],
  );
  assert.deepEqual(filtered.map((item) => item.path), ["a.docx"], "filterRunChanges 必须忽略 . 通配");

  console.log("产物归属与终态测试：通过");
} finally {
  await new Promise((resolve) => setTimeout(resolve, 200));
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
}
