#!/usr/bin/env node
/**
 * 会话并发与闸门测试（2026-11-04）。
 *
 * 会话层本身已按 client::thread 建独立 runtime；本测试锁定本轮改造的三个契约：
 *   1. 模型/Office 全局并发默认值提高，且可由环境变量覆盖；
 *   2. /api/agent/stream 的 supersede 按 thread 收敛，不互相收流；
 *   3. HTTP 层补发事件使用原始 client（entry.eventClientId），而不是复合 key。
 *
 * 用法: node scripts/会话并发与闸门测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};

const runtime = read("server/Pi运行时管理.mjs");
const streams = read("server/流连接.mjs");
const agent = read("server/agent.mjs");
const index = read("server/index.mjs");

test("模型/Office 并发默认 6/2，并保留环境变量覆盖", () => {
  assert.match(runtime, /DEFAULT_AGENT_CONCURRENCY = 6/);
  assert.match(runtime, /DEFAULT_OFFICE_CONCURRENCY = 2/);
  assert.match(runtime, /process\.env\.OAW_MAX_AGENT_RUNS/);
  assert.match(runtime, /process\.env\.OAW_MAX_OFFICECLI/);
});

test("对话流 supersede 按 thread 收敛，不同会话不互相收流", () => {
  assert.match(streams, /path !== "\/api\/agent\/stream" \|\| \(entry\.thread \|\| ""\) === \(thread \|\| ""\)/);
});

test("事件落盘使用原始 client，而不是 client::thread 复合键", () => {
  assert.match(agent, /eventClientId: options\.eventClientId/);
  assert.match(index, /entry\.eventClientId \|\| entry\.clientId/);
});

test("会话键仍是 client::thread，且同 thread 才排队", () => {
  assert.match(index, /function agentKey\(client, thread\)/);
  assert.match(index, /return t \? `\$\{c\}::\$\{t\}` : c/);
  assert.match(agent, /this\.sessions = new Map\(\); \/\/ agentKey\(clientId:threadId\) -> session entry/);
  assert.match(agent, /entry\.promptChain/);
});

console.log(failed ? "\n✗ 会话并发与闸门测试存在失败" : "\n✓ 会话并发与闸门测试全部通过");
process.exit(failed ? 1 : 0);
