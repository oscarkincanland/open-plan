#!/usr/bin/env node
/**
 * 输入栏与工作区收敛测试（2026-11-03，计划 007）：
 * 1. 输入栏：上下文用量与审批模式并入输入框下方工具条，消息流上方不再有独立横带；
 * 2. 「+」聚合菜单：图片 / 文件 / 地图视图合并到一个入口；
 * 3. 审批模式改为下拉（自动批准 / 每次询问）；
 * 4. 顶栏「工作区」入口改成卡片面板，且每张卡片仍复用既有打开逻辑（不新增页面）。
 *
 * 用法: node scripts/工作区面板与输入栏收敛测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed = 1;
  }
}

const chatPanel = read("client/src/components/ChatPanel.jsx");
const app = read("client/src/App.jsx");
const styles = read("client/src/styles.css");

console.log("\n▶ 输入栏收敛");

test("消息流上方不再有独立横带（上下文/审批并入输入栏）", () => {
  assert.doesNotMatch(chatPanel, /className="chat-topbar"/, "不应再有 .chat-topbar");
  assert.doesNotMatch(chatPanel, /chat-top-controls/, "不应再有 .chat-top-controls");
  assert.doesNotMatch(styles, /^\.chat-topbar \{/m, "不应再有 .chat-topbar 样式");
  // 上下文用量与审批模式都出现在输入框下方的工具条里
  const toolbarStart = chatPanel.indexOf('<div className="chat-toolbar">');
  const toolbarEnd = chatPanel.indexOf("</div>", chatPanel.indexOf("toolbar-session-group"));
  assert.ok(toolbarStart > 0, "应存在输入栏工具条");
  const toolbar = chatPanel.slice(toolbarStart, toolbarEnd > 0 ? toolbarEnd : toolbarStart + 4000);
  assert.match(toolbar, /<ContextUsageRing/, "上下文用量应移入输入栏工具条");
  assert.match(toolbar, /<ApprovalModeControl/, "审批模式应移入输入栏工具条");
});

test("「+」聚合菜单：图片、文件、地图视图合并为一个入口", () => {
  assert.match(chatPanel, /composer-add-menu/, "应有「+」聚合菜单");
  assert.match(chatPanel, /aria-label="添加内容"/, "「+」按钮要有可读标签");
  assert.match(chatPanel, /fileInputRef\.current\?\.click\(\)/, "菜单项应能打开图片选择");
  assert.match(chatPanel, /attInputRef\.current\?\.click\(\)/, "菜单项应能打开附件选择");
  // 图片与附件不再各占一个常驻按钮
  assert.doesNotMatch(chatPanel, /aria-label="上传图片"/, "图片不应再有独立常驻按钮");
  assert.doesNotMatch(chatPanel, /aria-label="上传附件（docx\/xlsx\/pdf\/md\/txt 等）"/, "附件不应再有独立常驻按钮");
});

test("审批模式是下拉选择（自动批准 / 每次询问）", () => {
  assert.match(chatPanel, /approval-mode-menu/, "应有审批模式下拉菜单");
  assert.match(chatPanel, /role="menuitemradio"/, "菜单项应为单选语义");
  assert.match(chatPanel, /pick\("auto"\)/, "应能选择自动批准");
  assert.match(chatPanel, /pick\("ask"\)/, "应能选择每次询问");
  assert.match(styles, /\.approval-mode-menu \{/, "应有下拉菜单样式");
});

test("上下文 chip 为紧凑形态，弹层向上展开且保留压缩入口", () => {
  assert.match(chatPanel, /variant="inline"/, "上下文圈应使用紧凑形态");
  assert.match(styles, /\.context-ring-wrap\.inline \.context-ring-pop \{ top: auto; bottom: calc\(100% \+ 6px\); \}/, "上下文弹层应向上展开");
  assert.match(chatPanel, /onCompact=\{compactContext\}/, "上下文弹层应保留压缩入口");
});

console.log("\n▶ 顶栏工作区面板");

test("顶栏入口是面板而不是下拉菜单", () => {
  assert.match(app, /topbar-tools-panel/, "应有工作区面板");
  assert.match(app, /role="dialog" aria-label="工作区"/, "面板应是 dialog 语义");
  assert.doesNotMatch(app, /className="topbar-tools-menu"/, "不应再有下拉菜单");
  assert.doesNotMatch(styles, /\.topbar-tools-menu \{/, "不应再有下拉菜单样式");
  assert.match(styles, /\.topbar-tools-panel \{/, "应有面板样式");
  assert.match(app, /aria-label="工作区"/, "入口按钮要有可读标签");
});

test("面板只放现有能力，不新增终端或诊断页", () => {
  assert.doesNotMatch(app, /新建终端/, "不应新增终端入口");
  assert.doesNotMatch(app, /会话数据诊断/, "不应新增会话数据诊断入口");
  // 五张主卡片
  for (const label of ["工作区文件", "工作产物", "本轮改动", "内置浏览器", "任务中心"]) {
    assert.ok(app.includes(`<strong>${label}</strong>`), `面板应包含「${label}」卡片`);
  }
});

test("每张卡片仍调用既有打开逻辑（不新增页面类型）", () => {
  assert.match(app, /setCanvasSideOpen\(true\)/, "工作区文件应复用文件树抽屉");
  assert.match(app, /openCanvasView\("artifacts"\)/, "工作产物应复用画布页签");
  assert.match(app, /openCanvasView\("changes"\)/, "本轮改动应复用画布页签");
  assert.match(app, /openCanvasView\("browser"\)/, "内置浏览器应复用画布页签");
  assert.match(app, /taskCenterRef\.current\?\.open\(\)/, "任务中心应复用既有打开入口");
  assert.match(app, /handleNewSession\(undefined, \{ agentId: currentSession\?\.agentId \|\| "" \}\)/, "新建对话应复用既有逻辑");
});

console.log(failed ? "\n工作区面板与输入栏收敛测试：存在失败\n" : "\n工作区面板与输入栏收敛测试：全部通过\n");
process.exit(failed ? 1 : 0);
