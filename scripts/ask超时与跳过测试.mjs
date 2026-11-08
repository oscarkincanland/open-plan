#!/usr/bin/env node
/**
 * ask_user 超时与跳过测试（2026-11-04）
 *
 * 守护：
 *   1) 等待窗口 30 分钟（可配），到点自动失效；
 *   2) 「跳过并继续」走服务端结算，不写入用户回答；
 *   3) 已回答/已超时/已取消在消息流收成一行回执，不再保留可交互大卡片；
 *   4) 前端提交 skip 时不会因缺少 answer 被 400 拒绝。
 *
 * 用法：node scripts/ask超时与跳过测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const agent = read("server/agent.mjs");
const index = read("server/index.mjs");
const handle = read("server/执行句柄.mjs");
const chat = read("client/src/components/ChatPanel.jsx");

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

test("服务端等待窗口默认 30 分钟且可配置", () => {
  assert.match(agent, /process\.env\.OAW_ASK_TIMEOUT_MS \|\| "1800000"/, "默认应为 1800000ms");
  assert.match(agent, /export const ASK_TIMEOUT_MS = Math\.max\(60_000/, "最低 60 秒并允许覆盖");
});

test("服务端提供 skipPendingAsk 并以 skipped 结算", () => {
  assert.match(agent, /skipPendingAsk\(clientId\)/, "缺少 skipPendingAsk");
  assert.match(agent, /status: "skipped"/, "跳过状态应落为 skipped");
  assert.match(agent, /用户选择跳过该问题，请按专业判断继续/, "跳过应给模型明确继续提示");
});

test("执行句柄暴露跳过问答", () => {
  assert.match(handle, /function 跳过问答\(/, "执行句柄缺少跳过问答");
  assert.match(handle, /跳过问答,/, "跳过问答未导出");
  assert.match(handle, /管理器\(\)\.skipPendingAsk\?\.\(key\)/, "应委托给 AgentManager.skipPendingAsk");
});

test("回答接口接受 skip 且不要求 answer", () => {
  assert.match(index, /const \{ client, thread, answer, values, skip \}/, "路由未读取 skip");
  assert.match(index, /if \(skip === true\)/, "路由缺少 skip 分支");
  assert.match(index, /执行句柄\.跳过问答\(client, \{ thread \}\)/, "skip 分支应调用执行句柄");
});

test("前端提供「跳过并继续」，并提交 skip:true", () => {
  assert.match(chat, /body: JSON\.stringify\(\{ client: clientId, thread: threadId, skip: true \}\)/, "前端未提交 skip");
  assert.match(chat, /跳过并继续/, "缺少跳过按钮文案");
  assert.match(chat, /const skip = async \(\) =>/, "AskBlock 缺少 skip 处理");
});

test("已回答/已超时收成一行回执", () => {
  assert.match(chat, /if \(block\.answer \|\| expired\)/, "缺少回执分支");
  assert.match(chat, /className=\{`ask-receipt \$\{/, "缺少 ask-receipt 样式类");
  assert.match(chat, /已超时，Agent 已按假设继续/, "缺少超时回执文案");
  assert.match(chat, /const ASK_TIMEOUT_FALLBACK_MS = 30 \* 60 \* 1000/, "前端兜底窗口应为 30 分钟");
});

test("样式包含回执与跳过按钮", () => {
  const styles = read("client/src/styles.css");
  assert.match(styles, /\.ask-receipt \{/, "缺少 .ask-receipt");
  assert.match(styles, /\.ask-receipt\.answered/, "缺少已回答态");
  assert.match(styles, /\.ask-skip \{/, "缺少 .ask-skip");
});

// ---- 2026-11-08 D0-7：默认假设 + 可撤销的契约 ----
test("ask_user 支持 intent 与 assumption", () => {
  assert.match(agent, /intent: Type\.Optional\(Type\.Union\(/, "工具 schema 缺少 intent");
  assert.match(agent, /assumption: Type\.Optional\(Type\.String/, "工具 schema 缺少 assumption");
  assert.match(agent, /intent === "confirm" \? "" : "按专业判断继续/, "clarify/review 应有默认假设兜底");
});

test("澄清类短超时按假设继续，确认类不自动继续", () => {
  const runFlags = read("server/运行开关.mjs");
  assert.match(runFlags, /askAssumption: readFlag\("OAW_ASK_ASSUMPTION"\)/, "缺少 askAssumption 开关");
  assert.match(runFlags, /askAssumeTimeoutMs: readPositiveInt\("OAW_ASK_ASSUME_TIMEOUT_MS", 90_000\)/, "默认 90 秒");
  assert.match(agent, /const assumeEnabled = RUNTIME_FLAGS\.askAssumption && intent !== "confirm"/, "confirm 不应走假设继续");
  assert.match(agent, /已按假设继续：\$\{assumption\}/, "超时工具结果应写明假设");
  assert.match(agent, /resolvePendingAsk\(clientId, null, "assumed"\)/, "应记录 assumed 状态");
});

test("按 Run 限制技能搜索次数（防连续空搜）", () => {
  assert.match(agent, /entry\.skillSearchAttempts = new Map\(\)/, "缺少 Run 级搜索计数");
  assert.match(agent, /attempts > 3/, "缺少搜索次数上限");
});

console.log(failed ? "\nask 超时与跳过测试：存在失败项" : "\nask 超时与跳过测试：全部通过（10 例）");
process.exit(failed ? 1 : 0);
