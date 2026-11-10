#!/usr/bin/env node
/**
 * 工作区切换失败保留会话回归测试（2026-11-10 / 计划 2026-11-10-002 块 4）。
 *
 * 背景缺陷：App.jsx handleWorkspaceChange 在调用服务端之前就清空会话历史/预览标签，
 * 切换失败（目录不存在、不可写、点了失效项目）后聊天区历史被清空，
 * 用户表现为"整个项目历史崩溃"。
 *
 * 覆盖：
 *   A. 前端时序契约：会话/历史/预览标签的清空必须发生在 switchWorkspace 成功之后，
 *      catch 分支不得触碰会话状态；
 *   B. 后端契约：/api/workspace/create 仅允许在已存在父目录下新建一层；
 *   C. 项目列表契约：listProjects 返回 rootMissing 标记，前端据此拦截失效项目切换；
 *   D. 新建项目表单契约：不选新文件夹（existing:true）时不得静默切换/关面板。
 *
 * 用法: node scripts/工作区切换失败保留会话回归测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

/** 提取 handleWorkspaceChange 函数体（useCallback 起止） */
function extractWorkspaceChange(appSource) {
  const start = appSource.indexOf("const handleWorkspaceChange = useCallback");
  assert.ok(start >= 0, "App.jsx 中必须存在 handleWorkspaceChange");
  const endMarker = "}, [currentWorkspace, handleNewSession, refreshFiles, refreshProjects]);";
  const end = appSource.indexOf(endMarker, start);
  assert.ok(end > start, "handleWorkspaceChange 依赖数组不完整");
  return appSource.slice(start, end + endMarker.length);
}

console.log("\n▶ A. 切换失败不丢会话（前端时序契约）");

const appSource = read("client/src/App.jsx");
const fnBody = extractWorkspaceChange(appSource);

test("会话清空必须位于 switchWorkspace 成功之后", () => {
  const switchIdx = fnBody.indexOf("await switchWorkspace(requestedPath)");
  assert.ok(switchIdx > 0, "缺少 switchWorkspace 调用");
  for (const marker of ["clearDocumentTabs();", "setHistoryMessages(null);", "setHistoryWindow(null);", "setCurrentSessionId(null);"]) {
    const idx = fnBody.indexOf(marker);
    assert.ok(idx > switchIdx, `${marker} 必须出现在 switchWorkspace 之后（失败路径不得清空会话）`);
  }
});

test("try 之前（失败可达路径）不得清空会话状态", () => {
  const tryIdx = fnBody.indexOf("try {");
  const before = fnBody.slice(0, tryIdx);
  for (const marker of ["clearDocumentTabs();", "setHistoryMessages(", "setHistoryWindow(", "setCurrentSessionId("]) {
    assert.ok(!before.includes(marker), `try 之前不得出现 ${marker}`);
  }
});

test("catch 分支只恢复目录/文件并提示错误，不触碰会话", () => {
  const catchIdx = fnBody.indexOf("} catch (e) {");
  assert.ok(catchIdx > 0, "缺少 catch 分支");
  const catchBody = fnBody.slice(catchIdx);
  assert.ok(catchBody.includes("setFiles(previousFiles);"), "失败必须恢复原文件列表");
  assert.ok(catchBody.includes("setWorkspaceSwitchError("), "失败必须给出错误提示");
  for (const marker of ["clearDocumentTabs", "setHistoryMessages", "setCurrentSessionId"]) {
    assert.ok(!catchBody.includes(marker), `catch 分支不得包含 ${marker}`);
  }
});

test("失败恢复仍包含原目录恢复（previousDir）", () => {
  const catchIdx = fnBody.indexOf("} catch (e) {");
  const catchBody = fnBody.slice(catchIdx);
  assert.ok(catchBody.includes("setCurrentDir(previousDir);"), "失败必须恢复原目录");
});

console.log("\n▶ B. 新建文件夹接口契约（后端）");

const serverSource = read("server/index.mjs");

