#!/usr/bin/env node
/**
 * 结论 Markdown 结构纠偏测试（2026-11-09）
 *
 * 背景事故：模型把标题写成 `##结论`（井号后无空格），CommonMark 当普通段落渲染，
 * 用户看到字面量 `##结论` + 整篇层级塌掉；同期 h3 与正文同为 14px，只靠字重区分，
 * 分节读起来像"加粗段落"。
 *
 * 本测试覆盖：
 *   1. normalizeAtxHeadings：无空格标题补空格、代码块内不动、正常标题不动、超 6 级不动；
 *   2. 渲染接线：MarkdownBody 必须在解析前调用规范化；
 *   3. 标题排版：h1/h2 16px、h3 14px、层级间距递减（不能与段距同级）；
 *   4. 提示词：要求 `## 标题` 带空格、编号分节与标题对内容。
 *
 * 用法：node scripts/Markdown结构纠偏测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { normalizeAtxHeadings, numberTopLevelSections, toChineseNumber } = await import("../client/src/markdown规范化.js");

const md = fs.readFileSync(path.join(ROOT, "client/src/components/MarkdownBody.jsx"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "client/src/styles.css"), "utf8");
const agent = fs.readFileSync(path.join(ROOT, "server/agent.mjs"), "utf8");
const chat = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log("▶ 无空格标题纠偏");

test("行首 `##结论` / `###依据` 补空格", () => {
  assert.equal(normalizeAtxHeadings("##结论"), "## 结论");
  assert.equal(normalizeAtxHeadings("###依据"), "### 依据");
  assert.equal(normalizeAtxHeadings("正文\n##小结\n正文"), "正文\n## 小结\n正文");
});

test("正常标题、正文井号、超过 6 级不动", () => {
  assert.equal(normalizeAtxHeadings("## 结论"), "## 结论");
  assert.equal(normalizeAtxHeadings("C# 与 F#"), "C# 与 F#");
  assert.equal(normalizeAtxHeadings("#######七级"), "#######七级");
  assert.equal(normalizeAtxHeadings("行内 `##结论` 不动"), "行内 `##结论` 不动");
});

test("围栏代码块内保持原样（含 ``` 与 ~~~）", () => {
  const source = ["```bash", "##结论 这是代码", "```", "~~~", "##也不是标题", "~~~", "##真的标题"].join("\n");
  const out = normalizeAtxHeadings(source);
  assert.match(out, /##结论 这是代码/);
  assert.match(out, /##也不是标题/);
  assert.match(out, /## 真的标题/);
});

test("无井号文本原样返回（不引入改动）", () => {
  const text = "普通段落\n- 列表项\n1. 有序项";
  assert.equal(normalizeAtxHeadings(text), text);
});

console.log("▶ 渲染接线");

test("MarkdownBody 在解析前调用规范化（不是只在某条分支）", () => {
  assert.match(md, /import \{ normalizeAtxHeadings, numberTopLevelSections \} from "\.\.\/markdown规范化\.js";/);
  assert.match(md, /const normalized = normalizeAtxHeadings\(children\);/, "渲染前必须先纠偏标题");
  assert.match(md, /const source = numberSections \? numberTopLevelSections\(normalized\) : normalized;/, "结论区在纠偏之后编号");
});

console.log("▶ 标题层级排版");

test("h1/h2 为 16px、h3 为 14px（规范 §4 三档字号）", () => {
  assert.match(css, /\.markdown-body h1 \{ font-size: 16px; \}/);
  assert.match(css, /\.markdown-body h2 \{ font-size: 16px; \}/);
  assert.match(css, /\.markdown-body h3, \.markdown-body h4, \.markdown-body h5, \.markdown-body h6 \{ font-size: 14px; \}/);
});

test("标题上间距按层级递减，且明显大于段距", () => {
  const start = css.indexOf(".markdown-body h1, .markdown-body h2");
  const block = css.slice(start, css.indexOf("}", start) + 1);
  assert.match(block, /margin: 20px 0 8px;/, "h1/h2 上间距 20px");
  assert.match(css, /\.markdown-body h3, \.markdown-body h4 \{ margin: 16px 0 4px; \}/, "h3/h4 上间距 16px、下间距 4px");
  assert.match(css, /\.markdown-body > :first-child \{ margin-top: 0; \}/, "首个标题不吃容器顶部留白");
});

console.log("▶ 二级标题自动编号（渲染层确定性兜底）");

test("两个以上无编号 h2 自动补「一、二、三」", () => {
  const source = ["## 结论", "正文", "## 依据", "正文", "## 风险", "正文"].join("\n");
  const out = numberTopLevelSections(source);
  assert.match(out, /^## 一、结论$/m);
  assert.match(out, /^## 二、依据$/m);
  assert.match(out, /^## 三、风险$/m);
});

test("单节、已自带编号、代码块内都不动", () => {
  assert.equal(numberTopLevelSections("## 只有一个"), "## 只有一个");
  const numbered = "## 一、结论\n## 二、依据";
  assert.equal(numberTopLevelSections(numbered), numbered);
  const arabic = "## 1. 结论\n## 2. 依据";
  assert.equal(numberTopLevelSections(arabic), arabic);
  const fenced = "```md\n## 代码里的标题\n## 第二个\n```\n## 真标题\n## 另一个";
  const out = numberTopLevelSections(fenced);
  assert.match(out, /## 代码里的标题/);
  assert.match(out, /^## 一、真标题$/m);
});

test("先纠偏无空格标题再编号（顺序不能反）", () => {
  const out = numberTopLevelSections(normalizeAtxHeadings("##结论\n正文\n##依据"));
  assert.match(out, /^## 一、结论$/m);
  assert.match(out, /^## 二、依据$/m);
});

test("中文序号转换覆盖 1/10/11/23", () => {
  assert.equal(toChineseNumber(1), "一");
  assert.equal(toChineseNumber(10), "十");
  assert.equal(toChineseNumber(11), "十一");
  assert.equal(toChineseNumber(23), "二十三");
});

test("只在结论区启用：SafeMarkdown 透传、最终答复/兜底总结开启，阶段小结不开启", () => {
  assert.match(chat, /function SafeMarkdown\(\{ text, onOpenFile, artifacts, numberSections = false \}\)/);
  assert.match(chat, /<SafeMarkdown text=\{clampAnswer\(authoritativeFinalText\)\}[^>]*numberSections \/>/);
  assert.match(chat, /<SafeMarkdown text=\{fallbackSummary\}[^>]*numberSections \/>/);
  assert.doesNotMatch(chat, /<SafeMarkdown text=\{item\.text\}[^>]*numberSections/, "时间流阶段小结不编号");
  // 历史/已完成轮次的结论走 SummaryBlock（.sum-body），同样必须编号——
  // 这是用户实际看到的"结论"路径（2026-11-09 实机确认 finals=0 但 sum-body 有 h2）。
  const summaryBlock = fs.readFileSync(path.join(ROOT, "client/src/components/会话流/SummaryBlock.jsx"), "utf8");
  assert.match(summaryBlock, /<MarkdownBody onOpenFile=\{onOpenFile\} artifacts=\{artifacts\} numberSections>/, "SummaryBlock 必须开启编号");
});

console.log("▶ 提示词约束");

test("要求标题带空格、编号分节、标题对内容", () => {
  assert.match(agent, /Markdown 硬约束/);
  assert.match(agent, /标题必须写成 `## 标题`（井号后有空格）/);
  assert.match(agent, /不会渲染成标题/);
  assert.match(agent, /编号分节/);
  assert.match(agent, /标题与内容对不上比没有标题更糟/);
});

if (failed) {
  console.error("\n✗ Markdown 结构纠偏存在失败项\n");
  process.exit(1);
}
console.log("\n✓ Markdown 结构纠偏全部通过\n");
