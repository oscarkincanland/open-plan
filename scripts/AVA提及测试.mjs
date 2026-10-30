#!/usr/bin/env node
/**
 * AVA 提及测试（v0.13.7）
 *
 * 守护：
 *   1) `@` 触发智能体菜单：行首/空白后触发、名称/描述过滤、键盘可达（↑↓/Enter/Esc）；
 *   2) 与既有文件引用共存：`@文件[…]` 等标记不被提及逻辑劫持，`@@` 转义不触发；
 *   3) 发送时注入角色指令与技能到 prompt 前缀（用户可见文本与 task.goal 不变）；
 *   4) Agent 继承：/api/agent/new 接受 agentId 落盘 header，列表投影返回 agentId，
 *      顶栏/斜杠命令新建沿用当前会话智能体。
 *
 * 用法：node scripts/AVA提及测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const index = read("server/index.mjs");
const api = read("client/src/api.js");
const app = read("client/src/App.jsx");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const mention = read("client/src/components/提及逻辑.js");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

// 直接执行纯函数：触发/转义/过滤/注入的行为级断言（不只查源码形状）。
const mentionLogic = await import(`file://${path.join(ROOT, "client/src/components/提及逻辑.js").replace(/\\/g, "/")}`);
const { detectMentionTrigger, filterAgentsForMention, buildMentionPrefix } = mentionLogic;

test("行为：@ 行首触发、@@ 与标记不触发", () => {
  assert.deepEqual(detectMentionTrigger("@", 1), { start: 0, query: "" });
  assert.deepEqual(detectMentionTrigger("帮我 @公", 5), { start: 3, query: "公" });
  assert.equal(detectMentionTrigger("看看@@", 4), null, "@@ 为转义不触发");
  assert.equal(detectMentionTrigger("abc@公", 5), null, "前一字符是普通字符不触发");
  assert.equal(detectMentionTrigger("帮我 @智能体[公文] 继续", 12), null, "完整标记不重复触发");
});

test("行为：名称/描述过滤", () => {
  const agents = [
    { id: "a", name: "公文报告编制助手", description: "按公文规范撰写报告" },
    { id: "b", name: "地图可视化助手", description: "OD 期望线可视化" },
  ];
  assert.equal(filterAgentsForMention(agents, "").length, 2);
  assert.equal(filterAgentsForMention(agents, "公文").length, 1);
  assert.equal(filterAgentsForMention(agents, "OD").length, 1, "描述命中也算");
  assert.equal(filterAgentsForMention(agents, "不存在").length, 0);
});

test("行为：发送注入角色指令与技能，@@ 转义不注入", () => {
  const agents = [{ id: "a", name: "公文助手", prompt: "按公文规范写", skills: ["md-to-docx"] }];
  const prefix = buildMentionPrefix("帮我 @智能体[公文助手] 写总结", agents);
  assert.match(prefix, /\[提及智能体: 公文助手\]/);
  assert.match(prefix, /角色指令：按公文规范写/);
  assert.match(prefix, /可用技能：md-to-docx/);
  assert.equal(buildMentionPrefix("这是@@智能体[公文助手] 转义", agents), "", "@@ 转义不注入");
  assert.equal(buildMentionPrefix("@智能体[不存在]", agents), "", "未知智能体不注入");
});

test("服务端：/api/agent/new 接受 agentId 并校验存在性", () => {
  assert.match(index, /const \{ client, thread, cwd, projectId, label, agentId \} = req\.body \|\| \{\};/);
  assert.match(index, /listAgents\(\)\.some\(\(item\) => item\?\.id === inheritedAgentId\)/);
  assert.match(index, /agentExists \? \{ agentId: inheritedAgentId \} : \{\}/);
});

test("服务端：会话列表投影返回 agentId", () => {
  assert.match(index, /agentId: typeof h\.agentId === "string" \? h\.agentId : "",/);
});

test("前端：新建会话透传 agentId（顶栏继承 + /new 沿用）", () => {
  assert.match(app, /handleNewSession\(undefined, \{ agentId: currentSession\?\.agentId \|\| "" \}\)/);
  assert.match(app, /inheritedAgentId \? \{ agentId: inheritedAgentId \} : \{\}/);
  assert.match(chatPanel, /onNewSession\?\.\(workspace, \{ agentId: sessionAgentId \}\)/);
  assert.match(api, /createAgentThread = \(client, thread, cwd, options = \{\}\)/);
});

test("前端：提及菜单接线（触发 / 键盘可达 / 渲染）", () => {
  assert.match(chatPanel, /setMentionState\(detectMentionTrigger\(value, e\.target\.selectionStart \?\? value\.length\)\)/);
  assert.match(chatPanel, /pickMention\(mentionFiltered\[mentionIndex\] \|\| mentionFiltered\[0\]\)/);
  assert.match(chatPanel, /<提及菜单\s*\n\s*agents=\{mentionFiltered\}/);
  assert.match(chatPanel, /role="listbox"/, "候选列表键盘可达（listbox 语义）");
});

test("前端：@ 提及与文件引用共存", () => {
  assert.match(chatPanel, /\/\^\(\?\:文件\|知识库\|模板\|模板目录\|智能体\)\\\[/);
  assert.match(mention, /const MENTION_MARKER = "智能体"/);
});

test("前端：能力预览展示继承的 Agent", () => {
  assert.match(chatPanel, /Agent：\{sessionAgentId \? \(agents\.find\(\(item\) => item\.id === sessionAgentId\)\?\.name \|\| sessionAgentId\) : "未指定（默认）"\}/);
});

console.log(failed ? "\nAVA 提及测试：存在失败项" : "\nAVA 提及测试：全部通过");
process.exit(failed ? 1 : 0);
