#!/usr/bin/env node
/**
 * 结构化回复折叠回归测试（2026-11-12）。
 *
 * 背景（用户第二次报告「结构化回复又被吞了/被折叠进去了」）：
 *   运行结束后，会话流会把「中间文本」折进「执行过程」，但原实现的判定只看
 *   「这一块是不是终稿块」——只要模型在两次工具调用之间写了 `##` 小节、表格或列表，
 *   而这些内容又不是最后一块，就会被整段折进折叠区，正文里只剩一句过渡语。
 *
 * 修复：把「过程播报」与「结构化结论」分开（`isNarrationText`），
 * 结构化内容（标题 / 表格 / 列表 / 引用 / 代码块 / 长论述）一律不折叠。
 *
 * 用法: node scripts/结构化回复折叠回归测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error?.message || error}`); failed = 1; }
}

const projection = await import(pathToFileURL(path.join(ROOT, "client/src/会话流投影.js")).href);
const chat = read("client/src/components/ChatPanel.jsx");
const styles = read("client/src/styles.css");
const projectionSource = read("client/src/会话流投影.js");

console.log("结构化回复折叠回归测试");

console.log("\n▶ isNarrationText：结构化结论不得被判为过程播报");

const structuredSamples = [
  ["ATX 标题小节", "## 关键结果\n\n已完成三项改造。"],
  ["多级标题", "### 1. 现状\n\n现状说明。\n\n### 2. 建议\n\n建议说明。"],
  ["Markdown 表格", "| 指标 | 目标 |\n| --- | --- |\n| GDP | 8% |"],
  ["无序列表", "- 第一条结论\n- 第二条结论"],
  ["有序列表", "1. 第一步\n2. 第二步"],
  ["引用块", "> 依据《城市综合交通体系规划标准》第 3.2 条"],
  ["代码块", "```js\nconst a = 1;\n```"],
  ["单段长论述（>240 字）", "这是一段实质回答。".repeat(30)],
  ["多段论述（>200 字）", "第一段说明。\n\n第二段解释。\n\n" + "补充论述。".repeat(60)],
];

for (const [label, text] of structuredSamples) {
  test(`结构化内容不折叠：${label}`, () => {
    assert.equal(projection.isNarrationText(text), false, `「${label}」被判成过程播报，会被折进执行过程`);
  });
}

console.log("\n▶ isNarrationText：真正的过程播报仍可折叠");

const narrationSamples = [
  ["一句话过渡", "好的，我先看一下工作区里的文件。"],
  ["进度说明", "正在读取报表数据…"],
  ["很短的两行说明", "已找到目标文件。\n现在开始处理。"],
  ["空文本", ""],
  ["纯空白", "   \n  \n"],
];

for (const [label, text] of narrationSamples) {
  test(`过程播报仍折叠：${label}`, () => {
    assert.equal(projection.isNarrationText(text), true, `「${label}」应可折叠`);
  });
}

console.log("\n▶ ChatPanel 折叠判定必须同时看「是否终稿」与「是否过程播报」");

test("折叠条件接入 isNarrationText", () => {
  assert.match(chat, /import \{[^}]*isNarrationText[^}]*\} from "\.\.\/会话流投影\.js"/, "ChatPanel 未引入 isNarrationText");
  const start = chat.indexOf("const foldIntermediateText");
  assert.ok(start > 0, "缺少 foldIntermediateText");
  const block = chat.slice(start, chat.indexOf("renderSegments.push({ kind: \"block\"", start));
  assert.match(block, /blockIndex !== finalAnswerBlockIndex/, "折叠判定应仍排除终稿块（避免正文重复）");
  assert.match(block, /isNarrationText\(block\.text\)/, "折叠判定未按「是否过程播报」过滤");
});

test("折叠判定不再只依据「非终稿块」", () => {
  const start = chat.indexOf("const foldIntermediateText");
  const block = chat.slice(start, chat.indexOf("renderSegments.push({ kind: \"block\"", start));
  // 旧写法：&& blockIndex !== finalAnswerBlockIndex;\n 之后直接结束（没有 isNarrationText 多条件）
  assert.doesNotMatch(
    block,
    /const isIntermediateText = foldIntermediateText\s*&& block\?\.type === "text"\s*&& blockIndex !== finalAnswerBlockIndex;\s*\n/,
    "仍是旧的两条件判定：结构化小节会被吞",
  );
});

console.log("\n▶ 时间流（run 消息）路径：结构化小节必须提到折叠体外");

test("时间流按「过程 / 收尾结论小节」二分渲染", () => {
  assert.match(chat, /const \{ foldTimelineItems, liftedTimelineItems \} = useMemo/, "缺少时间流二分");
  assert.match(chat, /splitRunTimelineSections\(runTimelineView, \{ live: isTaskLive \}\)/, "二分未接入 splitRunTimelineSections 纯函数");
  assert.match(projectionSource, /item\?\.kind === "text"\s*&& index === lastConclusionIndex\s*&& index > lastProcessIndex/, "二分未按「最后一段结论 + 收尾位置」判定");
  assert.match(chat, /foldTimelineItems\.map\(renderTimelineItem\)/, "折叠体内应只渲染过程条目");
  assert.match(chat, /liftedTimelineItems\.map\(renderTimelineItem\)/, "结构化小节必须在折叠体外渲染");
  assert.match(chat, /className="tl-lifted-sections"/, "缺少折叠体外容器");
  assert.match(styles, /\.tl-lifted-sections \{/, "缺少折叠体外容器样式");
});

console.log("\n▶ splitRunTimelineSections：运行中不外提、收尾只外提结尾结论小节（2026-11-15-002）");

const { splitRunTimelineSections } = projection;
// 结构化判定必须命中 isNarrationText=false：ATX 标题 / 列表 / 表格 / >240 字长段任选其一。
const structuredText = (tag) => ({ kind: "text", id: `t-${tag}`, text: `## ${tag}\n\n- 要点一\n- 要点二` });
const narrationText = (tag) => ({ kind: "text", id: `n-${tag}`, text: `继续处理 ${tag}。` });
const toolItem = (tag) => ({ kind: "tool", id: `tool-${tag}`, block: { name: "bash", id: `tool-${tag}` } });
const thinkingItem = (tag) => ({ kind: "thinking", id: `th-${tag}`, text: `思考 ${tag}` });

test("运行中（live）：整条时间流直铺，任何条目都不外提", () => {
  const items = [thinkingItem("a"), structuredText("中段"), toolItem("1"), thinkingItem("b"), structuredText("结尾")];
  const { foldTimelineItems, liftedTimelineItems } = splitRunTimelineSections(items, { live: true });
  assert.equal(liftedTimelineItems.length, 0, "运行中不得外提（否则过程文本立刻沉到消息底部）");
  assert.deepEqual(foldTimelineItems.map((item) => item.id), items.map((item) => item.id), "运行中必须保持完整原顺序");
});

test("收尾后：最后一次过程条目之前的结构化文本留在过程里（原位不丢）", () => {
  const mid = structuredText("中段");
  const items = [thinkingItem("a"), mid, toolItem("1"), thinkingItem("b"), toolItem("2")];
  const { foldTimelineItems, liftedTimelineItems } = splitRunTimelineSections(items);
  assert.equal(liftedTimelineItems.length, 0, "中段结构化文本不应外提");
  assert.ok(foldTimelineItems.some((item) => item.id === mid.id), "中段结构化文本必须留在 fold（不能丢）");
  assert.deepEqual(foldTimelineItems.map((item) => item.id), items.map((item) => item.id), "fold 必须保持原顺序");
});

test("收尾后：只外提最后一段结论小节，中间结构化小结留在过程里", () => {
  const conclusionA = structuredText("结论A");
  const conclusionB = structuredText("结论B");
  const narration = narrationText("收尾");
  const items = [toolItem("1"), conclusionA, narration, conclusionB];
  const { foldTimelineItems, liftedTimelineItems } = splitRunTimelineSections(items);
  // 2026-11-18：中间小结若也外提，折叠体外会同时出现两段结论（用户实测"两份结论"）。
  assert.deepEqual(liftedTimelineItems.map((item) => item.id), [conclusionB.id], "只允许最后一段结论外提");
  assert.ok(foldTimelineItems.some((item) => item.id === conclusionA.id), "较早的结构化小结留在过程里");
  assert.ok(foldTimelineItems.some((item) => item.id === narration.id), "结尾的播报文本仍属过程，留在 fold");
});

test("收尾后：无过程条目时（纯文本回合）结构化文本仍外提", () => {
  const only = structuredText("整篇结论");
  const { foldTimelineItems, liftedTimelineItems } = splitRunTimelineSections([thinkingItem("a"), only]);
  assert.deepEqual(liftedTimelineItems.map((item) => item.id), [only.id]);
  assert.deepEqual(foldTimelineItems.map((item) => item.id), ["th-a"]);
});

test("失败/取消轮仍保持默认折叠（不能靠默认展开绕过规范）", () => {
  // 2026-11-19（用户裁定）：结束后一律默认折叠——《会话流前端规范》§2 与 ADR 0014 §4.2
  // 是硬约束，用户偏好不得绕过；「活动显示」只控制过程区常显/隐藏，不再提供「默认展开」。
  assert.match(chat, /const flowDefaultExpanded = false/, "折叠默认态必须固定收起，不得跟随用户设置");
  assert.doesNotMatch(chat, /defaultOpen=\{runFold\.state/, "不得按终态决定默认展开");
  const appearance = read("client/src/界面外观.js");
  assert.doesNotMatch(appearance, /id: "expanded"/, "「默认展开」选项不得再出现在外观设置里");
  assert.match(appearance, /RETIRED_ACTIVITY_IDS = new Set\(\["expanded"\]\)/, "历史 expanded 取值必须一次性迁移回落");
});

console.log("\n▶ 终稿拆分不得丢失任何小节（2026-11-12 第二个吞点）");

const { splitCompletionSummary } = projection;

test("「做了什么」小节保留在 detail 中（渲染层只用 conclusion+detail）", () => {
  const source = [
    "开场一句话。",
    "",
    "## 做了什么",
    "",
    "1. 改了解析逻辑",
    "2. 补了回归测试",
    "",
    "## 下一步",
    "",
    "等你确认。",
  ].join("\n");
  const result = splitCompletionSummary("", source);
  // 渲染出口：summaryBody = conclusion + detail
  const rendered = [result.conclusion, result.detail].filter(Boolean).join("\n\n");
  assert.ok(rendered.includes("做了什么"), "「做了什么」标题不得从渲染正文消失");
  assert.ok(rendered.includes("改了解析逻辑"), "「做了什么」正文不得从渲染正文消失");
  assert.ok(rendered.includes("等你确认"), "其余小节也要保留");
  assert.ok(rendered.includes("开场一句话。"), "开场段不得丢失");
});

test("多小节终稿：所有标题都必须在渲染正文里出现", () => {
  const source = [
    "## 结论",
    "整体可用。",
    "",
    "## 做了什么",
    "补齐了三个缺口。",
    "",
    "## 产物",
    "- 报告.docx",
    "",
    "## 已知限制",
    "未做实地核验。",
  ].join("\n");
  const result = splitCompletionSummary("", source);
  const rendered = [result.conclusion, result.detail].filter(Boolean).join("\n\n");
  for (const heading of ["做了什么", "产物", "已知限制"]) {
    assert.ok(rendered.includes(heading), `小节「${heading}」在渲染正文里消失了`);
  }
  // 结论节的取舍：单段结论整节移除标题、正文进 conclusion，不重复也不丢失。
  assert.ok(rendered.includes("整体可用。"), "结论正文必须可见");
});

test("ChatPanel 只渲染 conclusion + detail（what 不单独渲染，避免重复）", () => {
  assert.match(chat, /\[summaryParts\.conclusion, summaryParts\.detail\]\.filter\(Boolean\)\.join\("\\n\\n"\)/, "总结正文应只拼 conclusion + detail");
  assert.doesNotMatch(chat, /summaryParts\.what/, "what 不应单独渲染（该内容已在 detail 里）");
});

if (failed) {
  console.error("结构化回复折叠回归：未通过");
  process.exit(1);
}
console.log("结构化回复折叠回归：通过");
