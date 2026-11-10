/**
 * 结论渲染顺序回归（test:chat-summary-order，计划 007 块 A）。
 *
 * 背景：`splitCompletionSummary` 曾把「有分节但没有结论节」的终稿首段提升为结论，
 * 渲染层再按「结论 + 详细展开」拼接，导致首段被搬到开场白与 `##` 标题之前
 * （2026-11-10 实测：“一是…”跑到“## ‘没更新’最可能的原因”前面）。
 *
 * 这里锁定四条口径：
 *  1. 有内容词小标题、无「结论」节 → 顺序与终稿完全一致，conclusion 为空；
 *  2. 有「结论」节 → 结论取该节首段，detail 不重复该段；
 *  3. 无任何标题的纯文本 → 保持“首段为结语”的旧行为，顺序不变；
 *  4. 「做了什么」节仍被提取并从 detail 移除，且不影响其余顺序。
 *
 * 运行：node scripts/会话结论渲染顺序测试.mjs
 */
import assert from "node:assert/strict";
import { splitCompletionSummary } from "../client/src/会话流投影.js";

const passed = [];
function check(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

/** 去掉空行差异，便于断言顺序。 */
const normalize = (text) => String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n");

console.log("▶ 结论渲染顺序");

const contentHeadings = [
  "刚才那一轮我误输出成半截工具标记，没有真正执行，所以你现在看不到新东西——抱歉。文件本身是在的：`汇报材料/报告.docx`。",
  "",
  "## “没更新”最可能的原因",
  "",
  "一是**前端没有刷新或没有展示子目录**。",
  "",
  "二是**你可能在看旧文件**。",
  "",
  "## 怎么确认文件是对的",
  "",
  "用 Word/WPS 打开该 docx 核对标题。",
].join("\n");

check("内容词小标题、无结论节：conclusion 为空且 detail 顺序与终稿一致", () => {
  const result = splitCompletionSummary("", contentHeadings);
  assert.equal(result.conclusion, "", `conclusion 应为空，实际：${result.conclusion}`);
  assert.equal(result.detail, normalize(contentHeadings).trim(), "detail 应与终稿顺序完全一致");
  // 首段仍在最前，标题仍在正文之后
  assert.ok(result.detail.startsWith("刚才那一轮"), "开场白必须保持在最前");
  assert.ok(
    result.detail.indexOf("## “没更新”最可能的原因") < result.detail.indexOf("一是**前端没有刷新"),
    "标题必须出现在「一是…」之前",
  );
});

check("内容词小标题：拼接后（结论+detail）不产生段落前移", () => {
  const result = splitCompletionSummary("", contentHeadings);
  const rendered = [result.conclusion, result.detail].filter(Boolean).join("\n\n");
  assert.ok(rendered.startsWith("刚才那一轮"), "渲染正文必须从开场白开始");
  assert.ok(
    rendered.indexOf("## “没更新”最可能的原因") < rendered.indexOf("一是**前端没有刷新"),
    "渲染后标题仍须在「一是…」之前",
  );
});

const withConclusion = [
  "总述一句。",
  "",
  "## 结论",
  "",
  "规划编制已完成送审稿。",
  "",
  "## 详情",
  "",
  "细节说明。",
].join("\n");

check("有结论节：结论取该节首段，detail 不重复", () => {
  const result = splitCompletionSummary("", withConclusion);
  assert.equal(result.conclusion, "规划编制已完成送审稿。");
  assert.ok(!result.detail.includes("规划编制已完成送审稿。"), "detail 不应重复结论首段");
  assert.ok(result.detail.includes("## 详情"), "detail 应保留其余分节");
  assert.ok(result.detail.startsWith("总述一句。"), "总述段仍应在 detail 最前");
});

check("有结论节且多段：只提首段，后续段落仍在 detail", () => {
  const source = ["## 结论", "", "第一段结论。", "", "第二段结论。", "", "## 其他", "", "其他内容。"].join("\n");
  const result = splitCompletionSummary("", source);
  assert.equal(result.conclusion, "第一段结论。");
  assert.ok(result.detail.includes("第二段结论。"), "多段结论的第 2 段不能丢");
  assert.ok(result.detail.includes("其他内容。"), "其余分节不能丢");
});

check("无标题纯文本：保持首段为结语、顺序不变", () => {
  const source = "第一段。\n\n第二段。\n\n第三段。";
  const result = splitCompletionSummary("", source);
  assert.equal(result.conclusion, "第一段。");
  assert.equal(result.detail, "第二段。\n\n第三段。");
  assert.equal([result.conclusion, result.detail].filter(Boolean).join("\n\n"), source);
});

check("做了什么节被提取且不影响其余顺序", () => {
  const source = [
    "开场。",
    "",
    "## 做了什么",
    "",
    "改了渲染顺序。",
    "",
    "## 下一步",
    "",
    "等确认。",
  ].join("\n");
  const result = splitCompletionSummary("", source);
  assert.equal(result.what, "改了渲染顺序。");
  assert.equal(result.conclusion, "");
  assert.ok(!result.detail.includes("改了渲染顺序。"), "what 段不应在 detail 重复");
  assert.ok(result.detail.startsWith("开场。"));
  assert.ok(result.detail.indexOf("## 下一步") > result.detail.indexOf("开场。"));
});

check("空输入：三个字段都是空串，不编造", () => {
  assert.deepEqual(splitCompletionSummary("", ""), { what: "", conclusion: "", detail: "" });
  assert.deepEqual(splitCompletionSummary(undefined, undefined), { what: "", conclusion: "", detail: "" });
});

check("summary 优先于 finalText（完成摘要来源）", () => {
  const result = splitCompletionSummary("## 结论\n\n来自摘要。", "来自终稿。");
  assert.equal(result.conclusion, "来自摘要。");
});

if (!process.exitCode) {
  console.log(`\n结论渲染顺序回归：通过（${passed.length} 项）`);
}