test("/api/workspace/create 存在且只建一层", () => {
  const start = serverSource.indexOf('app.post("/api/workspace/create"');
  assert.ok(start >= 0, "缺少 /api/workspace/create 路由");
  const end = serverSource.indexOf("// POST /api/workspace/validate", start);
  const body = serverSource.slice(start, end);
  assert.ok(body.includes("path.isAbsolute(raw)"), "必须要求绝对路径");
  assert.ok(body.includes("该文件夹已存在"), "目标已存在必须拒绝");
  assert.ok(body.includes("上级目录不存在"), "父目录缺失必须拒绝");
  assert.ok(body.includes("recursive: false"), "必须只允许创建一层（不递归）");
  assert.ok(body.includes("evaluateWorkspaceWrite"), "创建后必须复用可写探针");
  assert.ok(!body.includes("rmSync") && !body.includes("rmdirSync") && !body.includes("unlink"), "创建接口不得包含删除操作");
});

const apiSource = read("client/src/api.js");
test("前端 API 暴露 createWorkspaceFolder", () => {
  assert.match(apiSource, /export const createWorkspaceFolder = \(path\) =>/);
  assert.match(apiSource, /\/api\/workspace\/create/);
});

console.log("\n▶ C. 失效项目防护契约");

const projectManagerSource = read("server/项目管理.mjs");
test("listProjects 返回 rootMissing 标记", () => {
  assert.match(projectManagerSource, /rootMissing: rootPathMissing\(project\.rootPath\)/);
  assert.match(projectManagerSource, /function rootPathMissing/);
});

const sidebarSource = read("client/src/components/SessionSidebar.jsx");
test("项目卡与切换器对 rootMissing 项目拦截静默切换", () => {
  const rootMissingCount = (sidebarSource.match(/rootMissing/g) || []).length;
  assert.ok(rootMissingCount >= 5, `侧栏应有多处 rootMissing 防护（当前 ${rootMissingCount} 处）`);
  assert.match(sidebarSource, /项目目录已不存在/);
});

console.log("\n▶ D. 新建项目表单契约（不选新文件夹不静默切换）");

const settingsSource = read("client/src/components/SettingsPanel.jsx");
test("existing:true 分支不得调用 onProjectSelect / setCreateOpen(false)", () => {
  const createStart = settingsSource.indexOf("const create = async () => {");
  assert.ok(createStart > 0, "缺少 create 函数");
  const createEnd = settingsSource.indexOf("const classify = async () => {", createStart);
  const createBody = settingsSource.slice(createStart, createEnd);
  const existingIdx = createBody.indexOf("if (result.existing) {");
  assert.ok(existingIdx > 0, "create 必须显式处理 result.existing");
  const existingBranch = createBody.slice(existingIdx, createBody.indexOf("}", createBody.indexOf("return;", existingIdx)));
  assert.ok(!existingBranch.includes("onProjectSelect"), "existing 分支不得静默切换项目");
  assert.ok(!existingBranch.includes("setCreateOpen(false)"), "existing 分支不得关闭表单");
  assert.ok(existingBranch.includes("setExistingProject"), "existing 分支必须就地提示已存在项目");
});

test("表单提供选择文件夹/新建文件夹/切换现有项目入口", () => {
  assert.match(settingsSource, /pickProjectFolder/, "缺少选择文件夹逻辑");
  assert.match(settingsSource, /createProjectFolder/, "缺少新建文件夹逻辑");
  assert.match(settingsSource, /选择文件夹/);
  assert.match(settingsSource, /新建文件夹/);
  assert.match(settingsSource, /切换到现有项目/);
  assert.match(settingsSource, /createSeed/, "缺少侧栏直达 seed 接线");
});

test("侧栏\"+\"直达选择文件夹", () => {
  assert.match(sidebarSource, /handleNewProjectPick/, "缺少侧栏直达处理函数");
  const start = sidebarSource.indexOf("const handleNewProjectPick = async () => {");
  const body = sidebarSource.slice(start, start + 800);
  assert.ok(body.includes("result.canceled"), "取消选择不得报错");
  assert.ok(body.includes('onOpenSettings?.("project", result.workspace)'), "选完必须带路径打开创建表单");
});

console.log(`\n${failed ? "✗ 测试失败" : "✓ 全部通过"}\n`);
process.exit(failed);
