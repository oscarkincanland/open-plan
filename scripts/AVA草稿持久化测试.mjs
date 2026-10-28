#!/usr/bin/env node
/**
 * AVA 草稿持久化测试（v0.12.4）
 *
 * 守护：
 *   1) 草稿按 thread 写入 localStorage，刷新/重启可恢复；
 *   2) 隐私模式/配额受限时静默降级到内存缓存；
 *   3) 发送/新建会话后清除草稿，A/B 会话不串。
 *
 * 本仓库没有 Jest/Vitest，前端交互以“源码契约 + 浏览器冒烟”分层守护。
 * 用法：node scripts/AVA草稿持久化测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
};

test("草稿使用 localStorage 前缀与索引键", () => {
  assert.match(chatPanel, /const DRAFT_STORAGE_PREFIX = "oaw_draft_v1:"/);
  assert.match(chatPanel, /const DRAFT_INDEX_KEY = "oaw_draft_index_v1"/);
  assert.match(chatPanel, /const DRAFT_CACHE_LIMIT = 20/);
});

test("读取草稿先命中内存缓存，再回落到 localStorage", () => {
  assert.match(chatPanel, /function readDraft\(threadId\) \{/);
  assert.match(chatPanel, /if \(draftCache\.has\(threadId\)\) return draftCache\.get\(threadId\)/);
  assert.match(chatPanel, /draftStorage\(\)\?\.getItem\(DRAFT_STORAGE_PREFIX \+ threadId\)/);
});

test("写入草稿同时维护内存 LRU 与 localStorage 索引", () => {
  assert.match(chatPanel, /store\.setItem\(DRAFT_STORAGE_PREFIX \+ threadId, text\)/);
  assert.match(chatPanel, /const next = \[threadId, \.\.\.index\.filter\(\(id\) => id !== threadId\)\]\.slice\(0, DRAFT_CACHE_LIMIT\)/);
  assert.match(chatPanel, /while \(draftCache\.size > DRAFT_CACHE_LIMIT\)/);
});

test("隐私模式/配额失败静默降级，不阻断输入", () => {
  assert.match(chatPanel, /function draftStorage\(\) \{[\s\S]*?catch \{\s*return null;\s*\}/);
  assert.match(chatPanel, /try \{ text = draftStorage\(\)\?\.getItem\(DRAFT_STORAGE_PREFIX \+ threadId\) \|\| ""; \} catch \{ text = ""; \}/);
  assert.match(chatPanel, /store\.setItem\(DRAFT_STORAGE_PREFIX \+ threadId, text\)/);
  assert.match(chatPanel, /const index = readDraftIndex\(\);[\s\S]{0,260}\} catch \{\}/);
});

test("切会话保存 A 草稿并恢复 B 草稿", () => {
  assert.match(chatPanel, /if \(input\) writeDraft\(previous, input\)/);
  assert.match(chatPanel, /setInput\(readDraft\(threadId\)\)/);
});

test("发送/新建会话后清除当前草稿", () => {
  assert.match(chatPanel, /const clearInput = useCallback|function clearInput/);
  assert.match(chatPanel, /writeDraft\(threadId, ""\)/);
});

console.log(failed ? "\nAVA 草稿持久化测试：存在失败项" : "\nAVA 草稿持久化测试：全部通过（6 例）");
process.exit(failed ? 1 : 0);
