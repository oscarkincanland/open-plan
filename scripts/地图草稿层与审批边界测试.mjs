#!/usr/bin/env node
/**
 * 地图草稿层与审批边界回归（2026-11-07 决策）
 *
 * 覆盖：
 *   1. Chat 不再持有地图工具；地图只在 Work（能力计划/白名单/提示词）。
 *   2. 审批边界：草稿免审批；固化/导入/保存分析/模板/重置必须 ask；
 *      共享/锁定拒绝；auto 模式不得把强制确认类提升为 allow。
 *   3. 草稿层契约：REST 路由、事件登记、工具定义、校验（几何族/中国范围/记录数）。
 *   4. 固化语义：共享/锁定拒绝、失败保留草稿（静态断言 + 纯函数）。
 *
 * 说明：本测试不写 office-workspace（不创建项目/草稿），全部用纯函数与源码契约断言，
 * 以便在只读/受限沙箱下也能跑。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const taskSrc = read("server/task.mjs");
const agentSrc = read("server/agent.mjs");
const mapSrc = read("server/map.mjs");
const indexSrc = read("server/index.mjs");
const approvalSrc = read("server/审批策略.mjs");
const registrySrc = read("server/事件注册表.mjs");
const metaSrc = read("server/工具元数据.mjs");
const mapPanelSrc = read("client/src/components/MapPanel.jsx");
const layerPanelSrc = read("client/src/components/LayerPanel.jsx");
const mapViewerSrc = read("client/src/components/MapViewer.jsx");
const apiSrc = read("client/src/api.js");
const appSrc = read("client/src/App.jsx");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

async function testAsync(name, fn) {
  try { await fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

const { planTaskCapabilities, toolPolicyForMode } = await import("../server/task.mjs");
const { matchToolDecision } = await import("../server/审批策略.mjs");
const { getToolMetadata } = await import("../server/工具元数据.mjs");
const { validateGeoJSON } = await import("../server/map.mjs");

console.log("\n▶ 1. 地图只在 Work（Chat 不保留地图）");

test("Chat 白名单没有任何 map_ 工具", () => {
  const tools = toolPolicyForMode("chat").tools.filter((t) => t.startsWith("map_"));
  assert.equal(tools.length, 0, `Chat 不应含地图工具：${tools.join(",")}`);
});

test("能力计划：chat/office/review 不声明地图，agent 声明", () => {
  const text = "在地图上生成一个点图层";
  for (const mode of ["chat", "office", "review"]) {
    const plan = planTaskCapabilities({ text, task: { mode } });
    assert.equal((plan.capabilities || []).some((c) => c.id === "map"), false, `${mode} 不应声明地图能力`);
    assert.equal(plan.routing.map, "not_needed", `${mode} routing.map 应为 not_needed`);
  }
  const agent = planTaskCapabilities({ text, task: { mode: "agent" } });
  assert.equal(agent.routing.map, "read_write", "agent 应为 read_write");
  assert.ok((agent.capabilities || []).some((c) => c.id === "map"), "agent 应声明地图能力");
});

test("Work 白名单含草稿与固化工具", () => {
  const tools = toolPolicyForMode("agent").tools;
  for (const t of ["map_draft_layer", "map_fixate_layer", "map_save_analysis", "map_import", "map_reset"]) {
    assert.ok(tools.includes(t), `Work 应含 ${t}`);
  }
});

test("MapPanel 不再渲染 Chat/Work 切换", () => {
  assert.doesNotMatch(mapPanelSrc, /mp-mode-switch/, "不应再有模式切换容器");
  assert.doesNotMatch(mapPanelSrc, /Chat：查询地图数据/, "不应再有 Chat 提示文案");
  assert.match(mapPanelSrc, /mp-mode-badge/, "应有固定的 Work 标识");
});

test("App 进入地图前切换 Work", () => {
  assert.match(appSrc, /module === "map" && conversationMode !== "agent"/, "应有 Work 门槛");
  assert.match(appSrc, /setMode\?\.\("agent"\)/, "应切到 Work");
});

console.log("\n▶ 2. 审批边界");

test("草稿工具免审批", () => {
  const decision = matchToolDecision("map_draft_layer", "zhejiang-map");
  assert.equal(decision.action, "allow", "草稿层不应要求审批");
  const meta = getToolMetadata("map_draft_layer");
  assert.equal(meta.needsApproval, false, "元数据 needsApproval 应为 false");
});

test("固化必须 ask，且 auto 模式不提升", () => {
  const decision = matchToolDecision("map_fixate_layer", "zhejiang-map/draft-abc");
  assert.ok(["ask", "deny"].includes(decision.action), `固化不应直接 allow，实际 ${decision.action}`);
  // auto 模式：只有非强制确认类才能被提升；固化属于强制确认。
  assert.ok(approvalSrc.includes("mustConfirmExplicitly"), "审批策略应实现强制确认判定");
  assert.match(approvalSrc, /map_fixate_layer/, "强制确认集合应包含固化");
});

test("导入/保存分析/模板/重置/项目创建都在强制确认集合", () => {
  for (const tool of ["map_import", "map_save_analysis", "map_template", "map_reset", "map_project_create"]) {
    assert.ok(getToolMetadata(tool)?.forceConfirm === true, `${tool} 应标 forceConfirm`);
  }
});

test("共享数据集禁止固化 / 保存分析", () => {
  assert.match(approvalSrc, /tool:\s*"map_fixate_layer",\s*pattern:\s*"shared\/\*",\s*action:\s*"deny"/, "固化应拒绝共享数据集");
  assert.match(approvalSrc, /tool:\s*"map_save_analysis",\s*pattern:\s*"shared\/\*",\s*action:\s*"deny"/, "保存分析应拒绝共享数据集");
});

test("工具元数据与审批策略一致（needsApproval 类）", () => {
  for (const tool of ["map_fixate_layer", "map_import", "map_save_analysis", "map_reset", "map_project_create", "map_template"]) {
    assert.equal(getToolMetadata(tool)?.needsApproval, true, `${tool} 元数据应 needsApproval`);
  }
});

console.log("\n▶ 3. 草稿层契约");

test("map.mjs 导出草稿 API", () => {
  for (const fn of ["createDraft", "updateDraft", "deleteDraft", "listDrafts", "readDraft", "confirmDraft", "draftSummary", "cleanupDrafts"]) {
    assert.match(mapSrc, new RegExp(`export (?:async )?function ${fn}\\b`), `应导出 ${fn}`);
  }
});

test("草稿存在 agent/drafts，且不进入正式图层目录", () => {
  assert.match(mapSrc, /const DRAFTS_DIR = "drafts"/, "草稿目录常量");
  assert.match(mapSrc, /path\.join\(dir, AGENT_DIR, DRAFTS_DIR\)/, "草稿应写 agent/drafts");
  assert.match(mapSrc, /DRAFTS_DIR && \//, "文件树应跳过草稿目录");
});

test("REST 路由齐备且固化要求 confirmed", () => {
  for (const route of [
    'app.get("/api/map/project/:name/drafts"',
    'app.get("/api/map/project/:name/drafts/:id"',
    'app.post("/api/map/project/:name/drafts"',
    'app.patch("/api/map/project/:name/drafts/:id"',
    'app.delete("/api/map/project/:name/drafts/:id"',
    'app.post("/api/map/project/:name/drafts/:id/confirm"',
  ]) {
    assert.ok(indexSrc.includes(route), `缺少路由 ${route}`);
  }
  assert.match(indexSrc, /req\.body\?\.confirmed !== true/, "固化必须校验 confirmed:true");
  assert.match(indexSrc, /MAP_CONFIRM_REQUIRED/, "缺确认应返回 MAP_CONFIRM_REQUIRED");
});

test("事件登记：map_draft_changed / confirmed / discarded", () => {
  for (const type of ["map_draft_changed", "map_draft_confirmed", "map_draft_discarded"]) {
    assert.match(registrySrc, new RegExp(`type: "${type}"`), `应登记 ${type}`);
  }
  assert.match(registrySrc, /map_draft_changed[\s\S]{0,120}persist: false/, "changed 不落盘");
  assert.match(registrySrc, /map_draft_confirmed[\s\S]{0,120}persist: true/, "confirmed 落盘审计");
});

test("Agent 工具定义 + 运行时注册", () => {
  assert.match(agentSrc, /name: "map_draft_layer"/, "应定义 map_draft_layer");
  assert.match(agentSrc, /name: "map_fixate_layer"/, "应定义 map_fixate_layer");
  assert.match(agentSrc, /mapDraftLayerTool, mapFixateLayerTool/, "应注册到 customTools");
});

test("固化走 importLayer（事务化）而非直接写文件", () => {
  const start = mapSrc.indexOf("export async function confirmDraft");
  assert.ok(start > 0, "应找到 confirmDraft");
  const body = mapSrc.slice(start, start + 5200);
  assert.match(body, /await importLayer\(/, "固化应复用 importLayer");
  assert.match(body, /MAP_SHARED_DENIED/, "固化应拒绝共享数据集");
  assert.match(body, /MAP_LAYER_LOCKED/, "固化应拒绝锁定图层");
  assert.match(body, /fs\.rmSync\(draftFile/, "固化成功后应删除草稿");
});

test("前端草稿链路：API + 面板 + 地图渲染", () => {
  for (const api of ["mapDrafts", "mapDraftConfirm", "mapDraftDiscard"]) {
    assert.match(apiSrc, new RegExp(`export const ${api} =`), `api.js 应导出 ${api}`);
  }
  assert.match(mapPanelSrc, /loadDrafts/, "MapPanel 应加载草稿");
  assert.match(mapPanelSrc, /handleConfirmDraft/, "MapPanel 应有固化处理");
  assert.match(layerPanelSrc, /草稿层（待确认）/, "LayerPanel 应展示草稿分组");
  assert.match(mapViewerSrc, /showDrafts/, "MapViewer 应支持草稿渲染");
  assert.match(mapViewerSrc, /showDraftLayers\(map, draftListRef\.current\)/, "样式重载后应重放草稿");
});

console.log("\n▶ 4. 校验纯函数（几何族 / 中国范围 / 记录数）");

const pointFc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [120.1, 29.3] }, properties: {} }] };
const pointFc2 = { type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "Point", coordinates: [120.1, 29.3] }, properties: {} },
  { type: "Feature", geometry: { type: "Point", coordinates: [120.2, 29.4] }, properties: {} },
] };
const lineFc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[120.1, 29.3], [120.2, 29.4]] }, properties: {} }] };
const outsideFc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [139.7, 35.6] }, properties: {} }] };

test("合法点位通过并返回几何族", () => {
  const stats = validateGeoJSON(pointFc, { geometryType: "point" });
  assert.equal(stats.features, 1);
  assert.equal(stats.geometryType, "point");
});

test("几何族不符拒绝", () => {
  assert.throws(() => validateGeoJSON(lineFc, { geometryType: "point" }), /几何类型不符/);
});

test("混用几何类型拒绝", () => {
  const mixed = { type: "FeatureCollection", features: [...pointFc.features, ...lineFc.features] };
  assert.throws(() => validateGeoJSON(mixed), /混用几何类型/);
});

test("中国范围外坐标拒绝（AGENTS §6）", () => {
  assert.throws(() => validateGeoJSON(outsideFc), /越出中国范围|经纬度范围/);
});

test("expectedCount 不一致拒绝（data_integrity）", () => {
  assert.throws(() => validateGeoJSON(pointFc2, { expectedCount: 5 }), /记录数不一致/);
});

test("记录数一致通过", () => {
  const stats = validateGeoJSON(pointFc2, { expectedCount: 2 });
  assert.equal(stats.features, 2);
});

test("要素数上限拒绝", () => {
  assert.throws(() => validateGeoJSON(pointFc2, { maxFeatures: 1 }), /超过上限/);
});

console.log(failed === 0 ? "\n✓ 地图草稿层与审批边界回归：通过" : `\n✗ 地图草稿层与审批边界回归：失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
