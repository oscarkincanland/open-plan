#!/usr/bin/env node
/**
 * AVA 输入增强测试（v0.13.4）
 *
 * 守护：
 *   1) 服务端暴露每模型真实支持的 thinkingLevels；
 *   2) 前端 7 档 + 跟随默认，不支持档位置灰；
 *   3) `#` 提及支持技能/插件/文件三组候选，并在发送时解析为引用。
 *
 * 用法：node scripts/AVA输入增强测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const agent = read("server/agent.mjs");
const context = read("server/context.mjs");
const chatPanel = read("client/src/components/ChatPanel.jsx");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("服务端按 thinkingLevelMap 计算可用档位", () => {
  assert.match(agent, /export function thinkingLevelsFor\(model\)/);
  assert.match(agent, /THINKING_LEVEL_ORDER\.filter\(\(level\) => map\[level\] !== null/);
  assert.match(agent, /thinkingLevelsFor\(m\)\.length \? \{ thinkingLevels: thinkingLevelsFor\(m\) \}/);
});

test("跟随默认不改运行时档位", () => {
  assert.match(agent, /const requestedThinkingLevel = effort \|\| "default"/);
  assert.match(agent, /requestedThinkingLevel === "default"/);
  assert.match(agent, /thinkingChanged = requestedThinkingLevel !== "default"/);
});

test("前端包含 7 档 + 跟随默认", () => {
  for (const id of ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.match(chatPanel, new RegExp(`id: "${id}"`), `缺少档位 ${id}`);
  }
  assert.match(chatPanel, /const modelThinkingLevels = useMemo/);
  assert.match(chatPanel, /const availableThinkingOptions = useMemo/);
  assert.match(chatPanel, /className=\{`\$\{item\.id === effort \? "active" : ""\}\$\{disabled \? " disabled" : ""\}`/);
});

test("`#` 触发与三组候选", () => {
  assert.ok(chatPanel.includes("([\\/@&#])"), "缺少 # 触发符");
  assert.ok(chatPanel.includes("if (composerMenu.symbol === \"#\")"), "缺少 # 候选分支");
  assert.match(chatPanel, /#技能\[\$\{value\}\]/);
  assert.match(chatPanel, /#插件\[\$\{value\}\]/);
  assert.match(chatPanel, /#文件\[\$\{value\}\]/);
  assert.match(chatPanel, /\/api\/integrations\/mcp\/servers/);
});

test("服务端解析 # 引用", () => {
  assert.match(context, /#技能\\\[\(\[\^\\\]\]\+\)\\\]/);
  assert.match(context, /#插件\\\[\(\[\^\\\]\]\+\)\\\]/);
  assert.match(context, /#文件\\\[\(\[\^\\\]\]\+\)\\\]/);
  assert.match(context, /"skill", "plugin"/);
});

console.log(failed ? "\nAVA 输入增强测试：存在失败项" : "\nAVA 输入增强测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
