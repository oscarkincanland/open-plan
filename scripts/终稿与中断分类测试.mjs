#!/usr/bin/env node
/**
 * 终稿边界与中断分类测试（计划 2026-11-05-017）。
 *
 * 覆盖：thinking-only 终稿、工具标签清洗、8 类中断归约。
 * 用法: node scripts/终稿与中断分类测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const { finalAnswerState } = await import(pathToFileURL(path.join(ROOT, "server/终稿.mjs")).href);
const { classifyRunInterruption } = await import(pathToFileURL(path.join(ROOT, "server/runs.mjs")).href);
const { stripToolMarkup, hasToolMarkup } = await import(pathToFileURL(path.join(ROOT, "client/src/工具标签清洗.js")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};

console.log("\n▶ 终稿边界");
test("只有 thinking → thinkingOnly", () => {
  const state = finalAnswerState({ content: [{ type: "thinking", thinking: "先看看文件" }] });
  assert.equal(state.thinkingOnly, true);
  assert.equal(state.hasText, false);
});
test("thinking + text → 有终稿", () => {
  const state = finalAnswerState({ content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "结论" }] });
  assert.equal(state.thinkingOnly, false);
  assert.equal(state.text, "结论");
});
test("只有 toolCall → 不是 thinkingOnly", () => {
  const state = finalAnswerState({ content: [{ type: "toolCall", name: "read" }] });
  assert.equal(state.thinkingOnly, false);
  assert.equal(state.hasToolCall, true);
});

console.log("\n▶ 工具标签清洗");
test("剥离自闭合 ask_user", () => {
  const out = stripToolMarkup('说明\n<ask_user question="x" options={["a"]} />\n');
  assert.equal(out, "说明");
});
test("剥离 tool_call / function_calls", () => {
  assert.equal(stripToolMarkup('<tool name="read" />正文'), "正文");
  assert.equal(stripToolMarkup('<function_calls><tool /></function_calls>正文'), "正文");
});
test("hasToolMarkup 能识别", () => {
  assert.equal(hasToolMarkup("<ask_user />"), true);
  assert.equal(hasToolMarkup("正常文本"), false);
});

console.log("\n▶ 中断分类");
const base = { status: "completed", finalText: "结论", events: [] };
test("用户取消", () => {
  const r = classifyRunInterruption({ ...base, status: "cancelled", cancelReason: "用户在对话栏请求中断" });
  assert.equal(r.kind, "user_cancel");
});
test("401 鉴权", () => {
  const r = classifyRunInterruption({ ...base, status: "failed", error: '401 {"error":{"type":"authentication_error"}}' });
  assert.equal(r.kind, "provider_auth");
  assert.equal(r.action, "open_settings");
});
test("400 thinking 配置", () => {
  const r = classifyRunInterruption({ ...base, status: "failed", error: '400 "thinking.type.enabled" is not supported for this model' });
  assert.equal(r.kind, "provider_config");
});
test("服务重启", () => {
  const r = classifyRunInterruption({ ...base, status: "cancelled", recovery: { reason: "服务重启后需要用户确认继续" } });
  assert.equal(r.kind, "service_restart");
});
test("预算硬停", () => {
  const r = classifyRunInterruption({ ...base, events: [{ type: "run_budget_blocked", data: { code: "TURN_BUDGET_HARD" } }] });
  assert.equal(r.kind, "budget_hard");
});
test("流水线超时", () => {
  const r = classifyRunInterruption({ ...base, status: "completed", recovery: { reason: "编辑流水线失败：子 Agent 执行超过 240 秒" } });
  assert.equal(r.kind, "pipeline_timeout");
});
test("看门狗", () => {
  const r = classifyRunInterruption({ ...base, status: "failed", recovery: { reason: "模型连接超过 45 秒没有响应，已自动中止" } });
  assert.equal(r.kind, "watchdog");
});
test("completed 但没有 finalText → final_text_missing", () => {
  const r = classifyRunInterruption({ status: "completed", finalText: "", events: [] });
  assert.equal(r.kind, "final_text_missing");
});
test("有 finalText 的 completed 不误报", () => {
  const r = classifyRunInterruption(base);
  assert.notEqual(r.kind, "final_text_missing");
});

console.log("\n▶ 接线断言");
test("agent.mjs 接入终稿状态、一次性补正文与 final_text_missing", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /finalAnswerState/);
  assert.match(agent, /finalAnswerNudged/);
  assert.match(agent, /final_text_missing/);
  assert.match(agent, /lastAssistantState/);
});
test("执行句柄把 thinking-only 标为 partial + final_answer_missing", () => {
  const handle = read("server/执行句柄.mjs");
  assert.match(handle, /final_answer_missing/);
  assert.match(handle, /thinkingOnly/);
});
test("前端成果区不再用最后一段 text 兜底", () => {
  const chat = read("client/src/components/ChatPanel.jsx");
  assert.match(chat, /const finalAnswerBlockIndex = finalTextBlockIndex/);
  assert.doesNotMatch(chat, /finalTextBlockIndex >= 0 \? finalTextBlockIndex : lastTextBlockIndex/);
  assert.match(chat, /final-answer-missing/);
});

console.log(failed ? "\n终稿与中断分类测试：存在失败\n" : "\n终稿与中断分类测试：全部通过\n");
process.exit(failed ? 1 : 0);
