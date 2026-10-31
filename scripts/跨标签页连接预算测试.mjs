#!/usr/bin/env node
/**
 * 跨标签页连接预算契约：
 * - 全局事件流由 leader 持有，follower 通过 BroadcastChannel 接收；
 * - 关闭流时先释放本地 socket，再通知服务端收尾；
 * - 对话流仍按标签页保留，3 标签页目标 ≤4 条 SSE。
 *
 * 用法: node scripts/跨标签页连接预算测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const app = read("client/src/App.jsx");
const budget = read("client/src/长连接预算.js");
const lease = read("client/src/跨标签页流租约.js");

console.log("\n▶ 跨标签页租约");

test("App 使用全局事件流租约，follower 不直接连接", () => {
  assert.match(app, /createGlobalEventsLease/);
  assert.match(app, /onEvent: handlePayload/);
  assert.match(app, /const startLeaderStream/);
  assert.match(app, /onStart: startLeaderStream/);
  assert.match(app, /onStop: stopLeaderStream/);
  assert.match(app, /leaderActive/);
  assert.match(app, /if \(cancelled \|\| !leaderActive\) return/);
});

test("租约包含心跳、过期与 leader 冲突处理", () => {
  assert.match(lease, /LEASE_MS/);
  assert.match(lease, /HEARTBEAT_MS/);
  assert.match(lease, /BroadcastChannel/);
  assert.match(lease, /resign/);
  assert.match(lease, /maybePromote/);
  assert.match(lease, /String\(message\.tabId\) < TAB_ID/);
});

test("关闭流先释放本地 EventSource，再通知服务端", () => {
  const start = budget.indexOf("if (es.readyState === EventSource.OPEN");
  const segment = budget.slice(start, budget.indexOf("if (es.readyState === EventSource.CONNECTING", start));
  assert.ok(segment.indexOf("finish();") < segment.indexOf("fetch(\"/api/agent/stream/close\""), "必须先 close 再 POST");
  assert.match(segment, /keepalive: true/);
  assert.match(segment, /AbortSignal\.timeout/);
});

console.log(failed ? "\n✗ 跨标签页连接预算测试存在失败" : "\n✓ 跨标签页连接预算测试全部通过");
process.exitCode = failed ? 1 : 0;
