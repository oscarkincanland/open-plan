#!/usr/bin/env node
/**
 * T1 排队提示契约测试：
 * 服务端在会话忙时发 agent_queued（带 position），前端必须把它显示为“任务排队（第 N 项）”，
 * 而不是让用户无反馈等待。
 *
 * 用法: node scripts/排队提示测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const agent = read("server/agent.mjs");
const panel = read("client/src/components/ChatPanel.jsx");
const display = read("client/src/事件展示.js");

console.log("\n▶ T1 排队提示");

test("服务端在会话忙时发出 agent_queued 并携带排队位次", () => {
  assert.match(agent, /emitChannelSafe\(entry, "agent_queued", \{/);
  assert.match(agent, /position,/);
  assert.match(agent, /queued: entry\.queuedCount/);
});

test("聊天面板把 agent_queued 显示为“任务排队（第 N 项）”", () => {
  assert.match(panel, /case "agent_queued":/);
  assert.match(panel, /setAgentPhase\(`任务排队\$\{data\.position \? `（第 \$\{data\.position\} 项）` : ""\}`\)/);
  assert.match(panel, /status: "queued"/);
});

test("发送响应里的排队位次也会提示", () => {
  assert.match(panel, /if \(d\.queued\) setAgentPhase\(`已排队（第 \$\{d\.queuePosition \|\| 1\} 项）`\)/);
});

test("事件流摘要包含排队文案", () => {
  assert.match(display, /agent_queued: \{ phase: "executing" \}/);
  assert.match(display, /case "agent_queued": return `任务已排队/);
});

console.log(failed ? "\n✗ 排队提示测试存在失败" : "\n✓ 排队提示测试全部通过");
process.exitCode = failed ? 1 : 0;
