#!/usr/bin/env node
/**
 * 专家团队按需触发与可观测性测试（2026-11-09，计划 2026-11-09-001）
 *
 * 覆盖 P0/P1：
 *   - 建议器：≥2 正向信号才建议；负向（单步/短文本/Chat/显式子代理）不建议；
 *   - 能力计划：/team → required；建议 → suggested；envelope 透传 teamIntent；
 *   - 提示词：决策表、[团队建议]/[团队要求] 注入；
 *   - 事件：team_suggested / team_spawn_blocked / team_started.trigger；
 *   - 护栏：无任务 team_spawn 阻断；
 *   - 前端：/team 命令、teamIntent payload、Chat 拒绝、团队来源徽标；
 *   - 指标：team-metrics.json 计数与空团队统计。
 *
 * 用法：node scripts/团队建议与触发测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const { shouldSuggestTeam } = await import("../server/团队建议.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-team-metrics-"));
process.env.OAW_TEAM_METRICS_FILE = path.join(tempDir, "team-metrics.json");
const metrics = await import("../server/团队指标.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

// ---------- 建议器 ----------
const COMPLEX = { level: "complex", score: 5, reasons: ["有明确产出物", "多份材料"] };

test("正向：多份材料 + 多章节 → 建议（≥2 信号）", () => {
  const result = shouldSuggestTeam({
    text: "把这三份材料整理成一份多章节规划报告，写完后要审阅",
    mode: "agent",
    references: [{ kind: "file" }, { kind: "file" }],
    complexity: COMPLEX,
  });
  assert.equal(result.suggested, true);
  assert.ok(result.score >= 2);
  assert.ok(result.reasons.length >= 1);
  assert.equal(result.minTasks, 2);
});

test("正向：撰写—审阅闭环 + 复杂任务 → 建议", () => {
  const result = shouldSuggestTeam({
    text: "撰写一份可研报告并安排独立审阅复核",
    mode: "agent",
    complexity: COMPLEX,
  });
  assert.equal(result.suggested, true);
  assert.ok(result.signals.includes("write_review_loop"));
});

test("负向：单文件/单步任务不推荐", () => {
  const result = shouldSuggestTeam({ text: "读一下这个文件，告诉我讲了什么", mode: "agent" });
  assert.equal(result.suggested, false);
  assert.equal(result.negative, "single_step");
});

test("负向：Chat 模式不推荐（没有团队工具）", () => {
  const result = shouldSuggestTeam({ text: "写一份多章节报告并审阅", mode: "chat", references: [{}, {}] });
  assert.equal(result.suggested, false);
  assert.equal(result.negative, "chat_mode");
});

test("负向：显式只要 run_subagent 且未提团队 → 不建议", () => {
  const result = shouldSuggestTeam({ text: "用 run_subagent 并行读这些材料并汇总", mode: "agent", references: [{}, {}] });
  assert.equal(result.suggested, false);
  assert.equal(result.negative, "explicit_subagent");
});

test("阈值可配置：1 个信号默认不触发，阈值=1 时触发", () => {
  const input = { text: "把这两份材料汇总成审阅报告", mode: "agent", references: [{}, {}] };
  const one = shouldSuggestTeam({ ...input, complexity: null });
  // 该文本同时命中多材料 + 写作审阅；用只有单信号的文本验证阈值更稳
  const single = { text: "写完报告后复核一下", mode: "agent" };
  assert.equal(shouldSuggestTeam({ ...single, threshold: 2 }).suggested, false);
  assert.equal(shouldSuggestTeam({ ...single, threshold: 1 }).suggested, true);
  assert.ok(one.score >= 1);
});

// ---------- 服务端接线 ----------
test("task.mjs：teamIntent 透传 + required/suggested 能力计划", () => {
  const task = read("server/task.mjs");
  assert.match(task, /teamIntent: input\.teamIntent === "required" \? "required" : "auto"/);
  assert.match(task, /shouldSuggestTeam\(/);
  assert.match(task, /status: requestedTeam \? "required" : \(teamSuggestion\.suggested \? "suggested" : "available"\)/);
  assert.match(task, /minTasks/);
});

test("agent.mjs：决策表 / 建议注入 / 护栏 / 来源 trigger", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /专家团队与子代理的选择/);
  assert.match(agent, /\[团队建议\]/);
  assert.match(agent, /\[团队要求\]/);
  assert.match(agent, /emitChannelSafe\(entry, "team_suggested"/);
  assert.match(agent, /team_spawn_blocked/);
  assert.match(agent, /const trigger = teamIntent === "required" \? "user"/);
  assert.match(agent, /RUNTIME_FLAGS\.teamGuard/);
  assert.match(agent, /TEAM_TASKS_REQUIRED/);
});

test("团队编排器：team_started 携带 trigger/teamIntent/suggestReasons", () => {
  const orchestrator = read("server/团队编排器.mjs");
  assert.match(orchestrator, /trigger: this\.trigger/);
  assert.match(orchestrator, /teamIntent: this\.teamIntent/);
  assert.match(orchestrator, /suggestReasons/);
});

test("运行开关：三个开关默认开，且进入 /api/status 快照", () => {
  const flags = read("server/运行开关.mjs");
  assert.match(flags, /teamSuggest: readFlagDefault\("OAW_TEAM_SUGGEST", true\)/);
  assert.match(flags, /teamGuard: readFlagDefault\("OAW_TEAM_GUARD", true\)/);
  assert.match(flags, /teamRequiredEntry: readFlagDefault\("OAW_TEAM_REQUIRED_ENTRY", true\)/);
  assert.match(flags, /teamSuggest: RUNTIME_FLAGS\.teamSuggest/);
});

test("事件注册表：team_suggested / team_spawn_blocked 已登记", () => {
  const registry = read("server/事件注册表.mjs");
  assert.match(registry, /type: "team_suggested"/);
  assert.match(registry, /type: "team_spawn_blocked"/);
  assert.match(registry, /trigger: "string"/);
});

// ---------- 前端 ----------
test("ChatPanel：/team 命令、chat 拒绝、teamIntent payload、模式 chip", () => {
  const chat = read("client/src/components/ChatPanel.jsx");
  assert.match(chat, /insert: "\/team "/);
  assert.ok(chat.includes("/^\\/team(?:\\s|$)"), "缺少 /team 命令匹配");
  assert.match(chat, /专家团队只在 Work\/Review 可用/);
  assert.match(chat, /teamIntent: teamRequiredForSend \? "required" : "auto"/);
  assert.match(chat, /team-mode-chip/);
  assert.match(chat, /team-suggest-skipped/);
});

test("团队面板：来源徽标（用户指定/系统建议/模型自选）", () => {
  const panel = read("client/src/components/TeamPanel.jsx");
  assert.match(panel, /team-trigger-badge/);
  assert.match(panel, /用户指定/);
  assert.match(panel, /系统建议/);
  assert.match(panel, /模型自选/);
  const styles = read("client/src/styles.css");
  assert.match(styles, /\.team-trigger-badge/);
});

// ---------- 指标 ----------
test("团队指标：建议/创建/来源/阻断/关闭 计数与空团队", () => {
  metrics.resetTeamMetrics();
  metrics.recordTeamSuggested();
  metrics.recordTeamStarted("user");
  metrics.recordTeamStarted("suggested");
  metrics.recordTeamBlocked();
  metrics.recordTeamClosed("team-empty"); // 无任务更新 → 空团队
  const snapshot = metrics.teamMetricsSnapshot();
  assert.equal(snapshot.suggested, 1);
  assert.equal(snapshot.started, 2);
  assert.equal(snapshot.byTrigger.user, 1);
  assert.equal(snapshot.byTrigger.suggested, 1);
  assert.equal(snapshot.blocked, 1);
  assert.equal(snapshot.closed, 1);
  assert.equal(snapshot.emptyTeams, 1);
  const file = process.env.OAW_TEAM_METRICS_FILE;
  assert.ok(fs.existsSync(file));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8"))) === false); // 是对象不是数组
});

test("团队指标：有任务更新的团队不算空团队", () => {
  metrics.resetTeamMetrics();
  metrics.recordTeamTaskUpdate("team-active");
  metrics.recordTeamClosed("team-active");
  assert.equal(metrics.teamMetricsSnapshot().emptyTeams, 0);
});

console.log(failed ? "\n团队建议与触发测试：存在失败" : "\n团队建议与触发测试：全部通过");
process.exit(failed ? 1 : 0);
