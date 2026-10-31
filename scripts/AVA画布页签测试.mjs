#!/usr/bin/env node
/**
 * 工作区画布测试（浏览器式标签）
 *
 * 守护：
 *   1) 画布状态纯函数：文档去重、单例视图、关闭相邻、标签上限；
 *   2) 单画布外壳：一个宽度变量、一个主拖拽条，不再有双面板；
 *   3) 文档标签提升到画布顶部，DocViewer 不再渲染内部标签栏；
 *   4) 文件树抽屉识别目录、进入子目录、面包屑返回；
 *   5) 工作产物内部有任务摘要、产物/链接分段；
 *   6) 新建对话是 + 菜单动作，不再占画布标签。
 *
 * 用法：node scripts/AVA画布页签测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocTab, createViewTab, openCanvasTab, closeCanvasTab, reorderCanvasTabs, MAX_CANVAS_TABS } from "../client/src/画布状态.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const app = read("client/src/App.jsx");
const drawer = read("client/src/components/文件树抽屉.jsx");
const tabbar = read("client/src/components/画布标签栏.jsx");
const panel = read("client/src/components/工作产物面板.jsx");
const docViewer = read("client/src/components/DocViewer.jsx");
const docxViewer = read("client/src/components/DocxViewer.jsx");
const excelGrid = read("client/src/components/ExcelGrid.jsx");
const styles = read("client/src/styles.css");
const pkg = JSON.parse(read("package.json"));

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("画布状态：文档去重、单例视图、关闭相邻、标签上限", () => {
  let state = openCanvasTab([], createDocTab("a", "A.md"));
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, "doc:a");
  state = openCanvasTab(state.tabs, createDocTab("a", "A.md"));
  assert.equal(state.tabs.length, 1, "同一文档不应重复开标签");
  state = openCanvasTab(state.tabs, createDocTab("b", "B.md"));
  state = openCanvasTab(state.tabs, createViewTab("artifacts"));
  state = openCanvasTab(state.tabs, createViewTab("artifacts"));
  assert.equal(state.tabs.filter((tab) => tab.kind === "artifacts").length, 1, "单例视图只保留一个");
  const closed = closeCanvasTab(state.tabs, state.activeId, "doc:b");
  assert.equal(closed.tabs.length, state.tabs.length - 1);
  assert.notEqual(closed.activeId, "doc:b", "关闭当前标签后应选相邻标签");
  let many = [];
  for (let i = 0; i < MAX_CANVAS_TABS + 3; i += 1) many = openCanvasTab(many, createDocTab(`d${i}`, `D${i}.md`)).tabs;
  assert.equal(many.length, MAX_CANVAS_TABS, "标签数量应受上限约束");
  const reordered = reorderCanvasTabs(state.tabs, "doc:b", "doc:a");
  assert.equal(reordered[0].id, "doc:b", "拖拽排序应移动标签");
});

test("单画布外壳：一个容器、一个宽度、一个主拖拽条，无双面板", () => {
  assert.match(app, /const \[canvasTabs, setCanvasTabs\] = useState\(\[\]\)/);
  assert.match(app, /const canvasOpen = canvasTabs\.length > 0 && !canvasCollapsed/);
  assert.match(app, /<画布标签栏/);
  assert.match(app, /onReorder=\{\(fromId, toId\) => setCanvasTabs/, "App 必须接上拖拽排序回调");
  assert.match(app, /cssVar="--canvas-w"/, "画布使用统一宽度");
  assert.match(app, /cssVar="--canvas-side-w"/, "文件树抽屉有独立宽度");
  assert.doesNotMatch(app, /dualPanePref|dualPaneActive|dual-pane/, "不应再有双面板状态/类名");
  assert.doesNotMatch(styles, /dual-pane/, "不应再有双面板样式");
  assert.doesNotMatch(app, /const \[previewOpen, setPreviewOpen\]|const \[browserPanelOpen, setBrowserPanelOpen\]/,
    "不应再保留四个独立画布开关");
});

test("浏览器式标签栏：关闭、收起、最大化、+ 菜单", () => {
  assert.match(tabbar, /className="canvas-tabbar"/);
  assert.match(tabbar, /onClose\?\.\(tab\.id\)/, "标签可关闭");
  assert.match(tabbar, /onCollapse/, "有收起画布动作");
  assert.match(tabbar, /onToggleMaximize/, "有最大化动作");
  assert.match(tabbar, /任务摘要/);
  assert.match(tabbar, /代码变更/);
  assert.match(tabbar, /新建对话/);
  assert.match(tabbar, /最近地图会话/, "保留 GIS 地图会话入口");
  assert.doesNotMatch(tabbar, /终端/, "不提供终端死入口");
});

test("标签溢出菜单、快捷键与未保存标记", () => {
  assert.match(tabbar, /canvas-overflow-menu/, "标签溢出菜单存在");
  assert.match(tabbar, /已打开标签 · \{tabs\.length\}/);
  assert.match(tabbar, /event\.key === "Tab"/, "Ctrl+Tab 切换");
  assert.match(tabbar, /canvas-tab-dirty/);
  assert.match(app, /onDirtyChange=\{handleDocDirtyChange\}/);
  assert.match(app, /askConfirm\(`「\$\{tab\.title \|\| "文档"\}」有未保存修改/, "关闭未保存文档需确认");
  assert.match(docViewer, /onDirtyChange/);
  assert.match(docxViewer, /onDirtyChange/);
  assert.match(excelGrid, /onDirtyChange/);
  assert.match(excelGrid, /setDirty\(true\)/, "Excel 编辑标记 dirty");
  assert.match(excelGrid, /setDirty\(false\)/, "Excel 保存/刷新清除 dirty");
});

test("文档标签提升到画布顶部，DocViewer 不再渲染内部标签栏", () => {
  assert.match(app, /createDocTab\(id, name\)/);
  assert.match(app, /openCanvasTab\(prev, docTab\)/);
  assert.match(docViewer, /hideTabBar = false/);
  assert.match(docViewer, /\{!hideTabBar && tabs\.length > 0 && \(/);
  assert.match(app, /hideTabBar/);
});

test("文件树抽屉：识别目录、进入子目录、面包屑返回", () => {
  assert.match(app, /import 文件树抽屉 from "\.\/components\/文件树抽屉\.jsx"/);
  assert.doesNotMatch(app, /import 文件树页签/);
  assert.match(drawer, /fetch\(`\/api\/files\?\$\{params\.toString\(\)\}`/);
  assert.match(drawer, /entry\.isDir/);
  assert.match(drawer, /setDir\(relPath\)/, "点击目录应进入子目录");
  assert.match(drawer, /breadcrumb\(dir\)/);
  assert.match(drawer, /返回上一级/);
  assert.match(drawer, /onOpenFile\?\.\(relPath\)/, "点击文件应打开预览");
});

test("工作产物：任务摘要 + 产物/链接分段", () => {
  assert.match(panel, /export function ArtifactPanel/);
  assert.match(panel, /export function RunChangesPanel/);
  assert.match(panel, /export function LinksPanel/);
  assert.match(panel, /function ArtifactSummaryCard/);
  assert.match(panel, /artifact-run-summary/);
  assert.match(panel, /function ArtifactSegmentBar/);
  assert.match(panel, /segment === "links"/, "链接分段存在");
  assert.match(panel, /<LinksPanel links=\{links\} \/>/, "链接并入工作产物");
  assert.doesNotMatch(app, /\['links', '链接'\]/, "链接不再是一级标签");
  assert.doesNotMatch(app, /preview-panel-tabs/, "不再有内层预览/改动/产物/链接标签");
});

test("持久化：画布标签、宽度、抽屉", () => {
  assert.match(app, /loadCanvasState\(currentWorkspace\)/);
  assert.match(app, /saveCanvasState\(currentWorkspace/);
  const stateModule = read("client/src/画布状态.js");
  assert.match(stateModule, /oaw_canvas_v2/);
  assert.match(stateModule, /oaw_canvas_w/);
  assert.match(stateModule, /oaw_canvas_side_w/);
  assert.match(stateModule, /pendingDocRestoreRef|payload\?\.name/, "恢复文档标签需要保留文件名");
});

test("新建对话是菜单动作，不是画布标签", () => {
  assert.match(tabbar, /onNewChat/);
  assert.doesNotMatch(app, /新会话页签/);
  assert.match(app, /handleNewSession\(currentWorkspaceRef\.current \|\| currentWorkspace\)/);
  assert.equal(pkg.scripts["test:ava-dualpane"], undefined, "双面板测试脚本应移除");
});

console.log(failed ? "\n工作区画布测试：存在失败项" : "\n工作区画布测试：全部通过（9 例）");
process.exit(failed ? 1 : 0);
