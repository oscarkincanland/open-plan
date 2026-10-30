#!/usr/bin/env node
/**
 * AVA 对话状态可信测试（v0.11.56 小版本）
 *
 * 守护三项 P0 交互契约：
 *   1) 压缩进行中禁止发送（send 守卫 + 发送按钮禁用）；
 *   2) 停止/中断后如实回执服务端保留的排队条数（stillQueued）；
 *   3) 发送/停止三态：空闲且无输入时发送按钮禁用。
 *
 * 说明：本仓库当前没有 Jest/Vitest，前端交互以“源码契约 + 浏览器冒烟”分层守护。
 * 本脚本属于源码契约层，配合 `test:chat-flow`、`smoke:chat` 与手工回归使用。
 *
 * 用法：node scripts/AVA对话状态可信测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");
const execHandle = fs.readFileSync(path.join(ROOT, "server", "执行句柄.mjs"), "utf8").replace(/\r\n/g, "\n");

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

const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `找不到起点：${startMarker}`);
  assert.ok(end > start, `找不到终点：${endMarker}`);
  return source.slice(start, end);
};

/* ---------------- 1) 压缩中禁止发送 ---------------- */

test("send 在压缩进行中直接返回，并给出可读提示", () => {
  const sendSource = sliceBetween(chatPanel, "const send = async", "const stop = async");
  assert.match(sendSource, /if \(compacting\) \{/, "send 缺少 compacting 守卫");
  assert.match(sendSource, /正在压缩上下文，请稍候再发送/, "缺少压缩中提示文案");
});

test("send 的压缩守卫位于实际构造消息之前", () => {
  const sendSource = sliceBetween(chatPanel, "const send = async", "const stop = async");
  const guardAt = sendSource.indexOf("if (compacting)");
  const rawTextAt = sendSource.indexOf("const rawText");
  assert.ok(guardAt >= 0 && rawTextAt > guardAt, "压缩守卫必须在 rawText 构造之前");
});

test("空闲态发送按钮在压缩中禁用", () => {
  assert.match(
    chatPanel,
    /disabled=\{frozen \|\| compacting \|\| !hasDraft\}/,
    "空闲发送按钮应同时受 frozen、compacting、hasDraft 约束",
  );
  assert.match(chatPanel, /正在压缩上下文，请稍候/, "按钮 title 应说明压缩中不可发送");
});

test("运行中排队/立即/注入按钮在压缩中禁用", () => {
  assert.match(
    chatPanel,
    /pending-send-btn"[\s\S]{0,160}disabled=\{compacting\}/,
    "运行中待发送按钮应受 compacting 约束",
  );
});

/* ---------------- 2) 停止后保留队列回执 ---------------- */

test("stop 读取服务端 stillQueued", () => {
  const stopSource = sliceBetween(chatPanel, "const stop = async", "const flushQueued");
  assert.match(stopSource, /result\?\.stillQueued/, "stop 必须读取 stillQueued");
});

test("stop 在保留条数大于 0 时给出系统通知与临时提示", () => {
  const stopSource = sliceBetween(chatPanel, "const stop = async", "const flushQueued");
  assert.match(stopSource, /if \(retained > 0\)/, "缺少仍有排队的条件分支");
  assert.match(stopSource, /保留 \$\{retained\} 条排队消息/, "系统通知应包含保留条数");
  assert.match(stopSource, /setModelMsg\(`已中断，保留 \$\{retained\} 条排队消息`\)/, "缺少输入区临时提示");
});

test("服务端中断回执仍返回 stillQueued", () => {
  assert.match(
    execHandle,
    /stillQueued: Number\(live\?\.queuedCount \|\| 0\)/,
    "执行句柄中断回执必须保留 stillQueued 字段",
  );
});

test("工作区 AGENTS.md 只提示一次项目指令生效", () => {
  assert.match(chatPanel, /const projectInstructionNotifiedRef = useRef\(new Set\(\)\)/);
  assert.match(chatPanel, /\(referenceFiles \|\| \[\]\)\.some\(\(name\) => \/\(\^\|\[\\\\\/\]\)AGENTS\\\.md\$\//);
  assert.match(chatPanel, /pushSystem\("已加载工作区指令 AGENTS\.md，本会话的对话与任务会遵循其中约定。", `project-instructions:\$\{threadId\}`\)/);
});

/* ---------------- 3) 发送/停止三态 ---------------- */

test("空闲且无输入时发送按钮禁用", () => {
  assert.match(chatPanel, /!hasDraft/, "三态按钮应引用 hasDraft");
  assert.match(chatPanel, /请输入内容后发送/, "无输入时应给出禁用原因");
});

test("运行中无输入时保留停止按钮，有输入时提供待发送按钮", () => {
  const inputSend = sliceBetween(chatPanel, '<div className="input-send">', "</div>\n          </div>");
  assert.match(inputSend, /\{busy \? \(/, "输入区应按 busy 分流");
  assert.match(inputSend, /\{hasDraft && <button className="btn primary pending-send-btn"/, "运行中有输入时应提供待发送按钮");
  assert.match(inputSend, /className="btn danger stop-btn"/, "运行中应提供停止按钮");
  assert.match(inputSend, /disabled=\{stopping\}/, "停止按钮在中断中应禁用");
});

console.log(failed ? "\nAVA 对话状态可信测试：存在失败项" : "\nAVA 对话状态可信测试：全部通过（10 例）");
process.exit(failed ? 1 : 0);
