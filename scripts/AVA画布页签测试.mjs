#!/usr/bin/env node
/**
 * AVA 画布页签测试（v0.13.9）
 *
 * 守护：
 *   1) 画布新增文件树/新会话页签：点开即激活、可关闭；页签体保持挂载、CSS 显隐（切换不卸载）；
 *   2) 文件树三段过滤（全部/代码/网页），点击文件在预览打开，空态提示；
 *   3) 新会话页签复用 handleNewSession（Agent 继承语义）并在创建后聚焦输入；
 *   4) 激活页签偏好持久化（localStorage），宽度受 Resizer 与断点约束。
 *
 * 用法：node scripts/AVA画布页签测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const app = read("client/src/App.jsx");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const filetree = read("client/src/components/文件树页签.jsx");
const newchat = read("client/src/components/新会话页签.jsx");
const styles = read("client/src/styles.css");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("画布新增文件树/新会话页签（点开激活、可关闭、参与 tab 链）", () => {
  assert.match(app, /const \[filesTabOpen, setFilesTabOpen\] = useState\(false\)/);
  assert.match(app, /const \[newchatTabOpen, setNewchatTabOpen\] = useState\(false\)/);
  assert.match(app, /workspaceTabPref === "files" && filesTabOpen \? "files"/, "激活偏好参与 tab 链");
  assert.match(app, /workspaceTabPref === "newchat" && newchatTabOpen \? "newchat"/);
  assert.match(app, /onClick=\{\(\) => \{ setFilesTabOpen\(true\); setWorkspaceTabPref\("files"\); \}\}/);
  assert.match(app, /onClick=\{\(\) => \{ setNewchatTabOpen\(true\); setWorkspaceTabPref\("newchat"\); \}\}/);
  assert.match(app, /onClick=\{\(\) => setFilesTabOpen\(false\)\}/, "文件树页签可关闭");
  assert.match(app, /onClick=\{\(\) => setNewchatTabOpen\(false\)\}/, "新会话页签可关闭");
});

test("页签体保持挂载、CSS 显隐（切换不卸载）", () => {
  assert.match(app, /\{filesTabOpen && \(\n\s*<div className=\{`app-canvas-body canvas-body-files \$\{workspaceTab === "files" \? "" : "canvas-hidden"\}`\}/);
  assert.match(app, /\{newchatTabOpen && \(\n\s*<div className=\{`app-canvas-body canvas-body-newchat \$\{workspaceTab === "newchat" \? "" : "canvas-hidden"\}`\}/);
  assert.match(styles, /\.app-canvas-slot\.canvas-tab-files, \.app-canvas-slot\.canvas-tab-newchat \{ width: var\(--preview-w, 420px\)/, "宽度受约束");
  assert.match(styles, /@media \(max-width: 1024px\) \{\n  \.app-canvas-slot\.canvas-tab-preview \{ min-width: 0; \}\n  \.app-canvas-slot\.canvas-tab-files, \.app-canvas-slot\.canvas-tab-newchat \{ min-width: 0; \}/, "窄屏约束");
});

test("文件树页签：三段过滤 / 点击预览打开 / 空态", () => {
  assert.match(filetree, /\[\["all", "全部"\], \["code", "代码"\], \["web", "网页"\]\]/);
  assert.match(filetree, /onClick=\{\(\) => onOpenFile\?\.\(file\.name\)\}/, "点击文件走预览打开");
  assert.match(filetree, /工作区暂无文件：把文件放进工作区后点击刷新/, "空态提示");
  assert.match(filetree, /aria-selected=\{filter === id\}/, "过滤段 tab 语义");
  assert.match(app, /<文件树页签\n\s*files=\{files\}\n\s*loading=\{loadStatus\?\.files === "loading"\}\n\s*currentName=\{current\?\.name \|\| ""\}\n\s*onOpenFile=\{open\}/);
});

test("新会话页签：复用 handleNewSession + 创建后聚焦输入", () => {
  assert.match(app, /onNewSession=\{async \(\) => \{ await handleNewSession\(currentWorkspaceRef\.current \|\| currentWorkspace\); chatInputRef\.current\?\.focusInput\?\.\(\); \}\}/);
  assert.match(chatPanel, /focusInput\(\) \{\n\s*requestAnimationFrame\(\(\) => textareaRef\.current\?\.focus\(\)\);\n\s*\}/, "ChatPanel 暴露 focusInput 句柄");
  assert.match(newchat, /onSelectSession\?\.\(session\)/, "最近会话可切换");
  assert.match(newchat, /disabled=\{busyCreating\}/, "创建中禁用按钮");
});

test("激活页签偏好持久化（刷新恢复）", () => {
  assert.match(app, /localStorage\.getItem\("oaw_workspace_tab"\) \|\| "preview"/);
  assert.match(app, /localStorage\.setItem\("oaw_workspace_tab", value\)/);
});

console.log(failed ? "\nAVA 画布页签测试：存在失败项" : "\nAVA 画布页签测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
