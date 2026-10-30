#!/usr/bin/env node
/**
 * AVA 附件与工作区菜单测试（v0.13.8）
 *
 * 守护：
 *   1) 音视频附件：白名单（mp4/webm/mov、mp3/wav/m4a）、100MB 上限、mediaKind 分类、超限提示；
 *   2) 全区域拖拽：chat-compose 容器整体 onDragOver/onDrop，高亮遮罩提示；
 *   3) 附件卡片：类型图标（play/audio）与大小展示；
 *   4) 工作区菜单：创建新任务 / 在资源管理器打开 / 归档（仅移除记录，不删除磁盘文件）。
 *
 * 用法：node scripts/AVA附件测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const sidebar = read("client/src/components/SessionSidebar.jsx");
const app = read("client/src/App.jsx");
const icon = read("client/src/components/Icon.jsx");
const styles = read("client/src/styles.css");
const api = read("client/src/api.js");

// 行为级断言：直接执行 媒体工具.js 纯函数
const media = await import(`file://${path.join(ROOT, "client/src/components/媒体工具.js").replace(/\\/g, "/")}`);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("行为：媒体类型判定与大小格式化", () => {
  assert.equal(media.mediaKindFor("会议记录.mp4"), "video");
  assert.equal(media.mediaKindFor("采访.webm"), "video");
  assert.equal(media.mediaKindFor("语音备忘.m4a"), "audio");
  assert.equal(media.mediaKindFor("说明.mp3"), "audio");
  assert.equal(media.mediaKindFor("报告.docx"), "document");
  assert.equal(media.formatBytes(1024 * 1024), "1.0MB");
  assert.equal(media.formatBytes(999), "999B");
  assert.equal(media.formatBytes(1024 * 1024 * 1024 * 2.5), "2.5GB");
  assert.equal(media.ATTACHMENT_SIZE_LIMIT, 100 * 1024 * 1024, "100MB 上限");
  assert.ok(media.ATTACHMENT_ALLOWED_EXT.test("演示.mp4"));
  assert.ok(media.ATTACHMENT_ALLOWED_EXT.test("录音.wav"));
  assert.ok(!media.ATTACHMENT_ALLOWED_EXT.test("程序.exe"), "可执行文件不在白名单");
});

test("附件通道：白名单引用媒体工具，超限与不支持类型有提示", () => {
  assert.match(chatPanel, /import \{ ATTACHMENT_SIZE_LIMIT, ATTACHMENT_ALLOWED_EXT, mediaKindFor, formatBytes \} from "\.\/媒体工具\.js";/);
  assert.match(chatPanel, /f\.size > ATTACHMENT_SIZE_LIMIT/, "超限文件跳过");
  assert.match(chatPanel, /已跳过 \$\{skipped\.length\} 个文件：/, "跳过提示文案");
  assert.match(chatPanel, /mediaKind: mediaKindFor\(f\.name\)/, "附件记录媒体分类");
});

test("全区域拖拽：输入区容器整体接受拖入并显示高亮遮罩", () => {
  assert.match(chatPanel, /className=\{`chat-compose\$\{dragActive \? " drag-active" : ""\}`\}/);
  assert.match(chatPanel, /onDragEnter=\{\(e\) => \{ e\.preventDefault\(\); dragDepthRef\.current \+= 1; setDragActive\(true\); \}\}/);
  assert.match(chatPanel, /onDrop=\{\(e\) => \{ e\.preventDefault\(\); dragDepthRef\.current = 0; setDragActive\(false\); handleFiles\(e\.dataTransfer\?\.files \|\| \[\]\); \}\}/);
  assert.match(chatPanel, /className="compose-drag-mask" role="status"/);
  assert.match(styles, /\.compose-drag-mask \{/, "遮罩样式");
  assert.match(styles, /\.chat-compose\.drag-active \{ outline/, "容器高亮");
});

test("附件卡片：类型图标与大小展示", () => {
  assert.match(chatPanel, /att\.mediaKind === "video" \? "play" : att\.mediaKind === "audio" \? "audio" : "file"/);
  assert.match(chatPanel, /\{att\.size \? <span className="att-size">\{formatBytes\(att\.size\)\}<\/span> : null\}/);
  assert.match(chatPanel, /视频附件，不自动播放/, "视频不自动播放提示");
  assert.match(icon, /^\s{2}play: \(/m, "play 图标已注册");
  assert.match(icon, /^\s{2}audio: \(/m, "audio 图标已注册");
});

test("工作区菜单：创建新任务 / 资源管理器打开 / 归档（不删磁盘）", () => {
  assert.match(sidebar, /const \[projectMenuId, setProjectMenuId\] = useState\(null\)/);
  assert.match(sidebar, /aria-haspopup="menu"/, "菜单按钮菜单语义");
  assert.match(sidebar, /onCreateTask\?\.\(project\)/, "创建新任务回调");
  assert.match(sidebar, /if \(project\.rootPath\) handleRevealInFileManager\(project\.rootPath\)/, "在资源管理器打开");
  assert.match(sidebar, /仅移除记录，不删除磁盘文件/, "归档确认文案明确不删磁盘");
  assert.match(sidebar, /archiveProject\(project\.id, true\)/);
  assert.match(sidebar, /if \(project\.id === currentProjectId\) \{/, "归档当前项目回退其他工作区");
  assert.match(api, /export const archiveProject = \(id, archived = true\)/);
  assert.match(app, /onCreateTask=\{\(project\) => \{ handleNewSession\(project\?\.rootPath \|\| undefined\); \}\}/);
});

console.log(failed ? "\nAVA 附件与工作区菜单测试：存在失败项" : "\nAVA 附件与工作区菜单测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
