#!/usr/bin/env node
/**
 * 阶段 0 地基回归：地图只读能力 / 权限模型 / 临时层注册表 / 模式切换
 *
 * 覆盖 2026-10-09-011 阶段 0 的六项交付：
 *   0.1 Chat 模式开放只读地图工具（解 X1 断链）
 *   0.2 map_datasets 只读工具
 *   0.3 共享/工作区图层权限规则
 *   0.4 地图内模式切换（修 X2）
 *   0.6 临时层注册表（修 X5）
 *   0.7 只读工具不得触发审批
 *
 * 这些是源码级断言：约束的是"能力边界不能被后续改动悄悄改掉"，
 * 而不是运行结果正确性（运行结果由 L3 浏览器场景覆盖）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolPolicyForMode } from "../server/task.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const taskSrc = read("server/task.mjs");
const agentSrc = read("server/agent.mjs");
const approvalSrc = read("server/审批策略.mjs");
const mapPanelSrc = read("client/src/components/MapPanel.jsx");
const mapViewerSrc = read("client/src/components/MapViewer.jsx");
const registrySrc = read("client/src/图层注册表.js");
const appSrc = read("client/src/App.jsx");
const stylesSrc = read("client/src/styles.css");
const eventDisplaySrc = read("client/src/事件展示.js");
const brainGraphSrc = read("client/src/components/AgentBrainGraph.jsx");
const conclusionTestSrc = read("scripts/任务结论事件流测试.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

console.log("\n▶ 0.1 Chat 模式开放只读地图工具（解 X1 断链）");

// 白名单一律走真实 API（toolPolicyForMode），不再从源码里正则解析数组：
// 数组里加一行注释就会把朴素的 split(",") 解析打乱（map_read 曾因此误判为缺失）。
function toolArray(name) {
  const mode = { READ_ONLY_TOOLS: "chat", OFFICE_TOOLS: "office", REVIEW_TOOLS: "review", AGENT_TOOLS: "agent" }[name];
  if (!mode) return null;
  return toolPolicyForMode(mode).tools;
}

test("READ_ONLY_TOOLS 含只读五件套", () => {
  const tools = toolArray("READ_ONLY_TOOLS");
  assert.ok(tools, "READ_ONLY_TOOLS 应可解析");
  for (const name of ["map_read", "map_analyze", "map_clear_analysis", "map_datasets", "map_layer_info"]) {
    assert.ok(tools.includes(name), `只读工具应含 ${name}`);
  }
});

test("READ_ONLY_TOOLS 不得含写工具", () => {
  const tools = toolArray("READ_ONLY_TOOLS");
  for (const name of ["map_edit", "map_import", "map_save_analysis", "map_reset", "map_project_create"]) {
    assert.ok(!tools.includes(name), `Chat 模式不应开放写工具 ${name}`);
  }
});

test("AGENT_TOOLS 含全部地图工具", () => {
  const tools = toolArray("AGENT_TOOLS");
  assert.ok(tools, "AGENT_TOOLS 应可解析");
  for (const name of ["map_read", "map_datasets", "map_layer_info", "map_edit", "map_import", "map_analyze", "map_save_analysis", "map_clear_analysis", "map_reset", "map_project_create"]) {
    assert.ok(tools.includes(name), `Work 模式应显式列出 ${name}`);
  }
});

test("Office / Review 模式不暴露地图工具", () => {
  for (const name of ["OFFICE_TOOLS", "REVIEW_TOOLS"]) {
    const tools = toolArray(name) || [];
    const maps = tools.filter((t) => t.startsWith("map_"));
    assert.equal(maps.length, 0, `${name} 不应含地图工具，实际：${maps.join(",")}`);
  }
});

test("地图工具白名单无重复项", () => {
  for (const name of ["READ_ONLY_TOOLS", "AGENT_TOOLS"]) {
    const tools = toolArray(name) || [];
    const dup = tools.filter((t, i) => tools.indexOf(t) !== i);
    assert.equal(dup.length, 0, `${name} 出现重复：${[...new Set(dup)].join(",")}`);
  }
});

console.log("\n▶ 0.2 map_datasets 只读工具");

test("工具已定义且已登记到运行时清单", () => {
  assert.match(agentSrc, /name:\s*"map_datasets"/, "应定义 map_datasets 工具");
  assert.match(agentSrc, /mapReadTool,\s*mapDatasetsTool/, "customTools 应登记 mapDatasetsTool");
  // 工具白名单的唯一来源是 server/task.mjs（agent.mjs 已不再维护第二份清单）。
  const agentTools = toolArray("AGENT_TOOLS") || [];
  assert.ok(agentTools.includes("map_read"), "AGENT_TOOLS 应含 map_read");
  assert.ok(agentTools.includes("map_datasets"), "AGENT_TOOLS 应含 map_datasets");
});

test("工具是只读的：不写文件、不申请审批、不发写事件", () => {
  const start = agentSrc.indexOf('name: "map_datasets"');
  assert.ok(start > 0, "应找到工具定义");
  const body = agentSrc.slice(start, start + 2400);
  assert.doesNotMatch(body, /requireToolApproval/, "只读工具不应申请审批");
  assert.doesNotMatch(body, /write_started|write_locked/, "只读工具不应发写入事件");
  assert.doesNotMatch(body, /writeFileSync|atomicWrite/, "只读工具不应写文件");
});

console.log("\n▶ 0.3 共享 / 工作区图层权限规则");

test("审批规则含共享只读与工作区可写", () => {
  assert.match(approvalSrc, /tool:\s*"map_edit",\s*pattern:\s*"shared\/\*",\s*action:\s*"ask"/, "共享图层改样式应逐次授权");
  assert.match(approvalSrc, /tool:\s*"map_edit",\s*pattern:\s*"workspace\/\*",\s*action:\s*"allow"/, "工作区图层应可直接编辑");
});

test("共享数据集不允许新增文件", () => {
  assert.match(approvalSrc, /tool:\s*"map_import",\s*pattern:\s*"shared\/\*",\s*action:\s*"deny"/, "不应允许往共享数据集导入");
  assert.match(approvalSrc, /tool:\s*"map_save_analysis",\s*pattern:\s*"shared\/\*",\s*action:\s*"deny"/, "不应把分析结果存进共享数据集");
});

test("细分规则位于 catch-all 之后（最后匹配生效）", () => {
  const catchAll = approvalSrc.indexOf('{ tool: "map_edit", pattern: "*", action: "ask" }');
  const shared = approvalSrc.indexOf('{ tool: "map_edit", pattern: "shared/*", action: "ask" }');
  const workspace = approvalSrc.indexOf('{ tool: "map_edit", pattern: "workspace/*", action: "allow" }');
  assert.ok(catchAll > 0 && shared > catchAll && workspace > shared, "细分规则必须排在 catch-all 之后才生效");
});

console.log("\n▶ 0.4 地图内模式切换（修 X2）");

test("MapPanel 接受模式 props 并渲染切换控件", () => {
  assert.match(mapPanelSrc, /conversationMode = "chat",\s*onModeChange/, "应接受 conversationMode / onModeChange");
  assert.match(mapPanelSrc, /className="mp-mode-switch"/, "应渲染地图内模式切换容器");
  assert.match(mapPanelSrc, /mp-mode-option work/, "应有 Work 选项");
});

test("App 把模式传给 MapPanel 且切换走 ChatPanel 的 setMode", () => {
  assert.match(appSrc, /conversationMode=\{conversationMode\}/, "应传入当前模式");
  assert.match(appSrc, /chatInputRef\.current\?\.setMode\?\.\(next\)/, "切换应作用于 ChatPanel 实例");
});

test("模式切换有样式", () => {
  assert.match(stylesSrc, /\.mp-mode-switch \{/, "应有容器样式");
  assert.match(stylesSrc, /\.mp-mode-option\.active \{/, "应有激活态样式");
});

console.log("\n▶ 0.6 临时层注册表（修 X5）");

test("注册表模块导出四个 API", () => {
  for (const fn of ["registerLayerReplay", "unregisterLayerReplay", "replayTemporaryLayers", "clearLayerRegistry"]) {
    assert.match(registrySrc, new RegExp(`export function ${fn}`), `应导出 ${fn}`);
  }
});

test("重放是逐条隔离的（单条失败不连累其它）", () => {
  assert.match(registrySrc, /try \{[\s\S]{0,200}?replay\(map\)[\s\S]{0,200}?catch/, "replay 应被 try/catch 包裹");
});

test("MapViewer 在样式重载后重放，并在卸载时清理", () => {
  assert.match(mapViewerSrc, /replayTemporaryLayers\(map\)/, "applyStyle 完成后应重放临时层");
  assert.match(mapViewerSrc, /clearLayerRegistry\(/, "卸载时应清理注册表");
  // 断言"从注册表模块引入了所需 API"，而不是匹配整条 import 的精确文本
  // （阶段 2 新增了 registerLayerReplay/unregisterLayerReplay，精确文本会误伤）。
  const importLine = mapViewerSrc.split("\n").find((l) => /from "\.\.\/图层注册表\.js"/.test(l)) || "";
  for (const api of ["replayTemporaryLayers", "clearLayerRegistry", "registerLayerReplay"]) {
    assert.ok(importLine.includes(api), `应从注册表模块引入 ${api}，实际：${importLine.trim()}`);
  }
});

test("四处临时层都登记了重放（OD / 等时圈 / 路径 / 绘制）", () => {
  for (const key of ["od", "iso", "route", "draw"]) {
    const m = mapPanelSrc.match(new RegExp(`registerLayerReplay\\(m, "${key}"`));
    assert.ok(m, `临时层 ${key} 应登记重放`);
  }
});

test("主动清除时注销重放（否则会被画回来）", () => {
  const count = (mapPanelSrc.match(/unregisterLayerReplay\(/g) || []).length;
  assert.ok(count >= 3, `清除路径应注销重放（至少 od/iso/draw 三处），实际 ${count} 处`);
});

console.log("\n▶ 0.7 只读工具不得触发审批（防复发）");

// 按下一个工具定义切分实现体。
// 注意：工具变量名（mapSaveAnalysisTool）与 defineTool 调用之间隔着赋值，
// 因此用"下一个 name: \"...\" 出现处"作为边界最稳。
function toolBody(name) {
  const marker = `name: "${name}"`;
  const start = agentSrc.indexOf(marker);
  if (start < 0) return "";
  const after = agentSrc.slice(start + marker.length);
  const nextName = after.indexOf('name: "');
  return nextName > 0 ? after.slice(0, nextName) : after.slice(0, 3000);
}

test("map_read / map_analyze / map_clear_analysis 均无审批调用", () => {
  for (const name of ["map_read", "map_analyze", "map_clear_analysis"]) {
    const body = toolBody(name);
    assert.ok(body, `应找到 ${name} 的实现体`);
    assert.doesNotMatch(body, /requireToolApproval/, `${name} 是只读工具，不应申请审批`);
  }
});

test("写工具仍保留审批", () => {
  for (const name of ["map_edit", "map_import", "map_save_analysis"]) {
    const body = toolBody(name);
    assert.ok(body, `应找到 ${name} 的实现体`);
    assert.match(body, /requireToolApproval/, `${name} 是写工具，必须保留审批`);
  }
});

test("map_datasets 与 map_read 同为只读（无审批）", () => {
  const body = toolBody("map_datasets");
  assert.ok(body, "应找到 map_datasets 的实现体");
  assert.doesNotMatch(body, /requireToolApproval/, "map_datasets 是只读工具");
});

console.log("\n▶ 登记完整性（新增工具必须同步的四处）");

test("事件展示注册表含 map_datasets 图标规则", () => {
  assert.match(eventDisplaySrc, /map_read\|map_datasets\|/, "工具图标规则应含 map_datasets");
});

test("脑图工具分类含 map_datasets", () => {
  assert.match(brainGraphSrc, /map_datasets/, "工具分类表应含 map_datasets");
});

test("任务结论测试的工具映射含 map_datasets", () => {
  assert.match(conclusionTestSrc, /map_datasets: "map"/, "工具→图标映射应含 map_datasets");
});

console.log(failed ? `\n阶段 0 地基回归：失败 ${failed} 项\n` : "\n阶段 0 地基回归：通过\n");
process.exit(failed ? 1 : 0);
