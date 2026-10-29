#!/usr/bin/env node
/**
 * AVA 欢迎页测试（v0.13.7）
 *
 * 守护：
 *   1) 空会话首屏渲染欢迎卡片：标题/步骤/示例结构完整；
 *   2) 示例与智能体建议点击即发送（onSend 直连 send，不再只填输入框）；
 *   3) 建议提示词来自既有只读端点 /api/agents，接口失败或无数据时回退静态示例；
 *   4) 既有模式语义保留：Chat 只读提示 / Review 材料提示 / Work 审批提示。
 *
 * 用法：node scripts/AVA欢迎页测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const card = read("client/src/components/欢迎卡片.jsx");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("空会话首屏渲染欢迎卡片并接线发送", () => {
  assert.match(chatPanel, /messages\.length === 0 && \(\n\s*<欢迎卡片/);
  assert.match(chatPanel, /emptyExample=\{emptyExample\}/);
  assert.match(chatPanel, /agents=\{agents\}/);
  assert.match(chatPanel, /onSend=\{\(text\) => send\(text\)\}/);
});

test("欢迎卡片结构完整（标题/步骤/示例/提示）", () => {
  assert.match(card, /chat-empty-title/);
  assert.match(card, /chat-empty-steps/);
  assert.match(card, /chat-empty-examples/);
  assert.match(card, /className="hint"/);
});

test("点击示例直接发送", () => {
  assert.match(card, /onClick=\{\(\) => onSend\?\.\(example\)\}/);
  assert.match(card, /onClick=\{\(\) => onSend\?\.\(`@智能体\[\$\{agent\.name\}\] \$\{agent\.description \|\| "请协助完成相关任务"\}`\)\}/);
});

test("智能体建议来自既有只读端点且失败回退静态", () => {
  // ChatPanel 挂载时拉取 /api/agents（api.js 的 listAgents），失败保持空数组
  assert.match(chatPanel, /listAgents\(\)\n\s*\.then\(\(data\) => \{ if \(alive\) setAgents\(Array\.isArray\(data\?\.agents\) \? data\.agents : \[\]\); \}\)/);
  assert.match(chatPanel, /\.catch\(\(\) => \{\}\);/);
  // 卡片：agents 有数据时给智能体建议；无数据时回退静态 EMPTY_EXAMPLES
  assert.match(card, /agentSuggestions\.length > 0 && \(/);
  assert.match(card, /emptyExample\?\.examples \|\| \[\]/);
  assert.match(card, /staticExamples\.length > 0 && \(/);
});

test("模式语义保留（Chat 只读 / Review 材料 / Work 审批）", () => {
  assert.match(card, /Chat 只读：不会修改或生成文件；需要产出时切到 Work。/);
  assert.match(card, /请先打开或 @ 引用要审查的材料，原文默认不改，只生成报告与批注副本。/);
  assert.match(card, /会写入工作区，按审批提示确认；结束时以验收结果为准。/);
});

test("提及标记提示同步更新（@智能体[名称]）", () => {
  assert.match(card, /@ 引用文件或 @智能体\[名称\] 提及助手/);
});

console.log(failed ? "\nAVA 欢迎页测试：存在失败项" : "\nAVA 欢迎页测试：全部通过（6 例）");
process.exit(failed ? 1 : 0);
