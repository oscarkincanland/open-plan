#!/usr/bin/env node
/**
 * AVA 历史分页测试（v0.12.5）
 *
 * 守护：
 *   1) Chat 视图沿活跃 leaf 的父链返回，废弃分支不混入当前会话；
 *   2) 服务端默认 50 条/页，before 游标续拉，historyStart/End/HasMore 语义完整；
 *   3) 前端“加载更早”先展开本地窗口，再按游标续拉，并恢复滚动锚点。
 *
 * 用法：node scripts/AVA历史分页测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8").replace(/\r\n/g, "\n");
const app = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8").replace(/\r\n/g, "\n");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");

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

test("Chat 视图沿活跃 leaf 父链过滤，老会话无 parentId 时不过滤", () => {
  assert.match(index, /function activeLeafSessionEntries\(entries\)/);
  assert.match(index, /const hasParentLinks = entries\.some\(\(entry\) => entry\?\.parentId\)/);
  assert.match(index, /if \(!hasParentLinks\) return \{ entries: entries\.slice\(\), leafId: leaf\.id, filtered: false \}/);
  assert.match(index, /cursor = cursor\.parentId \? byId\.get\(cursor\.parentId\) : null/);
  assert.match(index, /const entries = chatView \? activeLeaf\.entries : allEntries/);
});

test("Chat 视图默认 50 条/页并返回游标信息", () => {
  assert.match(index, /Math\.max\(20, Math\.min\(600, Number\.parseInt\(req\.query\.limit, 10\) \|\| 50\)\)/);
  assert.match(index, /const requestedBefore = chatView \? Number\.parseInt\(req\.query\.before, 10\) : NaN/);
  assert.match(index, /historyPageSize: chatView \? chatLimit : undefined/);
  assert.match(index, /activeLeafId: chatView \? activeLeaf\.leafId : undefined/);
  assert.match(index, /activeLeafFiltered: chatView \? activeLeaf\.filtered : undefined/);
});

test("前端保存每会话游标并按 before 续拉", () => {
  assert.match(app, /const sessionHistoryCursorRef = useRef\(new Map\(\)\)/);
  assert.match(app, /const loadOlderSessionHistory = useCallback\(async \(\) => \{/);
  assert.match(app, /getSession\(sessionId, \{ view: "chat", limit: pageSize, before: cursor\.before \}\)/);
  assert.match(app, /before: Number\(info\.historyStart \?\? Math\.max\(0, cursor\.before - pageSize\)\)/);
  assert.match(app, /getSession\(session\.id, \{ view: "chat", limit: 50 \}\)/);
});

test("加载更早先展开本地窗口，再续拉服务端一页", () => {
  assert.match(chatPanel, /const handleLoadOlder = useCallback\(async \(\) => \{/);
  assert.match(chatPanel, /if \(visibleStart > 0\) \{[\s\S]{0,120}setMessageWindowSize\(\(size\) => size \+ MESSAGE_PAGE_SIZE\)/);
  assert.match(chatPanel, /if \(!historyWindow\?\.hasMore \|\| typeof onLoadOlderHistory !== "function"\) return/);
  assert.match(chatPanel, /setMessages\(\(previous\) => \[\.\.\.older, \.\.\.previous\]\)/);
});

test("前插旧消息后恢复滚动锚点，不跳顶", () => {
  assert.match(chatPanel, /scrollAnchorRef\.current = \{ height: el\.scrollHeight, top: el\.scrollTop \}/);
  assert.match(chatPanel, /el\.scrollTop = el\.scrollHeight - anchor\.height \+ anchor\.top/);
  assert.match(chatPanel, /\}, \[messages, messageWindowSize\]\)/);
});

test("App 传递续拉回调与会话 id", () => {
  assert.match(app, /onLoadOlderHistory=\{loadOlderSessionHistory\}/);
  assert.match(app, /sessionId=\{currentSessionId \|\| ""\}/);
});

console.log(failed ? "\nAVA 历史分页测试：存在失败项" : "\nAVA 历史分页测试：全部通过（6 例）");
process.exit(failed ? 1 : 0);
