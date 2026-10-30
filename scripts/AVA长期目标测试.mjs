#!/usr/bin/env node
/**
 * AVA 长期目标测试（v0.13.0–v0.13.1）
 *
 * 守护：
 *   1) Goal 数据层：创建/暂停/恢复/继续/完成/编辑/预算/清除六状态迁移；
 *   2) Run 收口统计：轮次、Token、活跃时长，预算/轮次上限自动转状态；
 *   3) API/事件/Prompt 注入与 GoalBar、`/goal` 命令契约。
 *
 * 用法：node scripts/AVA长期目标测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8").replace(/\r\n/g, "\n");
const task = fs.readFileSync(path.join(ROOT, "server", "task.mjs"), "utf8").replace(/\r\n/g, "\n");
const registry = fs.readFileSync(path.join(ROOT, "server", "事件注册表.mjs"), "utf8").replace(/\r\n/g, "\n");
const goalBar = fs.readFileSync(path.join(ROOT, "client", "src", "components", "GoalBar.jsx"), "utf8").replace(/\r\n/g, "\n");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-goal-test-"));
process.env.OAW_GOAL_DIR = path.join(tmp, "goals");
process.env.OAW_EVENT_DIR = path.join(tmp, "events");
const goal = await import(pathToFileURL(path.join(ROOT, "server", "goal.mjs")).href);

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
};

await test("创建 Goal：active、预算与统计初始为 0，并写入 JSON 文件", () => {
  const result = goal.setGoal("goal-session-a", { text: "完成交通规划报告", budgetTokens: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.goal.status, "active");
  assert.equal(result.goal.turns, 0);
  assert.equal(result.goal.usedTokens, 0);
  assert.equal(result.goal.budgetTokens, 1000);
  assert.ok(fs.existsSync(goal.goalFileFor("goal-session-a")));
  assert.deepEqual(goal.readGoal("goal-session-a")?.text, "完成交通规划报告");
});

await test("暂停/恢复/完成状态迁移与 completed 终态", () => {
  let result = goal.actOnGoal("goal-session-a", "pause");
  assert.equal(result.goal.status, "paused");
  result = goal.actOnGoal("goal-session-a", "resume");
  assert.equal(result.goal.status, "active");
  result = goal.actOnGoal("goal-session-a", "complete");
  assert.equal(result.goal.status, "complete");
  assert.ok(result.goal.completedAt);
  const rejected = goal.actOnGoal("goal-session-a", "pause");
  assert.equal(rejected.code, "GOAL_INVALID_STATE");
  assert.equal(goal.goalPromptContext("goal-session-a"), null);
  goal.clearGoal("goal-session-a");
});

await test("Run 收口累计轮次/Token/时长，并触发预算上限", () => {
  goal.setGoal("goal-session-b", { text: "预算测试", budgetTokens: 10 });
  const next = goal.recordRunFinished({
    sessionId: "goal-session-b",
    runId: "run-1",
    status: "completed",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    events: [{ type: "stats", data: { totalTokens: 12 } }],
  });
  assert.equal(next.turns, 1);
  assert.equal(next.usedTokens, 12);
  assert.ok(next.activeMs >= 4000);
  assert.equal(next.status, "budget_limited");
  const resumed = goal.actOnGoal("goal-session-b", "budget", { budgetTokens: 100 });
  assert.equal(resumed.goal.status, "active");
  goal.clearGoal("goal-session-b");
});

await test("轮次上限与 blocked 收口", () => {
  goal.setGoal("goal-session-c", { text: "轮次测试", maxTurns: 1 });
  let next = goal.recordRunFinished({ sessionId: "goal-session-c", runId: "run-1", status: "completed", events: [] });
  assert.equal(next.status, "max_turns");
  const continued = goal.actOnGoal("goal-session-c", "continue");
  assert.equal(continued.goal.status, "active");
  assert.ok(continued.goal.maxTurns > 1);
  next = goal.recordRunFinished({ sessionId: "goal-session-c", runId: "run-2", status: "completed", completionStatus: "blocked", events: [] });
  assert.equal(next.status, "blocked");
  assert.equal(goal.actOnGoal("goal-session-c", "resume").goal.status, "active");
  goal.clearGoal("goal-session-c");
});

await test("清除后文件删除、Prompt 注入为空", () => {
  goal.setGoal("goal-session-d", { text: "清除测试" });
  assert.ok(goal.goalPromptContext("goal-session-d"));
  const cleared = goal.clearGoal("goal-session-d");
  assert.equal(cleared.ok, true);
  assert.equal(fs.existsSync(goal.goalFileFor("goal-session-d")), false);
  assert.equal(goal.goalPromptContext("goal-session-d"), null);
});

await test("事件与 API/注入契约已登记", () => {
  for (const type of ["goal_created", "goal_updated", "goal_cleared"]) {
    assert.match(registry, new RegExp(`type: "${type}", lifecycle: true, persist: true`));
  }
  assert.match(index, /app\.get\("\/api\/sessions\/:id\/goal"/);
  assert.match(index, /app\.post\("\/api\/sessions\/:id\/goal"/);
  assert.match(index, /app\.post\("\/api\/sessions\/:id\/goal\/action"/);
  assert.match(index, /app\.delete\("\/api\/sessions\/:id\/goal"/);
  assert.match(task, /longTermGoal: input\.longTermGoal \|\| null/);
  assert.match(task, /长期目标：\$\{longTerm\.text\}/);
  assert.match(index, /goalPromptContext\(goalKey\)/);
});

await test("GoalBar 六状态操作与无障碍", () => {
  assert.match(goalBar, /export const GOAL_STATUS_LABELS = \{/);
  for (const status of ["active", "paused", "blocked", "max_turns", "budget_limited", "complete"]) {
    assert.match(goalBar, new RegExp(`${status}: "`));
  }
  assert.match(goalBar, /if \(!goal \|\| goal\.status === "complete"\) return null/);
  assert.match(goalBar, /aria-live="polite"/);
  assert.match(goalBar, /role="dialog" aria-label="目标详情"/);
  assert.match(goalBar, /runAction\("continue"\)/);
  assert.match(goalBar, /runAction\("budget"/);
});

await test("`/goal` 命令与 GoalBar 接线", () => {
  assert.ok(chatPanel.includes('/^\\/goal(?:\\s|$)/i'));
  assert.match(chatPanel, /const handleGoalCommand = useCallback/);
  assert.match(chatPanel, /if \(\/\^clear\$\/i\.test\(head\)\)/);
  assert.ok(chatPanel.includes('/^(pause|resume|continue|complete)$/i'));
  assert.match(chatPanel, /<GoalBar[\s\S]{0,120}goal=\{goal\}/);
  assert.match(chatPanel, /if \(wasBusy && !busy\) void refreshGoal\(\)/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\nAVA 长期目标测试：存在失败项" : "\nAVA 长期目标测试：全部通过（9 例）");
process.exit(failed ? 1 : 0);
