#!/usr/bin/env node
/**
 * AVA 对话队列测试（v0.12.0–v0.12.2）
 *
 * 守护：
 *   1) QueueDock 基础：折叠、200 字预览、附件缩略、删除/编辑/提升回调；
 *   2) 队列单源：按 thread 缓存、dispatch 才发 prompt、失败/停止不丢；
 *   3) 编辑/提升：气泡与队列项同步，提升走 force 分支。
 *
 * 本仓库没有 Jest/Vitest，前端交互以“源码契约 + 浏览器冒烟”分层守护。
 * 用法：node scripts/AVA对话队列测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");
const queueDock = fs.readFileSync(path.join(ROOT, "client", "src", "components", "QueueDock.jsx"), "utf8").replace(/\r\n/g, "\n");
const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8").replace(/\r\n/g, "\n");

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

/* ---------------- v0.12.0 QueueDock 基础 ---------------- */

test("QueueDock 存在 200 字预览上限", () => {
  assert.match(queueDock, /const PREVIEW_LIMIT = 200/);
  assert.match(queueDock, /length > PREVIEW_LIMIT/);
});

test("QueueDock 默认折叠并提供计数头/展开", () => {
  assert.match(queueDock, /items\.length > 1\)/);
  assert.match(queueDock, /条排队消息/);
  assert.match(queueDock, /aria-expanded=\{expanded\}/);
});

test("QueueDock 提供编辑/删除/提升/清空回调", () => {
  for (const callback of ["onEdit", "onDelete", "onPromote", "onClear", "onContinue"]) {
    assert.match(queueDock, new RegExp(callback));
  }
  assert.match(queueDock, /编辑排队消息/);
  assert.match(queueDock, /删除排队消息/);
});

test("QueueDock 展示附件缩略并限制数量", () => {
  assert.match(queueDock, /images\.slice\(0, 3\)/);
  assert.match(queueDock, /attachments\.length/);
});

/* ---------------- v0.12.1 队列单源 ---------------- */

test("队列按 thread 缓存，切会话可恢复", () => {
  assert.match(chatPanel, /const queueCache = new Map\(\)/);
  assert.match(chatPanel, /function readQueueCache\(threadId\)/);
  assert.match(chatPanel, /function writeQueueCache\(threadId, items\)/);
  assert.match(chatPanel, /if \(previous\) writeQueueCache\(previous, queueRef\.current\)/);
  assert.match(chatPanel, /const restoredQueue = readQueueCache\(threadId\)/);
});

test("队列项包含 id/channel/status 并同步写缓存", () => {
  assert.match(chatPanel, /id: messageId,/);
  assert.match(chatPanel, /channel: "queue"/);
  assert.match(chatPanel, /status: "waiting"/);
  assert.match(chatPanel, /writeQueueCache\(threadId, nextQueue\)/);
});

test("flush 只派发队首且受 compacting/frozen 约束", () => {
  assert.match(chatPanel, /const flushQueued = \(force = false\) => \{/);
  assert.match(chatPanel, /stoppingRef\.current \|\| \(!force && busy\) \|\| compacting \|\| frozen \|\| !queueRef\.current\.length/);
  assert.match(chatPanel, /const \[next, \.\.\.rest\] = queueRef\.current/);
  assert.match(chatPanel, /payload: \{ \.\.\.next, status: "sending" \}/);
});

test("服务端仍有队列兜底与 agent_queued 事件", () => {
  assert.match(agent, /_enqueuePrompt\(entry, payload\)/);
  assert.match(agent, /emitChannelSafe\(entry, "agent_queued"/);
});

/* ---------------- v0.12.2 编辑/提升 ---------------- */

test("编辑排队项同时更新队列与消息气泡", () => {
  assert.match(chatPanel, /const updateQueueItem = useCallback/);
  assert.match(chatPanel, /message\.id === id && message\.queued \? \{ \.\.\.message, text \}/);
  assert.match(chatPanel, /\.\.\.item, text, rawText: text/);
});

test("删除/清空只移除 queued 气泡", () => {
  assert.match(chatPanel, /message\.id === id && message\.queued/);
  assert.match(chatPanel, /messages\.filter\(\(message\) => !message\.queued\)/);
});

test("提升为插话走 force 分支并保留 id", () => {
  assert.match(chatPanel, /const promoteQueueItem = useCallback/);
  assert.match(chatPanel, /channel: "steer", status: "sending"/);
  assert.match(chatPanel, /send\(undefined, \{\s*force: true,/);
});

test("QueueDock 已接入输入区且不再使用旧计数条", () => {
  assert.match(chatPanel, /<QueueDock\s+items=\{queuedMessages\}/);
  assert.doesNotMatch(chatPanel, /待执行 \{queuedMessages\.length\} 条/);
});

console.log(failed ? "\nAVA 对话队列测试：存在失败项" : "\nAVA 对话队列测试：全部通过（12 例）");
process.exit(failed ? 1 : 0);
