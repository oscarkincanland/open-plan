#!/usr/bin/env node
/**
 * AVA 消息版本测试（v0.12.6–v0.12.8）
 *
 * 守护：
 *   1) 编辑用户消息：分支点 = 父 entry，旧分支保留，附件/引用不回填丢失；
 *   2) 助手消息 fork：只复制到该消息（含工具结果配对），旧会话不变；
 *   3) regenerate / 版本切换：同一 parent 下兄弟分支，第 N/M 版可切换。
 *
 * 用法：node scripts/AVA消息版本测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8").replace(/\r\n/g, "\n");
const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8").replace(/\r\n/g, "\n");
const app = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8").replace(/\r\n/g, "\n");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");
const api = fs.readFileSync(path.join(ROOT, "client", "src", "api.js"), "utf8").replace(/\r\n/g, "\n");

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

test("编辑/重新生成先移动 leaf 再发送，旧分支保留", () => {
  assert.match(chatPanel, /const pendingBranchRef = useRef\(null\)/);
  assert.match(chatPanel, /if \(branch\?\.entryId\) \{[\s\S]{0,400}await branchAgentSession\(clientId, threadId, branch\.entryId, \{ summarize: false \}\)/);
  assert.match(chatPanel, /const handleEditMessage = useCallback\(\(message\) => \{/);
  assert.match(chatPanel, /setPendingBranch\(\{ entryId: message\.parentId, messageId: message\.entryId, mode: "edit" \}\)/);
  assert.match(chatPanel, /updateInput\(message\.text \|\| ""\)/);
});

test("编辑回填历史图片与附件引用，不静默丢失上下文", () => {
  assert.match(chatPanel, /const restoredImages = \(message\.images \|\| \[\]\)\.map/);
  assert.match(chatPanel, /\^data:\(\[\^;,\]\+\);base64,/);
  assert.match(chatPanel, /setImages\(restoredImages\)/);
  assert.match(chatPanel, /const attachmentNames = \[\.\.\.String\(message\.text \|\| ""\)\.matchAll/);
  assert.match(chatPanel, /setReferences\(restoredReferences\)/);
});

test("编辑发送后只移除目标消息及其后续气泡", () => {
  assert.match(chatPanel, /const index = previous\.findIndex\(\(message\) => \(message\.entryId \|\| message\.id\) === branch\.messageId\)/);
  assert.match(chatPanel, /return index >= 0 \? previous\.slice\(0, index\) : previous/);
});

test("重新生成从末轮已保存用户消息出发", () => {
  assert.match(chatPanel, /const handleRegenerateMessage = useCallback\(\(message\) => \{/);
  assert.match(chatPanel, /reverse\(\)\.find\(\(item\) => item\.role === "user" && item\.entryId && String\(item\.text \|\| ""\)\.trim\(\)\)/);
  assert.match(chatPanel, /pendingBranchRef\.current = branch;/);
  assert.match(chatPanel, /void resendRef\.current\?\.\(lastUser\.text, \{ force: true \}\)/);
});

test("服务端 branchSession 追加 custom 标记固化活跃 leaf", () => {
  assert.match(agent, /appendCustomEntry\?\.\("oaw_branch_point"/);
  assert.match(agent, /targetId: String\(entryId\)/);
});

test("从指定消息 fork 只复制到该消息并保留工具结果", () => {
  assert.match(index, /const sourceMessageId = String\(req\.body\?\.sourceMessageId \|\| ""\)\.trim\(\)/);
  assert.match(index, /if \(targetIndex < 0\) return res\.status\(404\)\.json\(\{ error: "source message not found", code: "SOURCE_MESSAGE_NOT_FOUND" \}\)/);
  assert.match(index, /role !== "toolResult" && role !== "tool_result"/);
  assert.match(index, /kept = kept\.slice\(0, lastIndex \+ 1\)/);
  assert.match(index, /\[JSON\.stringify\(nextHeader\), \.\.\.kept\]\.join\("\\n"\)/);
});

test("版本列表接口按同一 parent 的兄弟 user 消息分组", () => {
  assert.match(index, /app\.get\("\/api\/sessions\/:id\/message-versions"/);
  assert.match(index, /function messageVersionsForSession\(entries, messageId\)/);
  assert.match(index, /currentVersion: activeIndex >= 0 \? activeIndex \+ 1 : versions\.length/);
  assert.match(index, /leafId: branchContains\(entry\.id\) \? activeLeafId : deepestLeaf\(entry\.id\)/);
});

test("前端保留 entryId/parentId 并提供版本切换", () => {
  assert.match(app, /entryId: e\.id \|\| null, parentId: e\.parentId \|\| null/);
  assert.match(api, /export const getSessionMessageVersions = \(id, messageId\)/);
  assert.match(chatPanel, /getSessionMessageVersions\(sessionId, m\.entryId\)/);
  assert.match(chatPanel, /const handleSwitchVersion = useCallback\(async \(leafId\) => \{/);
  assert.match(chatPanel, /await branchAgentSession\(clientId, threadId, leafId, \{ summarize: false \}\)/);
  assert.match(chatPanel, /第 \{versions\.currentVersion\} \/ \{versions\.total\} 版/);
});

test("助手消息 fork 入口在 live 时禁用", () => {
  assert.match(chatPanel, /const handleForkMessage = useCallback\(async \(message\) => \{[\s\S]{0,120}if \(busy \|\| frozen \|\| !message\?\.entryId\) return/);
  assert.match(chatPanel, /onForkSession\(sessionId, `分支 · \$\{String\(message\.text \|\| "消息"\)\.slice\(0, 20\)\}`, \{ sourceMessageId: message\.entryId \}\)/);
  assert.match(chatPanel, /!isUser && onForkMessage && m\.entryId/);
});

console.log(failed ? "\nAVA 消息版本测试：存在失败项" : "\nAVA 消息版本测试：全部通过（9 例）");
process.exit(failed ? 1 : 0);
