#!/usr/bin/env node
/**
 * 会话流时间线测试（落地文档 2026-10-31-001 §9）：
 * 校验 buildRunTimeline 的块顺序保持、工具状态归并、缺失工具补插、系统提醒归类，
 * 以及 splitCompletionSummary 的结论/做了什么/详细展开拆分口径。
 * 用法: node scripts/chat-timeline-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import { buildRunTimeline, splitCompletionSummary, summarizeTimeline, toolObjectText, toolStateOf, advanceTypewriter } from "../client/src/chat-flow-projection.js";
import { reduceRunTrace } from "../client/src/运行轨迹.js";

let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); }
}

const at = (n) => new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString();
const ev = (type, data = {}, second = 0) => ({ type, at: at(second), data });

// ---------- 1. 块顺序保持 ----------
console.log("\n▶ 块顺序保持");
test("thinking/text/tool/process_note 按原顺序投影", () => {
  const items = buildRunTimeline({
    blocks: [
      { type: "thinking", id: "b1", text: "先想清楚" },
      { type: "text", id: "b2", text: "开始读文件" },
      { type: "tool", id: "t1", toolCallId: "c1", name: "read", input: "a.md", done: true, isError: false },
      { type: "text", id: "b3", text: "读完了，结论如下" },
      { type: "process_note", id: "b4", text: "[系统提醒] 该给进度小结了" },
    ],
  });
  assert.deepEqual(items.map((i) => i.kind), ["thinking", "text", "tool", "text", "sys"]);
  assert.equal(items[0].icon, "brain");
  assert.equal(items[1].cap, "阶段结论");
  assert.equal(items[4].text, "该给进度小结了");
  assert.ok(items[4].text.startsWith("该给"));
});

test("message_boundary 与未知块类型跳过，ask/approval 原样透传", () => {
  const askBlock = { type: "ask", id: "a1", question: "选哪个？" };
  const approvalBlock = { type: "approval", id: "p1", tool: "bash" };
  const items = buildRunTimeline({
    blocks: [
      { type: "message_boundary", id: "x" },
      { type: "mystery_block", id: "y" },
      askBlock,
      approvalBlock,
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "ask");
  assert.equal(items[0].block, askBlock);
  assert.equal(items[1].kind, "approval");
});

// ---------- 2. 工具状态归并 ----------
console.log("\n▶ 工具状态归并");
test("运行中/成功/失败三态", () => {
  assert.equal(toolStateOf({ done: false }), "run");
  assert.equal(toolStateOf({ done: true, isError: false }), "ok");
  assert.equal(toolStateOf({ done: true, isError: true }), "err");
  assert.equal(toolStateOf({ done: true, isError: false }, { isError: true, status: "done" }), "err");
});
test("轨迹已完结、块未完结时以块为准保持 run（避免终态闪烁前抢跑）", () => {
  assert.equal(toolStateOf({ done: false }, { status: "done", isError: false }), "run");
});

// ---------- 3. 缺失工具补插 ----------
console.log("\n▶ 缺失工具补插");
test("轨迹中 startMissing 的工具补到最后一个工具项之后", () => {
  const trace = reduceRunTrace([
    ev("run_admitted", {}, 0),
    ev("tool_start", { toolCallId: "c1", name: "grep", input: { pattern: "wsl" } }, 1),
    ev("tool_end", { toolCallId: "c1", name: "grep", isError: false }, 2),
    ev("tool_end", { toolCallId: "c2", name: "read", isError: false }, 5),
  ]);
  assert.equal(trace.tools[1].startMissing, true);
  const items = buildRunTimeline({
    blocks: [
      { type: "tool", id: "t1", toolCallId: "c1", name: "grep", done: true, isError: false },
      { type: "text", id: "b1", text: "小结" },
    ],
    trace,
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.kind), ["tool", "tool", "text"]);
  assert.equal(items[1].block.toolCallId, undefined);
  assert.equal(items[1].block.name, "read");
  assert.equal(items[1].block.done, true);
  assert.equal(items[1].block.startMissing, true);
});
test("无 id 的同名轨迹工具不重复补插", () => {
  const trace = reduceRunTrace([
    ev("tool_start", { name: "ls", input: "" }, 1),
    ev("tool_end", { name: "ls", isError: false }, 2),
  ]);
  const items = buildRunTimeline({
    blocks: [{ type: "tool", id: "t1", name: "ls", done: true, isError: false }],
    trace,
  });
  assert.equal(items.filter((i) => i.kind === "tool").length, 1);
});

// ---------- 4. 空输入与摘要 ----------
console.log("\n▶ 空输入与统计");
test("空 blocks 且无轨迹 → 空时间线；summarizeTimeline 统计工具数与运行中动作", () => {
  assert.deepEqual(buildRunTimeline({}), []);
  const items = buildRunTimeline({
    blocks: [
      { type: "tool", id: "t1", name: "bash", input: "node -v", done: false },
      { type: "thinking", id: "b1", text: "12345" },
    ],
  });
  const stats = summarizeTimeline(items);
  assert.equal(stats.toolCount, 1);
  assert.ok(stats.runningLabel.includes("bash"));
  assert.ok(stats.runningLabel.includes("node -v"));
});

// ---------- 5. toolObjectText ----------
console.log("\n▶ 工具对象摘要");
test("args 字符串优先、常用字段次之、bash/officecli 带 $ 前缀", () => {
  assert.equal(toolObjectText("read", { path: "a/b.md" }), "a/b.md");
  assert.equal(toolObjectText("grep", { pattern: "wsl|bash", limit: 10 }), "wsl|bash");
  assert.equal(toolObjectText("officecli", { args: "get 报告.docx /body --json" }), "$ get 报告.docx /body --json");
  assert.equal(toolObjectText("bash", "dir /b"), "$ dir /b");
  const longCmd = toolObjectText("bash", "x".repeat(200));
  assert.ok(longCmd.length <= 99, `超长命令应截断：${longCmd.length}`); // "$ "(2) + 96 + "…"(1)
});

// ---------- 6. splitCompletionSummary ----------
console.log("\n▶ 完成总结拆分");
test("「## 结论」分节提取为结论，且从详细展开中移除避免重复", () => {
  const r = splitCompletionSummary("## 结论\n\nWSL 无法由我代装，需你本机执行。\n\n## 根因\n\nbash 默认走 WSL。\n\n| 情况 | 处理 |\n| --- | --- |\n| A | 装发行版 |");
  assert.equal(r.conclusion, "WSL 无法由我代装，需你本机执行。");
  assert.ok(r.detail.includes("## 根因"));
  assert.ok(!r.detail.includes("## 结论"));
  assert.ok(r.detail.includes("| 情况 | 处理 |"));
  assert.equal(r.what, "");
});
test("「做了什么」分节进入 what；「你需要执行」等其余分节保留在 detail", () => {
  const summary = "## 结论\n\n装不了。\n\n## 做了什么\n\n定位根因并写成操作单。\n\n## 你需要执行\n\nwsl --install";
  const r = splitCompletionSummary(summary);
  assert.equal(r.what, "定位根因并写成操作单。");
  assert.equal(r.conclusion, "装不了。");
  assert.ok(r.detail.includes("你需要执行"));
  assert.ok(!r.detail.includes("做了什么"));
});
test("无标题结构的纯文本：首段为结论，其余为详细展开", () => {
  const r = splitCompletionSummary("第一段是结论。\n\n第二段是细节。\n\n第三段也是细节。");
  assert.equal(r.conclusion, "第一段是结论。");
  assert.ok(r.detail.includes("第二段"));
  assert.ok(!r.detail.startsWith("第一段"));
});
test("summary 为空回退 finalText；两者皆空返回空串", () => {
  assert.equal(splitCompletionSummary("", "终稿结论。\n\n终稿细节。").conclusion, "终稿结论。");
  assert.deepEqual(splitCompletionSummary("", ""), { what: "", conclusion: "", detail: "" });
});

// ---------- 7. 打字机推进（精修计划 2026-10-31-002 F2） ----------
console.log("\n▶ 打字机推进");
test("逐帧前进、不回退、到顶即停", () => {
  const text = "a".repeat(200);
  const f1 = advanceTypewriter(text, 0, 16, false);
  assert.ok(f1 > 0 && f1 <= 200, `首帧应推进：${f1}`);
  const f2 = advanceTypewriter(text, f1, 16, false);
  assert.ok(f2 >= f1, "不得回退");
  assert.equal(advanceTypewriter(text, 200, 16, false), 200, "到顶即停");
});
test("积压自动追赶：大段文本快速追平（比例收敛 + 每帧保底 1 字）", () => {
  const text = "b".repeat(5000);
  let shown = 0;
  for (let frame = 0; frame < 5 && shown < text.length; frame += 1) shown = advanceTypewriter(text, shown, 16, false);
  assert.ok(shown >= 1000, `前 5 帧应大幅追赶：${shown}`);
  for (let frame = 0; frame < 120 && shown < text.length; frame += 1) shown = advanceTypewriter(text, shown, 16, false);
  assert.equal(shown, 5000, "追赶最终应到达全文");
});
test("关闭动效（reducedMotion）直接给全文；空文本为 0", () => {
  assert.equal(advanceTypewriter("12345", 0, 16, true), 5);
  assert.equal(advanceTypewriter("", 0, 16, false), 0);
});

console.log(failed ? "\n✗ 有失败用例" : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
