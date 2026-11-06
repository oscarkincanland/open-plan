#!/usr/bin/env node
/**
 * 标注定位契约测试（2026-11-06）。
 *
 * 背景：html/MD 标注（划词高亮、选区批注）此前只保存 `text`，恢复时用
 * `indexOf` 取文档里**第一个**匹配——同一句话出现两次就静态错位；
 * 选区跨文本节点时 `surroundContents` 抛错，标注静默丢失。
 * 现在改为「文本 + 前后文各 30 字 + 出现序号」三要素锚点，并按锚点择优恢复。
 *
 * 本测试为静态契约守卫（文档在 iframe 内，纯 Node 无 DOM 环境无法真实驱动）。
 * 用法: node scripts/标注定位测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src = fs.readFileSync(path.join(ROOT, "client/src/components/DocViewer.jsx"), "utf8");
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

console.log("\n▶ 锚点模型");
test("保存锚点三要素：文本 + 前文 + 后文 + 出现序号", () => {
  assert.match(src, /const ANNO_CONTEXT_CHARS = 30/, "上下文窗口应为 30 字");
  assert.match(src, /function buildAnnotationAnchor/, "应有锚点构造器");
  assert.match(src, /before = full\.slice\(/, "应记录前文");
  assert.match(src, /after = full\.slice\(/, "应记录后文");
  assert.match(src, /const occurrence = full\.slice\(0, abs\)\.split\(text\)\.length - 1/, "出现序号应按前文中的匹配次数计算");
});

test("锚点在「选区还在时」采集（不在保存时才采）", () => {
  assert.match(src, /anchor: buildAnnotationAnchor\(innerDoc\.body, range\)/, "mouseup 时应计算锚点并随工具栏暂存");
  assert.match(src, /setAnnoInput\(\{ mode: "comment", text: annoToolbar\.text, anchor: annoToolbar\.anchor/, "进入批注输入态应带上锚点");
  assert.match(src, /\.\.\.\(annoToolbar\.anchor \|\| \{\}\)/, "高亮保存应写入锚点");
  assert.match(src, /\.\.\.\(annoInput\.anchor \|\| \{\}\)/, "批注保存应写入锚点");
});

console.log("\n▶ 恢复策略");
test("恢复按锚点择优，而不是取首个匹配", () => {
  assert.match(src, /function findAllTextMatches/, "应能枚举全部候选匹配");
  assert.match(src, /function wrapAnnotatedText/, "应有按锚点恢复的函数");
  assert.match(src, /anno\.occurrence >= 0 && anno\.occurrence < matches\.length/, "应优先使用出现序号");
  assert.match(src, /before\.endsWith\(anno\.before\)/, "应校验前文上下文");
  assert.match(src, /after\.startsWith\(anno\.after\)/, "应校验后文上下文");
  assert.match(src, /return wrapTextMatch\(matches\[0\], anno\.type, anno\.note\)/, "无锚点旧数据应保留首个匹配的向后兼容");
  assert.match(src, /wrapAnnotatedText\(rootDoc\.body, a\)/, "恢复入口应走新逻辑");
});

test("旧的首匹配实现已移除（避免两套逻辑并存）", () => {
  assert.doesNotMatch(src, /function wrapFirstTextMatch/, "不应保留旧的 wrapFirstTextMatch");
});

test("跨节点选区不再静默丢失", () => {
  assert.match(src, /const length = String\(match\.text \|\| ""\)\.length;/, "包裹前应显式校验匹配长度");
  const wrapFn = src.slice(src.indexOf("function wrapTextMatch"), src.indexOf("function wrapTextMatch") + 900);
  assert.match(wrapFn, /catch \{/, "包裹应捕获异常");
  assert.match(wrapFn, /return false;/, "包裹失败应显式返回 false");
  // 服务端/前端都不再把「包裹失败」当成成功
  assert.match(src, /if \(!matches\.length\) return false/, "无候选应显式失败");
});

console.log("\n▶ 持久化字段");
test("标注保存结构含锚点字段（旧数据仍可读）", () => {
  assert.match(src, /type: "highlight"[\s\S]{0,220}?created: Date\.now\(\)/, "高亮结构完整");
  assert.match(src, /type: "comment"[\s\S]{0,260}?created: Date\.now\(\)/, "批注结构完整");
  // 旧数据没有 occurrence/before/after，恢复逻辑必须容忍
  assert.match(src, /typeof anno\.occurrence === "number"/, "缺失序号时应走兜底");
});

console.log(failed ? "\n标注定位测试：失败" : "\n标注定位测试：全部通过");
process.exit(failed ? 1 : 0);
