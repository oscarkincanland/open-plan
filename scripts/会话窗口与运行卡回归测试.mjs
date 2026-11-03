#!/usr/bin/env node
/**
 * 会话窗口与运行中卡渲染回归测试（2026-11-03 验收 P1 修复）：
 *
 * 背景（实测复现）：
 *   1) P1-1 Chat 视图历史窗口按「原始 JSONL 条目数」裁剪，一个 7 分钟多工具
 *      Run 的几十条 toolResult 把本轮 user 提问挤出窗口——切回会话后“上一轮
 *      提问消失、只剩回答”。修复：server/会话窗口.mjs 按消息条数裁剪。
 *   2) P1-2 运行中刷新恢复首帧只有摘要卡时，卡被渲染成终态 RunSummary 旧卡
 *      （目标未达成/文件变更 0 项/技术详情 JSON）。修复：ChatPanel 对
 *      running/streaming 卡渲染轻量 LiveRunSummaryBar。
 *
 * 覆盖：
 *   A. computeChatWindowStart 纯函数 6 例（消息计数、长 Run 保留提问、
 *      孤立 toolResult 跳过、分页 before、不足一页、非消息条目不计）；
 *   B. 接线契约：index.mjs 使用模块函数；ChatPanel 的 Message 分支与
 *      LiveRunSummaryBar 结构。
 *
 * 用法: node scripts/会话窗口与运行卡回归测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 读取 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");
const { computeChatWindowStart } = await import(pathToFileURL(path.join(ROOT, "server/会话窗口.mjs")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};

const entry = (role, id = "") => ({ id, message: { role, content: id || role } });

console.log("\n▶ computeChatWindowStart（按消息条数裁剪）");

test("长 Run：30 条 toolResult 不把本轮提问挤出窗口", () => {
  const entries = [
    entry("user", "Q1"), entry("assistant", "A1"),
    entry("user", "Q2"),
  ];
  for (let i = 0; i < 30; i += 1) entries.push(entry("toolResult", `R${i}`));
  entries.push(entry("assistant", "A2"));
  const start = computeChatWindowStart(entries, entries.length, 50);
  const window = entries.slice(start);
  assert.equal(start, 0, "50 条消息上限下 4 条消息全部保留");
  assert.ok(window.some((e) => e.message.content === "Q2"), "本轮提问必须在窗口内");
  assert.ok(window.some((e) => e.message.content === "A2"), "本轮回答必须在窗口内");
});

test("按消息条数而非条目数截断：limit=2 从第 3 条消息起", () => {
  const entries = [
    entry("user", "Q1"), entry("assistant", "A1"),
    entry("user", "Q2"), entry("toolResult", "R0"), entry("assistant", "A2"),
  ];
  const start = computeChatWindowStart(entries, entries.length, 2);
  assert.equal(entries[start].message.content, "Q2", "窗口起点必须是第 3 条消息（Q2）");
  const window = entries.slice(start);
  assert.deepEqual(window.map((e) => e.message.role), ["user", "toolResult", "assistant"]);
});

test("分页 before：以 before 为窗口上界继续向前裁剪", () => {
  // before 指向第 4 条消息之前：窗口不应包含后面的消息
  const entries = [
    entry("user", "Q1"), entry("assistant", "A1"),
    entry("user", "Q2"), entry("assistant", "A2"),
    entry("user", "Q3"), entry("assistant", "A3"),
  ];
  const end = 4; // before=4
  const start = computeChatWindowStart(entries, end, 2);
  const window = entries.slice(start, end);
  assert.deepEqual(window.map((e) => e.message.content), ["Q2", "A2"], "before 分页只取该点上方的两个消息");
});

test("起点落在孤立 toolResult 时向后跳过", () => {
  const entries = [
    entry("assistant", "A0"), entry("toolResult", "R0"), entry("toolResult", "R1"),
    entry("user", "Q1"), entry("assistant", "A1"),
  ];
  // limit=1 → 只保留 A1 一条消息；起点会落在 R1（A1 的 toolResult 属于 A1，
  // 但前一条 toolResult 属于已出窗的 A0，必须跳过）
  const start = computeChatWindowStart(entries, entries.length, 1);
  const first = entries[start];
  assert.notEqual(first?.message?.role, "toolResult", "窗口不得以孤立 toolResult 开头");
  assert.equal(first.message.content, "A1");
});

test("不足一页时 start=0（不裁剪）", () => {
  const entries = [entry("user", "Q1"), entry("toolResult", "R0"), entry("assistant", "A1")];
  assert.equal(computeChatWindowStart(entries, entries.length, 50), 0);
});

test("非消息条目（model_change 等）不计入消息数，但随窗口保留", () => {
  const entries = [
    entry("user", "Q1"), { type: "model_change" }, entry("assistant", "A1"),
    entry("user", "Q2"), { type: "model_change" }, entry("assistant", "A2"),
  ];
  const start = computeChatWindowStart(entries, entries.length, 2);
  const window = entries.slice(start);
  assert.deepEqual(window.filter((e) => e.message).map((e) => e.message.content), ["Q2", "A2"]);
  assert.equal(window.length, 3, "窗口包含 2 条消息 + 两者之间的 model_change 条目");
});

console.log("\n▶ 接线契约");

test("server/index.mjs 通过 ./会话窗口.mjs 使用消息级窗口", () => {
  const index = 读取("server", "index.mjs");
  assert.match(index, /import \{ computeChatWindowStart \} from "\.\/会话窗口\.mjs"/, "index 应引入窗口模块");
  assert.match(index, /const historyStart = chatView \? computeChatWindowStart\(entries, historyEnd, chatLimit\) : 0;/, "chat 视图应使用消息级窗口");
  assert.doesNotMatch(index, /historyStart = chatView \? Math\.max\(0, historyEnd - chatLimit\)/, "不得回退按条目数裁剪");
});

test("ChatPanel：running/streaming 摘要卡渲染 LiveRunSummaryBar，而不是终态 RunSummary", () => {
  const chat = 读取("client", "src", "components", "ChatPanel.jsx");
  assert.match(chat, /function LiveRunSummaryBar\(\{ m \}\)/, "缺少 LiveRunSummaryBar");
  const startIdx = chat.indexOf("function LiveRunSummaryBar({ m })");
  const endIdx = chat.indexOf("function Message({", startIdx);
  const body = chat.slice(startIdx, endIdx);
  assert.match(body, /run-fold is-running open/, "运行条应复用折叠条样式（is-running）");
  assert.match(body, /运行中/, "运行条必须包含「运行中」文案");
  assert.match(body, /已完成|完成后自动汇总/, "运行条应提示完成后自动汇总");
  assert.doesNotMatch(body, /<RunSummary/, "运行条不得渲染终态 RunSummary");
  const messageIdx = chat.indexOf("function Message({");
  const seg = chat.slice(messageIdx, messageIdx + 1200);
  assert.match(seg, /if \(m\.runStatus === "running" \|\| m\.status === "streaming"\) \{\s*\n\s*return <LiveRunSummaryBar m=\{m\} \/>;/, "Message 应对运行中卡分流到 LiveRunSummaryBar");
});

console.log(failed ? "\n✗ 会话窗口与运行卡回归测试存在失败" : "\n✓ 会话窗口与运行卡回归测试全部通过");
process.exit(failed ? 1 : 0);
