#!/usr/bin/env node
/**
 * P1 对话区布局契约测试：
 * 消息、执行过程卡、任务卡、输入区共用同一内容列（--chat-content-w），
 * 且旧的重复/冲突规则已删除；正文与代码字号符合 DESIGN。
 *
 * 用法: node scripts/对话区布局测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(ROOT, "client/src/styles.css"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

console.log("\n▶ 对话内容列令牌");

test("内容列与左右留白使用统一令牌", () => {
  assert.match(css, /--chat-content-w:\s*760px;/);
  assert.match(css, /--chat-gutter:\s*clamp\(16px,\s*4vw,\s*40px\);/);
});

test("消息列与输入区共用 --chat-content-w", () => {
  assert.match(css, /\.center-chat-slot \.msg-main \{ width: 100%; max-width: var\(--chat-content-w\); \}/);
  assert.match(css, /\.center-chat-slot \.chat-body > \.msg,[\s\S]{0,160}?max-width: var\(--chat-content-w\)/);
  assert.match(css, /\.center-chat-slot \.chat-compose \{\s*width: min\(100% - 2 \* var\(--chat-gutter\), var\(--chat-content-w\)\);/);
  assert.match(css, /\.center-chat-slot \.chat-input \{\s*width: min\(100% - 2 \* var\(--chat-gutter\), var\(--chat-content-w\)\);/);
});

test("对话区 padding 只由 --chat-gutter 控制", () => {
  assert.match(css, /\.center-chat-slot \.chat-body \{\s*padding: 28px var\(--chat-gutter\) 20px;/);
  assert.doesNotMatch(css, /\.center-chat-slot \.chat-body \{ padding: 34px clamp\(28px, 7vw, 104px\) 28px; \}/);
});

test("旧的 820/880 消息列与 104px 留白不再残留", () => {
  assert.doesNotMatch(css, /\.center-chat-slot \.msg-main \{ min-width: 0; max-width: 820px; \}/);  assert.doesNotMatch(css, /\.center-chat-slot \.msg-main \{ width: min\(100%, 880px\); max-width: 880px; \}/);
  assert.doesNotMatch(css, /max-width: 880px;\s*margin-left: auto;\s*margin-right: auto;/);
});

test("输入区补偿滚动条预留，左右边缘与消息列对齐", () => {
  assert.match(css, /\.center-chat-slot \.chat-compose \{[\s\S]{0,400}?transform: translateX\(-4px\);/);
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.center-chat-slot \.chat-compose \{ transform: none; \}/);
});

console.log("\n▶ 字号与可读性");

test("助手正文 14/1.75，用户 13/1.6，代码 12.5", () => {
  assert.match(css, /\.center-chat-slot \.flow-markdown,[\s\S]{0,220}?font-size: 14px; line-height: 1\.75;/);
  assert.match(css, /\.center-chat-slot \.msg\.user \.flow-markdown,[\s\S]{0,220}?font-size: 13px; line-height: 1\.6;/);
  assert.match(css, /\.center-chat-slot \.markdown-body pre,\s*\n\.center-chat-slot \.markdown-body code \{ font-size: 12\.5px; line-height: 1\.65; \}/);
});

test("任务卡与输入区同宽", () => {
  assert.match(css, /\.center-chat-slot \.chat-compose > \.task-card \{\s*width: 100%;\s*max-width: var\(--chat-content-w\);/);
});

console.log(failed ? "\n✗ 对话区布局测试存在失败" : "\n✓ 对话区布局测试全部通过");
process.exitCode = failed ? 1 : 0;
