#!/usr/bin/env node
/**
 * Markdown 预览增强测试（2026-11-06，020 计划 P1-3/P1-4）
 *
 * 项目没有 DOM 测试环境（无 jsdom/playwright），这里做源码/契约级断言：
 *   1. 代码块有语言标签 + 复制按钮（对齐 DSH 的代码条）；
 *   2. 图片可点击放大（灯箱），Esc/遮罩可关闭；
 *   3. 新增类名走设计令牌（不新增硬编码色值）；
 *   4. 既有能力不回归：行内产物文件条、本地文件链接仍走 onOpenFile。
 *
 * 用法：node scripts/Markdown预览增强测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const md = fs.readFileSync(path.join(ROOT, "client/src/components/MarkdownBody.jsx"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "client/src/styles.css"), "utf8");
const chat = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");
const clean = fs.readFileSync(path.join(ROOT, "client/src/工具标签清洗.js"), "utf8");
const prompt = fs.readFileSync(path.join(ROOT, "server/agent.mjs"), "utf8");
const proj = fs.readFileSync(path.join(ROOT, "client/src/会话流投影.js"), "utf8");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log("▶ 代码块");

test("代码块有语言标签与复制按钮", () => {
  assert.match(md, /function MdCodeBlock/);
  assert.match(md, /className="md-code-lang"/);
  assert.match(md, /className="md-code-copy"/);
  assert.match(md, /navigator\.clipboard\.writeText/);
  assert.match(md, /language-\(\[\\w-\]\+\)/, "应从 className 解析语言");
});

test("复制失败有可读反馈，不静默", () => {
  assert.match(md, /复制失败/);
});

console.log("▶ 图片灯箱");

test("图片渲染为可点击按钮并打开灯箱", () => {
  assert.match(md, /className="md-img-btn"/);
  assert.match(md, /setLightbox\(\{ src, alt/);
  assert.match(md, /className="md-lightbox"/);
  assert.match(md, /aria-modal="true"/);
});

test("Esc 与遮罩可关闭灯箱", () => {
  assert.match(md, /event\.key === "Escape"/);
  assert.match(md, /onClick=\{\(\) => setLightbox\(null\)\}/);
});

console.log("▶ 令牌与既有能力");

test("新样式不引入硬编码色值", () => {
  const block = css.slice(css.indexOf(".md-img-btn"), css.indexOf(".md-code-copy:hover"));
  assert.ok(block.length > 200, "未找到新增样式块");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "新增样式不得写死 hex");
  assert.match(block, /var\(--border\)/);
});

test("行内产物文件条与本地文件链接仍走 onOpenFile（不回归）", () => {
  assert.match(md, /<ArtifactFileChip/);
  assert.match(md, /onOpenFile\?\.\(item\.path \|\| path\)/);
  assert.match(md, /#artifact:/);
});

console.log("▶ 结论骨架与清洗接线");

test("所有模式的结论骨架一致（Chat 与其他模式同一套）", () => {
  assert.match(prompt, /## 结论/);
  assert.match(prompt, /## 关键结果/);
  assert.match(prompt, /## 风险与未完成/);
  assert.match(prompt, /推荐骨架/);
  assert.doesNotMatch(prompt, /不要输出固定的 Markdown 分段模板/, "不得再禁止结构化输出");
});

test("终稿清洗接入渲染路径", () => {
  assert.match(clean, /export function stripAnswerPrefill/);
  assert.match(chat, /stripAnswerPrefill\(stripToolMarkup\(authoritativeFinalTextRaw\)\)/);
});

test("多段结论不再被整节删除", () => {
  assert.match(proj, /多段结论：只移除首段文本/);
  assert.match(proj, /paragraphs\.length <= 1/);
});

console.log("▶ 本轮改动卡（P2-1）");

test("结论旁渲染改动卡，diff 走右侧改动面板", () => {
  assert.match(chat, /import RunChangesCard from "\.\/会话流\/RunChangesCard\.jsx"/);
  assert.match(chat, /<RunChangesCard/);
  assert.match(chat, /onOpenChanges=\{onOpenRunChanges \? \(\) => onOpenRunChanges\(runSummary\?\.runId \|\| m\.runId\)/);
  assert.match(chat, /const runChanges = useMemo\(/, "改动数据应来自 Run 展示投影");
});

test("改动卡：过滤内部角色、最多 6 行、超出提示、类型中文标签", () => {
  const card = fs.readFileSync(path.join(ROOT, "client/src/components/会话流/RunChangesCard.jsx"), "utf8");
  assert.match(card, /item\?\.path/, "只展示有路径的改动");
  assert.match(card, /slice\(0, 6\)/);
  assert.match(card, /还有 \$\{hidden\} 个文件/);
  for (const label of ["新增", "删除", "重命名", "修改"]) assert.match(card, new RegExp(label));
  assert.match(css, /\.rc-card \{[^}]*?border: 1px solid var\(--border\)/);
  assert.match(css, /\.rc-status\.is-added \{ color: var\(--success\); \}/);
});

test("改动卡样式不引入硬编码色值", () => {
  const block = css.slice(css.indexOf(".rc-card"), css.indexOf(".rc-more") + 120);
  assert.ok(block.length > 200, "未找到改动卡样式块");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
});

if (failed) {
  console.error("\n✗ Markdown 预览增强存在失败项\n");
  process.exit(1);
}
console.log("\n✓ Markdown 预览增强全部通过\n");
