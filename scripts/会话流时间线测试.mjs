#!/usr/bin/env node
/**
 * 会话流时间线测试（落地文档 2026-10-31-001 §9）：
 * 校验 buildRunTimeline 的块顺序保持、工具状态归并、缺失工具补插、系统提醒归类、
 * splitCompletionSummary 的结论/详细展开拆分口径，以及折叠头终态文案（describeRunFold）。
 * 用法: node scripts/会话流时间线测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import { assignTimelineTurns, buildRunTimeline, describeRunFold, splitCompletionSummary, summarizeTimeline, toolObjectText, toolStateOf, advanceTypewriter } from "../client/src/会话流投影.js";
import { stripAnswerPrefill, stripToolMarkup } from "../client/src/工具标签清洗.js";
import { associateRunMessages, mergeRunSummaries, upsertRunSummaryMessage } from "../client/src/运行展示投影.js";
import { reduceRunTrace, resolveRunElapsedMs } from "../client/src/运行轨迹.js";

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
  assert.equal(items[1].cap, "阶段小结");
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


test("空思考块不渲染；只有 thinking 字段时也能取到正文", () => {
  const items = buildRunTimeline({
    blocks: [
      { type: "thinking", id: "empty", text: "   " },
      { type: "thinking", id: "redacted", thinking: "" },
      { type: "thinking", id: "legacy", thinking: "Pi 的 thinking 字段" },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "legacy");
  assert.equal(items[0].text, "Pi 的 thinking 字段");
  assert.equal(items[0].timeText, "16 字");
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

// ---------- 3b. 轨迹结果合并回工具块 ----------
console.log("\n▶ 轨迹结果合并回工具块");
test("块缺结果时用轨迹的 tool_end 结果补齐，并标记为已完成", () => {
  const trace = reduceRunTrace([
    ev("tool_start", { toolCallId: "c1", name: "read", input: { path: "a.md" } }, 1),
    ev("tool_end", { toolCallId: "c1", name: "read", isError: false, result: "文件内容" }, 2),
  ]);
  const items = buildRunTimeline({
    blocks: [{ type: "tool", id: "c1", toolCallId: "c1", name: "read", input: { path: "a.md" }, output: "", result: "", done: false }],
    trace,
  });
  const tool = items.find((i) => i.kind === "tool");
  assert.ok(tool, "工具行必须存在");
  assert.equal(tool.block.done, true, "轨迹已完结 → 块必须标记为已完成（否则永远转圈）");
  assert.equal(tool.block.result, "文件内容", "结果必须从轨迹补齐");
});
test("块已有结果时不覆盖（块优先）", () => {
  const trace = reduceRunTrace([
    ev("tool_start", { toolCallId: "c1", name: "read", input: "" }, 1),
    ev("tool_end", { toolCallId: "c1", name: "read", isError: false, result: "轨迹结果" }, 2),
  ]);
  const items = buildRunTimeline({
    blocks: [{ type: "tool", id: "c1", toolCallId: "c1", name: "read", output: "块内结果", result: "块内结果", done: true }],
    trace,
  });
  const tool = items.find((i) => i.kind === "tool");
  assert.equal(tool.block.result, "块内结果", "块自己的结果优先，不得被轨迹覆盖");
});
test("轨迹里有结果但块缺失时不再补插第二行", () => {
  const trace = reduceRunTrace([
    ev("tool_start", { toolCallId: "c1", name: "read", input: "" }, 1),
    ev("tool_end", { toolCallId: "c1", name: "read", isError: false, result: "内容" }, 2),
  ]);
  const items = buildRunTimeline({
    blocks: [{ type: "tool", id: "c1", toolCallId: "c1", name: "read", output: "", result: "", done: false }],
    trace,
  });
  assert.equal(items.filter((i) => i.kind === "tool").length, 1, "同一次调用只能出现一行");
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
test("单段结语：结论即全文，详细展开为空（不得重复渲染同一段）", () => {
  const r = splitCompletionSummary("按用户确认，就此收尾并交付当前版本。", "按用户确认，就此收尾并交付当前版本。");
  assert.equal(r.conclusion, "按用户确认，就此收尾并交付当前版本。");
  assert.equal(r.detail, "");
});
test("有分节但无「结论」：结论段从详细展开中移除，不出现两次", () => {
  const r = splitCompletionSummary("## 交付物\n\n交通专题地图已生成。\n\n## 已知限制\n\n未做实地核验。");
  assert.equal(r.conclusion, "交通专题地图已生成。");
  assert.equal(r.detail.includes("交通专题地图已生成。"), false);
  assert.ok(r.detail.includes("已知限制"));
});

// ---------- 6.1 多段结论不得被整节删除（2026-11-06 修复） ----------
test("多段「## 结论」：首段提到结论位，其余段落与节标题保留在详细内容", () => {
  const source = [
    "## 结论",
    "",
    "首段：整体判断。",
    "",
    "第二段：关键数据与依据。",
    "",
    "## 产物",
    "",
    "- 报告.docx",
  ].join("\n");
  const r = splitCompletionSummary("", source);
  assert.equal(r.conclusion, "首段：整体判断。");
  assert.ok(r.detail.includes("第二段：关键数据与依据"), "第 2 段不得丢失");
  assert.ok(r.detail.includes("## 结论"), "节标题与后续段落应保留");
  assert.ok(r.detail.includes("报告.docx"), "其他分节应保留");
  assert.equal(r.detail.includes("首段：整体判断。"), false, "首段不应重复出现");
});

test("「## 结论」下用 ### 子节展开：子节内容保留", () => {
  const source = ["## 结论", "", "结论首段。", "", "### 依据", "", "- 证据一", "- 证据二"].join("\n");
  const r = splitCompletionSummary("", source);
  assert.equal(r.conclusion, "结论首段。");
  assert.ok(r.detail.includes("### 依据"));
  assert.ok(r.detail.includes("证据一"));
});

test("单段「## 结论」仍然整节移除，不出现「空标题」", () => {
  const r = splitCompletionSummary("", "## 结论\n\n只有一段结论。\n\n## 下一步\n\n继续。");
  assert.equal(r.conclusion, "只有一段结论。");
  assert.equal(r.detail.includes("## 结论"), false);
  assert.ok(r.detail.includes("## 下一步"));
});

// ---------- 6.2 终稿预填前缀清洗 ----------
test("重复的 Final summary. 前缀被逐轮剥离", () => {
  assert.equal(
    stripAnswerPrefill("Final summary.Final summary.Final summary.结论正文。"),
    "结论正文。",
  );
  assert.equal(stripAnswerPrefill("Summary: 结论正文。"), "结论正文。");
  assert.equal(stripAnswerPrefill("最终总结：结论正文。"), "结论正文。");
});

test("不误删正常正文（用户要求以「总结」开头的内容保留）", () => {
  assert.equal(stripAnswerPrefill("总结一下今天的三个决定。"), "总结一下今天的三个决定。");
  assert.equal(stripAnswerPrefill("## 结论\n\n正文。"), "## 结论\n\n正文。");
});

test("与工具标签清洗串联：标签 + 预填前缀一起清", () => {
  const cleaned = stripAnswerPrefill(stripToolMarkup("Final summary.<ask_user question=\"x\"/>结论。"));
  assert.equal(cleaned, "结论。");
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

// ---------- 8. 历史恢复合并（运行中 Run 不得退回旧渲染） ----------
console.log("\n▶ 历史恢复合并");
const historyMsg = (id, role, createdAt, extra = {}) => ({ id, role, createdAt, text: id, ...extra });
const runCard = (runId, { startedAt, finishedAt = null, status = "running" }) => ({
  id: `run-summary-${runId}`,
  role: "system",
  summary: true,
  runId,
  runStatus: status,
  startedAt,
  finishedAt,
  createdAt: finishedAt || startedAt,
  text: "总结",
});
const historyFixture = [
  historyMsg("u1", "user", "2026-10-31T12:09:10.000Z"),
  historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
  historyMsg("u2", "user", "2026-10-31T12:20:00.000Z"),
  historyMsg("a2", "assistant", "2026-10-31T12:20:05.000Z"),
];
test("运行中的 Run：总结卡落在本轮消息之后，assistant 仍归到 runId", () => {
  const merged = mergeRunSummaries(historyFixture, [
    runCard("run-A", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:09:30.000Z", status: "completed" }),
    runCard("run-B", { startedAt: "2026-10-31T12:19:59.000Z" }),
  ]);
  const result = associateRunMessages(merged);
  assert.equal(result.find((item) => item.id === "a1").runId, "run-A");
  assert.equal(result.find((item) => item.id === "a2").runId, "run-B", "运行中的本轮必须保留 runId");
  assert.deepEqual(result.slice(-2).map((item) => item.id), ["a2", "run-summary-run-B"], "总结卡必须排在本轮消息之后");
});
test("已完成的 Run 落点保持（结论卡在本轮 assistant 之后）", () => {
  const merged = mergeRunSummaries(historyFixture.slice(0, 2), [
    runCard("run-A", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:09:30.000Z", status: "completed" }),
  ]);
  assert.deepEqual(merged.map((item) => item.id), ["u1", "a1", "run-summary-run-A"]);
});
test("两轮都缺 finishedAt：靠下一轮 startedAt 收口，不跨轮误归组", () => {
  const merged = mergeRunSummaries(historyFixture, [
    runCard("run-A", { startedAt: "2026-10-31T12:09:00.000Z" }),
    runCard("run-B", { startedAt: "2026-10-31T12:19:59.000Z" }),
  ]);
  assert.deepEqual(merged.map((item) => item.id), ["u1", "a1", "run-summary-run-A", "u2", "a2", "run-summary-run-B"]);
  const result = associateRunMessages(merged);
  assert.equal(result.find((item) => item.id === "a1").runId, "run-A");
  assert.equal(result.find((item) => item.id === "a2").runId, "run-B");
});
test("消息原顺序不被重排（缺时间戳的消息不跳到最前）", () => {
  const messages = [
    historyMsg("u1", "user", null),
    historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
    historyMsg("u2", "user", "2026-10-31T12:20:00.000Z"),
  ];
  const merged = mergeRunSummaries(messages, [
    runCard("run-B", { startedAt: "2026-10-31T12:19:59.000Z" }),
  ]);
  assert.deepEqual(merged.filter((item) => item.role !== "system").map((item) => item.id), ["u1", "a1", "u2"]);
});

test("失败卡带真实错误：不再只显示“任务执行失败”", () => {
  const [card] = upsertRunSummaryMessage([], {
    runId: "run-auth-failed",
    status: "failed",
    error: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}',
    completion: { status: "failed", source: "inferred", summary: "任务执行失败" },
  });
  assert.match(card.text, /401 invalid api key/);
  assert.match(card.completion.summary, /401 invalid api key/);
  assert.equal(card.error.includes("authentication_error"), true);
});

test("窗口之前已收尾的总结卡不追加到本页末尾；窗口内卡片按 finishedAt 落点", () => {
  const messages = [
    historyMsg("u1", "user", "2026-10-31T12:20:00.000Z"),
    historyMsg("a1", "assistant", "2026-10-31T12:20:05.000Z"),
    historyMsg("u2", "user", "2026-10-31T12:30:00.000Z"),
    historyMsg("a2", "assistant", "2026-10-31T12:30:05.000Z"),
  ];
  const merged = mergeRunSummaries(messages, [
    runCard("run-old", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:10:00.000Z", status: "completed" }),
    runCard("run-mid", { startedAt: "2026-10-31T12:19:50.000Z", finishedAt: "2026-10-31T12:22:00.000Z", status: "failed" }),
    runCard("run-last", { startedAt: "2026-10-31T12:29:50.000Z", finishedAt: "2026-10-31T12:31:00.000Z", status: "completed" }),
  ]);
  assert.deepEqual(
    merged.map((item) => item.id),
    ["u1", "a1", "run-summary-run-mid", "u2", "a2", "run-summary-run-last"],
    "旧卡必须留给更早分页，不能堆到当前页末尾",
  );
  assert.ok(!merged.some((item) => item.id === "run-summary-run-old"));
});

// ---------- 9. 会话恢复一致性回归（S1/S2/S3 验收口径） ----------
console.log("\n▶ 会话恢复一致性回归");
const 恢复卡 = (runId, { startedAt, finishedAt = null, status = "running" }) => ({
  id: `run-summary-${runId}`,
  role: "system",
  summary: true,
  runId,
  runStatus: status,
  startedAt,
  finishedAt,
  createdAt: finishedAt || startedAt,
  text: "总结",
});

test("① 运行中的 run 合并后 assistant.runId 必须存在", () => {
  const messages = [
    historyMsg("u1", "user", "2026-10-31T12:09:10.000Z"),
    historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
    historyMsg("u2", "user", "2026-10-31T12:20:00.000Z"),
    historyMsg("a2", "assistant", "2026-10-31T12:20:05.000Z"),
  ];
  const merged = mergeRunSummaries(messages, [
    恢复卡("run-A", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:09:30.000Z", status: "completed" }),
    恢复卡("run-B", { startedAt: "2026-10-31T12:19:59.000Z" }),
  ]);
  const result = associateRunMessages(merged);
  const assistants = result.filter((item) => item.role === "assistant");
  assert.ok(assistants.length > 0, "本轮必须有 assistant 消息");
  for (const item of assistants) {
    assert.ok(item.runId, `assistant ${item.id} 必须有 runId（缺了就退回旧渲染）`);
  }
});

test("② 不得出现「无 assistant 分组的总结卡」", () => {
  const messages = [
    historyMsg("u1", "user", "2026-10-31T12:09:10.000Z"),
    historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
    historyMsg("u2", "user", "2026-10-31T12:20:00.000Z"),
    historyMsg("a2", "assistant", "2026-10-31T12:20:05.000Z"),
  ];
  const merged = mergeRunSummaries(messages, [
    恢复卡("run-A", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:09:30.000Z", status: "completed" }),
    恢复卡("run-B", { startedAt: "2026-10-31T12:19:59.000Z" }),
  ]);
  const result = associateRunMessages(merged);
  for (const card of result.filter((item) => item.summary)) {
    const grouped = result.filter((item) => item.role === "assistant" && item.runId === card.runId);
    assert.ok(grouped.length > 0, `总结卡 ${card.id} 必须至少关联一条 assistant`);
  }
  // 坏缓存自愈：总结卡落在本轮 assistant 之前时，向后扫描仍要把它找回来。
  const broken = [
    historyMsg("u1", "user", "2026-10-31T12:09:10.000Z"),
    { id: "card", role: "system", summary: true, runId: "run-A", startedAt: "2026-10-31T12:09:00.000Z", createdAt: "2026-10-31T12:09:00.000Z", text: "总结" },
    historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
  ];
  const healed = associateRunMessages(broken);
  assert.equal(healed.find((item) => item.id === "a1").runId, "run-A", "坏缓存必须自愈：总结卡之后的 assistant 也要归到本轮");
});

test("③ 连续切会话两次结果一致（幂等）", () => {
  const messages = [
    historyMsg("u1", "user", "2026-10-31T12:09:10.000Z"),
    historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
    historyMsg("u2", "user", "2026-10-31T12:20:00.000Z"),
    historyMsg("a2", "assistant", "2026-10-31T12:20:05.000Z"),
  ];
  const cards = [
    恢复卡("run-A", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:09:30.000Z", status: "completed" }),
    恢复卡("run-B", { startedAt: "2026-10-31T12:19:59.000Z" }),
  ];
  const first = associateRunMessages(mergeRunSummaries(messages, cards));
  const second = associateRunMessages(mergeRunSummaries(messages, cards));
  assert.deepEqual(second, first, "同样的输入必须得到同样的输出");
  // 归组本身也必须幂等：再跑一次 associateRunMessages 不得改变结果。
  const again = associateRunMessages(first);
  assert.deepEqual(again, first, "associateRunMessages 必须幂等");
});

test("④ 已完成 run 的落点与现状一致（防回退）", () => {
  const messages = [
    historyMsg("u1", "user", "2026-10-31T12:09:10.000Z"),
    historyMsg("a1", "assistant", "2026-10-31T12:09:20.000Z"),
    historyMsg("u2", "user", "2026-10-31T12:20:00.000Z"),
    historyMsg("a2", "assistant", "2026-10-31T12:20:05.000Z"),
  ];
  const merged = mergeRunSummaries(messages, [
    恢复卡("run-A", { startedAt: "2026-10-31T12:09:00.000Z", finishedAt: "2026-10-31T12:09:30.000Z", status: "completed" }),
  ]);
  assert.deepEqual(merged.map((item) => item.id), ["u1", "a1", "run-summary-run-A", "u2", "a2"], "已完成 run 的卡必须落在本轮 assistant 之后");
});

// ---------- 折叠头终态文案 ----------
console.log("\n▶ 折叠头终态（规范 §2.1）");

test("成功轮：已完成 + 用时", () => {
  assert.deepEqual(describeRunFold({ elapsedMs: 548000 }), { state: "ok", label: "已完成 · 用时 9 分 8 秒" });
});

test("有风险轮：blocked / partial 用琥珀态", () => {
  const result = describeRunFold({ risky: true, elapsedMs: 180000 });
  assert.equal(result.state, "warn");
  assert.equal(result.label, "完成（有风险） · 用时 3 分");
});

test("失败轮：红点，仍然折叠", () => {
  assert.deepEqual(describeRunFold({ failed: true, elapsedMs: 124000 }), { state: "err", label: "失败 · 用时 2 分 4 秒" });
});

test("取消轮优先于失败：中断只有一个终态", () => {
  const result = describeRunFold({ interrupted: true, failed: true, risky: true });
  assert.equal(result.state, "cancelled");
  assert.equal(result.label, "已取消");
});

test("没有可用时长时只写终态，不写「用时 0 秒」", () => {
  assert.equal(describeRunFold({ elapsedMs: 0 }).label, "已完成");
  assert.equal(describeRunFold({ elapsedMs: Number.NaN }).label, "已完成");
  assert.equal(describeRunFold().label, "已完成", "空入参应给出安全默认值");
});

test("步数不进 label（由 RunFoldBar 单独渲染）", () => {
  assert.doesNotMatch(describeRunFold({ elapsedMs: 61000 }).label, /步/);
});

console.log("\n▶ 展示时长回退链（历史轮 events 为空）");

test("runSummary 的 durationMs 优先于消息时间", () => {
  const ms = resolveRunElapsedMs({
    runSummary: { durationMs: 61_000 },
    message: { startedAt: at(0), finishedAt: at(90) },
  });
  assert.equal(ms, 61_000);
});

test("runSummary 没有 durationMs 时用它的 startedAt/finishedAt", () => {
  const ms = resolveRunElapsedMs({
    runSummary: { startedAt: at(0), finishedAt: at(90) },
    message: {},
  });
  assert.equal(ms, 90_000);
});

test("消息自带的 startedAt/finishedAt 作为最后兜底", () => {
  const ms = resolveRunElapsedMs({ message: { startedAt: at(0), finishedAt: at(45) } });
  assert.equal(ms, 45_000);
});

test("trace 的起止时间优先于 runSummary", () => {
  const ms = resolveRunElapsedMs({
    trace: { startedAt: at(0), endedAt: at(30) },
    runSummary: { durationMs: 90_000 },
  });
  assert.equal(ms, 30_000);
});

test("实时模式用 now - startedAt；无任何来源返回 0", () => {
  assert.equal(resolveRunElapsedMs({ live: true, now: Date.parse(at(60)), message: { startedAt: at(0) } }), 60_000);
  assert.equal(resolveRunElapsedMs({}), 0);
});

// ---------- 过程按 turn 分组（PRD R3 / DESIGN §6.1，决策 B1） ----------
console.log("\n▶ 过程按 turn 分组");

test("多轮 Run：工具按 toolCallId 归轮，思考/文本归到本轮，轮次变化处插分隔行", () => {
  const items = buildRunTimeline({
    blocks: [
      { type: "thinking", id: "b1", text: "先想清楚" },
      { type: "tool", id: "t1", toolCallId: "c1", name: "read", input: "a.md", done: true, isError: false },
      { type: "thinking", id: "b2", text: "再看第二个" },
      { type: "tool", id: "t2", toolCallId: "c2", name: "read", input: "b.md", done: true, isError: false },
    ],
  });
  const events = [
    ev("turn_started"), ev("tool_start", { toolCallId: "c1", name: "read" }),
    ev("turn_started"), ev("tool_start", { toolCallId: "c2", name: "read" }),
  ];
  const view = assignTimelineTurns(items, events);
  const dividers = view.filter((item) => item.kind === "turn-divider");
  assert.deepEqual(dividers.map((item) => item.turn), [1, 2], "两轮应各有一个分隔行");
  const tools = view.filter((item) => item.kind === "tool");
  assert.equal(tools[0].block.toolCallId, "c1");
  assert.equal(tools[1].block.toolCallId, "c2");
  // 分隔行必须出现在各轮第一个条目之前
  assert.equal(view[0].kind, "turn-divider");
  const secondDividerIndex = view.findIndex((item) => item.kind === "turn-divider" && item.turn === 2);
  assert.ok(secondDividerIndex > 0);
  // 同一轮的思考出现在本轮工具之前，分隔行后应先是该轮的思考/文本，再接工具
  const nextToolAfterDivider = view.slice(secondDividerIndex + 1).find((item) => item.kind === "tool");
  assert.equal(nextToolAfterDivider.block.toolCallId, "c2");
});

test("单轮 Run：不插分隔行，原样返回", () => {
  const items = buildRunTimeline({ blocks: [{ type: "tool", id: "t1", toolCallId: "c1", name: "read", input: "a.md", done: true }] });
  const view = assignTimelineTurns(items, [ev("turn_started"), ev("tool_start", { toolCallId: "c1", name: "read" })]);
  assert.equal(view.length, items.length);
  assert.ok(view.every((item) => item.kind !== "turn-divider"));
});

test("无轮次事件（旧服务端 / 历史回放）：不分组、不报错", () => {
  const items = buildRunTimeline({ blocks: [{ type: "thinking", id: "b1", text: "x" }, { type: "tool", id: "t1", toolCallId: "c1", name: "read", input: "a.md", done: true }] });
  assert.equal(assignTimelineTurns(items, []).length, items.length);
  assert.equal(assignTimelineTurns(items, null).length, items.length);
});

test("工具行缺 toolCallId 时按顺序归入相邻轮次，不丢条目", () => {
  const items = buildRunTimeline({
    blocks: [
      { type: "tool", id: "t1", name: "read", input: "a.md", done: true },
      { type: "tool", id: "t2", name: "read", input: "b.md", done: true },
    ],
  });
  const events = [ev("turn_started"), ev("turn_started")];
  const view = assignTimelineTurns(items, events);
  assert.equal(view.filter((item) => item.kind === "tool").length, 2, "条目数不应变化");
});

console.log(failed ? "\n✗ 有失败用例" : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
