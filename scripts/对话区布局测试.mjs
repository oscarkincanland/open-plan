#!/usr/bin/env node
/**
 * 对话区布局契约测试：
 * 消息、执行过程卡、任务卡、输入区共用同一内容列（--msg-content-max），
 * 内容列在对话区自身宽度内居中（a71cd950 口径），左右内边距对称取
 * --chat-gutter，输入区用 translateX(-4px) 补偿 scrollbar-gutter 留位；
 * 正文与代码字号符合 DESIGN（14/1.75，代码 12/1.65）。
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
  assert.match(css, /--msg-content-max:\s*min\(100%,\s*720px\);/);
  assert.match(css, /--chat-gutter:\s*clamp\(20px,\s*5vw,\s*72px\);/);
  assert.match(css, /--scrollbar-w:\s*8px;/);
});

test("消息列与输入区共用 --msg-content-max", () => {
  // 列在对话区自身宽度内居中：margin auto 左右对称，宽度吃满 --msg-content-max。
  assert.match(css, /\.center-chat-slot \.chat-body > \.msg,[\s\S]{0,160}?max-width: var\(--msg-content-max\)/);
  assert.match(css, /\.msg \.msg-main \{ max-width: min\(var\(--msg-content-max\), 100%\); \}/);
  // 输入区外壳与消息列同宽同轴：宽度计 scrollbar-gutter 留位，transform 补偿 4px。
  const compose = /\.center-chat-slot \.chat-compose\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(compose, "缺少 .chat-compose 规则");
  assert.match(compose[1], /width:\s*min\(var\(--msg-content-max\), calc\(100% - var\(--chat-gutter\) \* 2 - var\(--scrollbar-w\)\)\);/, "外壳宽度须与消息列共用同一公式");
  assert.match(compose[1], /transform:\s*translateX\(-4px\);/, "外壳须补偿 scrollbar-gutter 造成的中轴左移");
  assert.match(css, /\.center-chat-slot \.chat-compose \.chat-input \{[^}]*width: 100%;/, "输入框本体占满外壳");
});

test("对话区 padding 只由 --chat-gutter 控制", () => {
  assert.match(css, /\.center-chat-slot \.chat-body \{[\s\S]{0,240}?padding: 34px var\(--chat-gutter\) 28px;/);
  assert.doesNotMatch(css, /\.center-chat-slot \.chat-body \{ padding: 28px clamp\(28px, 7vw, 104px\) 20px; \}/);
});

test("旧的 820/880 消息列与 104px 留白不再残留", () => {
  assert.doesNotMatch(css, /\.center-chat-slot \.msg-main \{ min-width: 0; max-width: 820px; \}/);
  assert.doesNotMatch(css, /\.center-chat-slot \.msg-main \{ width: min\(100%, 880px\); max-width: 880px; \}/);
  assert.doesNotMatch(css, /max-width: 880px;\s*margin-left: auto;\s*margin-right: auto;/);
});

test("窄屏取消补偿，头像让位正文", () => {
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.center-chat-slot \.chat-compose \{ transform: none; \}/);
});

console.log("\n▶ 字号与可读性");

test("助手与用户正文 14/1.75，代码 12/1.65（v0.13.26 归一档）", () => {
  assert.match(css, /\.center-chat-slot \.flow-markdown,[\s\S]{0,220}?font-size: 14px; line-height: 1\.75;/);
  assert.match(css, /\.center-chat-slot \.msg\.user \.flow-markdown,[\s\S]{0,220}?font-size: 14px; line-height: 1\.75;/);
  assert.match(css, /\.center-chat-slot \.markdown-body pre,\s*\n\.center-chat-slot \.markdown-body code \{ font-size: 12px; line-height: 1\.65; \}/);
});

test("任务进度改为输入框上方的居中浮动圆环", () => {
  assert.match(css, /\.center-chat-slot \.chat-compose > \.task-orb \{\s*width: 38px;\s*max-width: 38px;\s*margin: 0;/);
  assert.match(css, /\.chat-compose > \.task-orb \{[\s\S]{0,260}?left: 50%;[\s\S]{0,260}?transform: translateX\(-50%\);/);
  assert.match(css, /\.task-orb\.running \.task-orb-ring \{ animation: task-orb-spin/);
  assert.doesNotMatch(css, /\.chat-compose > \.task-card \{\s*width: min\(380px, 100%\);/, "旧的整行任务卡不应再占位");
});

test("画布标签关闭按钮贴右", () => {
  const main = /\.canvas-tab-main \{([\s\S]*?)\}/.exec(css);
  assert.ok(main, "缺少 .canvas-tab-main 规则");
  assert.match(main[1], /flex:\s*1 1 auto;/, "标签主按钮应撑开，把关闭按钮推到右缘");
});

console.log(failed ? "\n✗ 对话区布局测试存在失败" : "\n✓ 对话区布局测试全部通过");
process.exitCode = failed ? 1 : 0;
