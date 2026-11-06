#!/usr/bin/env node
/**
 * 会话流 Run 归属回归测试（P0-1）：
 *
 * 背景：同一 Run 内部的 office-pipeline / steer / 排队指令以多条 user 消息写入。
 * 旧版 associateRunMessages 把它们当“真实用户边界”提前截断，摘要卡之前的
 * assistant 拿不到 runId → timelinePath 失效 → 概览混用旧“运行结果”卡。
 *
 * 覆盖：
 *   1. office-pipeline steer 文本被识别为 internal harness；
 *   2. startedAt 时间窗：同一 Run 内部多条 user 不截断归属，摘要卡之前的
 *      assistant 全部拿到该 Run 的 runId；
 *   3. startedAt 缺失时回退旧“最近真实 user 边界”；
 *   4. 相邻两张摘要卡时间窗不互抢消息；
 *   5. 早于 Run 开始的孤儿 assistant 不被硬塞进本轮。
 *
 * 用法: node scripts/会话流Run归属回归测试.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { associateRunMessages, hiddenLegacySummaryRuns, isInternalHarnessMessage, mergeRunSummaries } = await import(new URL(`file:///${ROOT.replace(/\\/g, "/")}/client/src/运行展示投影.js`).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};
const uid = () => `id-${Math.random().toString(36).slice(2, 10)}`;

function assistant(text, createdAt) {
  return { id: uid(), role: "assistant", text, blocks: [{ type: "tool", id: uid(), name: "bash", input: "", output: "ok", done: true }], createdAt, status: "done" };
}
function user(text, createdAt) {
  return { id: uid(), role: "user", text, createdAt, status: "done" };
}
function summaryCard(runId, { startedAt = null, finishedAt = null, summary = "本轮任务" } = {}) {
  return { id: uid(), role: "system", summary: true, runId, runStatus: "cancelled", summary, startedAt, finishedAt, createdAt: finishedAt || startedAt, text: summary };
}

console.log("\n▶ internal harness 识别");

test("office-pipeline steer 文本识别为 internal", () => {
  const msg = user("本轮尚未使用 editorial_pipeline。请立即改用编辑流水线生成文档；不要用 bash 写生成脚本。");
  assert.equal(isInternalHarnessMessage(msg), true);
  assert.equal(isInternalHarnessMessage(user("本轮尚未使用编辑流水线，先补小结")), true);
  assert.equal(isInternalHarnessMessage(user("请立即改用编辑流水线生成文档")), true);
  assert.equal(isInternalHarnessMessage(user("帮我写一份规划")), false, "真实用户输入不算 internal");
});

console.log("\n▶ startedAt 时间窗归属");

test("同一 Run 内部多条 user（steer）不截断：摘要卡之前的 assistant 全部归属", () => {
  const runA = "run_test_a";
  const messages = [
    assistant("第一章草稿，调用了模板与工具", "2026-11-03T10:01:00Z"),
    user("本轮尚未使用 editorial_pipeline。请立即改用编辑流水线生成文档。", "2026-11-03T10:02:00Z"),
    assistant("按流水线重排后的结论", "2026-11-03T10:03:00Z"),
    summaryCard(runA, { startedAt: "2026-11-03T09:59:00Z" }),
  ];
  const associated = associateRunMessages(messages);
  assert.equal(associated[0].runId, runA, "steer 之前第一条 assistant 应归属 runA");
  assert.equal(associated[1].internalProcess, true, "office-pipeline user 应标 internalProcess");
  assert.equal(associated[1].runId, runA);
  assert.equal(associated[2].runId, runA, "steer 之后第二条 assistant 应归属 runA");
  assert.equal(associated[3].runId, runA, "摘要卡自身保持 runId");
});

test("早于 Run 开始的上一轮 assistant 不被本轮吞并", () => {
  const runA = "run_earlier", runB = "run_current";
  const messages = [
    assistant("上一轮的结论", "2026-11-03T09:50:00Z"),
    user("再写一份新的规划", "2026-11-03T09:59:30Z"),
    assistant("本轮正文", "2026-11-03T10:05:00Z"),
  ];
  const cards = [
    summaryCard(runB, { startedAt: "2026-11-03T09:59:00Z", finishedAt: "2026-11-03T10:06:00Z" }),
    summaryCard(runA, { startedAt: "2026-11-03T09:40:00Z", finishedAt: "2026-11-03T09:58:00Z" }),
  ];
  const associated = associateRunMessages(mergeRunSummaries([...messages], cards));
  const byText = (text) => associated.find((m) => m.text === text);
  assert.equal(byText("上一轮的结论").runId, runA, `早于 runB 开始的消息归上一轮（实际 ${byText("上一轮的结论").runId}）`);
  assert.equal(byText("本轮正文").runId, runB);
});

test("startedAt 缺失时回退旧“最近真实 user 边界”", () => {
  const runA = "run_legacy";
  const messages = [
    assistant("边界前的 assistant", "2026-11-03T10:01:00Z"),
    user("真实的下一条指令", "2026-11-03T10:02:00Z"),
    summaryCard(runA, { startedAt: null }),
  ];
  const associated = associateRunMessages(messages);
  assert.equal(associated[0].runId, undefined, "无 startedAt 时不得越过真实 user 边界");
});

test("时间戳缺失不要抛错且回退旧边界", () => {
  const runA = "run_no_time";
  const messages = [
    assistant("assistantA没有时间", undefined),
    user("本轮尚未使用 editorial_pipeline。请立即改用编辑流水线。", undefined),
    summaryCard(runA, { startedAt: "2026-11-03T10:00:00Z" }),
  ];
  const associated = associateRunMessages(messages);
  // user 内部消息继续向前扫（时间缺失不充当边界），assistantA 归到 runA。
  assert.equal(associated[0].runId, runA);
  assert.equal(associated[1].internalProcess, true);
});

console.log("\n▶ 相邻 Run 时间窗");

test("相邻两张摘要卡不会互抢消息", () => {
  const runA = "run_first", runB = "run_second";
  const raw = [
    user("第一个任务", "2026-11-03T10:00:00Z"),
    assistant("A 的产出", "2026-11-03T10:01:00Z"),
    user("第二个任务", "2026-11-03T10:02:00Z"),
    assistant("B 的产出", "2026-11-03T10:03:00Z"),
  ];
  const cards = [
    summaryCard(runA, { startedAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T10:01:30Z", summary: "A 完成" }),
    summaryCard(runB, { startedAt: "2026-11-03T10:02:00Z", finishedAt: "2026-11-03T10:03:30Z", summary: "B 完成" }),
  ];
  const merged = mergeRunSummaries([...raw], cards);
  const associated = associateRunMessages(merged);
  const byText = (text) => associated.find((m) => m.text === text);
  assert.equal(byText("A 的产出").runId, runA);
  assert.equal(byText("B 的产出").runId, runB);
  assert.equal(associated.filter((m) => m.summary && m.runId === runA).length, 1, "A 摘要卡只保留一张");
});

test("向后自愈分支不吞早于 startedAt 的孤儿 assistant", () => {
  const runA = "run_orphan_guard";
  const messages = [
    assistant("上一轮遗留孤儿", "2026-11-03T09:00:00Z"),
    summaryCard(runA, { startedAt: "2026-11-03T10:00:00Z" }),
  ];
  const associated = associateRunMessages(messages);
  assert.equal(associated[0].runId, undefined, "孤儿早于 startedAt 不得标记为本轮");
});

console.log("\n▶ 恢复链孤儿摘要卡（浏览器实测复现）");

test("同窗双 runId：恢复前卡的气泡与折叠条重复，孤儿卡应判为隐藏", () => {
  // 实测场景（金东 会话“帮我审查一下这个规划文本。并批注上去。”）：
  // 恢复前 run 8ef… 的 summary 卡收尾打断/恢复后 run fd9… 重挂 SSE 事件，
  // assistant 被归属到 fd9…；8ef… 的旧气泡与新折叠条显示同一时间窗的内容。
  const hiddenRun = "run_8ef503d4";
  const liveRun = "run_fd9b0dd8";
  const messages = [
    user("当前文件: 1126金东区农村公路规划（初稿）.docx，帮我批注上去。", "2026-11-03T01:15:09.138Z"),
    assistant("完成（有风险）·25 条批注全部写入安全副本", "2026-11-03T01:17:36.951Z"),
    summaryCard(hiddenRun, { startedAt: "2026-11-03T01:15:08.992Z", finishedAt: "2026-11-03T01:17:38.797Z", summary: "运行结束已完成（推断）2 个文件" }),
  ];
  // assistant 已带恢复后 run 的归属（来自 SSE 实时链路，associateRunMessages 不覆盖）
  const messages2 = messages.map((m) => m.role === "assistant" ? { ...m, runId: liveRun } : m);
  const hidden = hiddenLegacySummaryRuns(messages2);
  assert.equal(hidden.has(hiddenRun), true, "恢复前卡的时间窗被后 run 覆盖时应隐藏");
  // 反例：assistant 在窗外时不得误伤
  const away = messages2.map((m) => m.role === "assistant" ? { ...m, createdAt: "2026-11-02T23:00:00.000Z" } : m);
  const hiddenAway = hiddenLegacySummaryRuns(away);
  assert.equal(hiddenAway.has(hiddenRun), false, "窗外 assistant 不得触发隐藏");
});

console.log(failed ? "\n✗ 会话流 Run 归属回归测试存在失败" : "\n✓ 会话流 Run 归属回归测试全部通过");
process.exit(failed ? 1 : 0);
