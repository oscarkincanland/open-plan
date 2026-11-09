#!/usr/bin/env node
/**
 * 地图预览草稿回放与视口一致性回归（计划 2026-11-09-002 §4.3 / §4.4 / §4.6）
 *
 * 只做“源码接线断言 + 纯数据结构断言”，不渲染 React、不创建真实地图项目、
 * 不读写 office-workspace：
 *   1. MiniMapPreview 接入 mapDrafts/mapDraft、visible 过滤、上限 20、错误降级、drafts 传 MapViewer；
 *   2. 预览保持只读（无固化/编辑入口、不传 onViewportChange）；
 *   3. MapPanel 透传会话视口 initialView；MapViewer 建图前应用、卸载补报、只读不上报；
 *   4. SessionSidebar / SettingsPanel 归档恢复回调接线。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const MINI = read("client/src/components/MiniMapPreview.jsx");
const PANEL = read("client/src/components/MapPanel.jsx");
const VIEWER = read("client/src/components/MapViewer.jsx");
const SIDEBAR = read("client/src/components/SessionSidebar.jsx");
const SETTINGS = read("client/src/components/SettingsPanel.jsx");

let passed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label} -> ${error.message}`);
  }
}

/** 服务端 draftSummary 的字段形状（本地 fixture，不导入服务端模块以免落盘）。 */
function draftSummaryFixture(id, extra = {}) {
  return {
    id,
    project: "probe-preview",
    name: `草稿 ${id}`,
    geometryType: "point",
    features: 2,
    bbox: [120, 29, 120.1, 29.1],
    demo: false,
    source: "agent",
    style: { color: "#2563eb", dashed: true },
    status: "pending",
    visible: true,
    revision: 1,
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    ...extra,
  };
}

console.log("▶ 预览草稿数据源");

test("预览从 api.js 取草稿列表与详情，且不引入任何写接口", () => {
  assert.match(MINI, /from "\.\.\/api\.js"/, "应复用 api.js 封装");
  assert.match(MINI, /\bmapDrafts\b/, "应使用 mapDrafts 取列表");
  assert.match(MINI, /\bmapDraft\b/, "应使用 mapDraft 取单条 geojson");
  for (const forbidden of ["mapDraftConfirm", "mapDraftDiscard", "mapDraftUpdate", "mapSaveStyle", "mapImportLayer", "mapSaveConfig"]) {
    assert.ok(!MINI.includes(forbidden), `预览不应引入写接口 ${forbidden}`);
  }
});

test("列表接口 + 逐条详情：geojson 由详情补齐", () => {
  assert.match(MINI, /await mapDrafts\(project\)/, "列表按项目拉取");
  assert.match(MINI, /await mapDraft\(project, draft\.id\)/, "按 id 逐条取 geojson");
  assert.match(MINI, /const geojson = full\?\.draft\?\.geojson \|\| null/, "详情失败时 geojson 为 null");
  assert.match(MINI, /\.\.\.draft,\s*geojson,\s*style: full\?\.draft\?\.style \|\| draft\.style/, "应把摘要与详情合并成 MapViewer 需要的形状");
});

test("只回放 visible !== false 的草稿", () => {
  assert.match(MINI, /\.filter\(\(draft\) => draft && draft\.visible !== false\)/, "隐藏草稿不应进入预览");
});

test("草稿回放上限 20 条并提示截断", () => {
  assert.match(MINI, /export const MAX_PREVIEW_DRAFTS = 20/, "应声明上限常量");
  assert.match(MINI, /list\.slice\(0, MAX_PREVIEW_DRAFTS\)/, "只取前 20 条");
  assert.match(MINI, /truncated: list\.length > MAX_PREVIEW_DRAFTS/, "超限应标记截断");
  assert.match(MINI, /仅显示前 \{MAX_PREVIEW_DRAFTS\} 个/, "超限应给出提示文案");
});

test("草稿失败降级为提示 + 重试，不阻塞正式层", () => {
  assert.match(MINI, /草稿加载失败/, "应有明确的失败文案");
  assert.match(MINI, /setDraftRetryToken\(\(value\) => value \+ 1\)/, "应提供重试入口");
  assert.match(MINI, /role="status"/, "失败提示应可被读屏感知");
  // 正式层（config / MapViewer）在草稿失败时仍然渲染：失败分支只改状态，不提前 return 掉地图。
  assert.match(MINI, /\{error \? \([\s\S]{0,200}?\) : !config \?/, "地图渲染分支不受草稿错误影响");
  assert.match(MINI, /list\.length > 0 && usable\.length === 0 \? "草稿加载失败" : ""/, "全部详情失败才算整体失败");
});

test("草稿随 refreshToken 重跑，切换项目即清空", () => {
  assert.match(MINI, /\}, \[project, refreshToken, draftRetryToken\]\);/, "草稿加载应随项目/刷新令牌/重试变化");
  assert.match(MINI, /prev\.project === project/, "同项目刷新保留草稿，切换项目清空");
  assert.match(MINI, /const drafts = sameProject \? draftState\.items : EMPTY_DRAFTS/, "切换项目当帧不显示旧项目草稿");
});

test("drafts 传给 MapViewer，且预览保持只读", () => {
  assert.match(MINI, /drafts=\{drafts\}/, "草稿应交给 MapViewer 渲染");
  assert.match(MINI, /\breadOnly\b/, "小地图必须只读");
  assert.ok(!MINI.includes("onViewportChange"), "预览不得上报视口（只读）");
  for (const forbidden of ["onConfirmDraft", "onDiscardDraft", "onEditDraftStyle", "onToggleDraft"]) {
    assert.ok(!MINI.includes(forbidden), `预览不应出现写/固化入口：${forbidden}`);
  }
  assert.match(MINI, /不提供固化\/编辑入口/, "注释应声明只读边界");
});

test("头部显示草稿计数（未固化）", () => {
  assert.match(MINI, /草稿 \{draftTotal\}（未固化）/, "头部应显示草稿数量与未固化标记");
  assert.match(MINI, /草稿只读显示，固化请到地图模块/, "应说明固化要到地图模块");
});

test("MapViewer 侧按 id/visible/样式重放草稿（数据形状对得上）", () => {
  assert.match(VIEWER, /const payload = draft\.geojson/, "MapViewer 读 draft.geojson");
  assert.match(VIEWER, /const visible = draft\.visible !== false/, "MapViewer 读 draft.visible");
  assert.match(VIEWER, /const st = draft\.style && typeof draft\.style === "object"/, "MapViewer 读 draft.style");
  assert.match(VIEWER, /dashed \? \{ "line-dasharray": \[2, 1\] \}/, "草稿应以虚线绘制");
  // 合并后的草稿至少要有 MapViewer 需要的键，否则小地图会静默丢层。
  const summary = draftSummaryFixture("draft-a");
  const merged = { ...summary, geojson: { type: "FeatureCollection", features: [] }, style: summary.style };
  for (const key of ["id", "geojson", "visible", "style", "geometryType"]) {
    assert.ok(key in merged, `合并后的草稿应含 ${key}`);
  }
});

console.log("▶ 地图模块视口一致性");

test("MapPanel 把会话视口作为 initialView 透传给 MapViewer", () => {
  assert.match(PANEL, /const sessionInitialView = useMemo/, "应从 mapContext 派生 initialView");
  assert.match(PANEL, /const center = mapContext\?\.center/, "应读取会话视口中心");
  assert.match(PANEL, /initialView=\{sessionInitialView\}/, "建图时应传入会话视口");
});

test("切换项目后不套用旧项目的视口", () => {
  assert.match(PANEL, /if \(boundProject && boundProject !== project\) return null/, "项目不一致时不使用旧视口");
});

test("项目切换仍是单向同步（不反向覆盖会话）", () => {
  assert.match(PANEL, /const changeProject = useCallback/, "用户切换项目应保持唯一入口");
  assert.match(PANEL, /onProjectChange\?\.\(next\)/, "用户切换项目通知会话");
  assert.doesNotMatch(PANEL, /onProjectChange\?\.\(project\)/, "会话回填不应反向通知");
});

test("MapViewer 在建图前应用 initialView，首次上报即真实相机", () => {
  assert.match(VIEWER, /center: initialView\?\.center \|\| config\?\.center \|\| \[120\.0, 29\.2\]/, "initialView 应作为建图相机");
  assert.match(VIEWER, /zoom: initialView\?\.zoom \|\| config\?\.zoom \|\| 7/, "initialView 应作为建图缩放");
  assert.match(VIEWER, /会话视口（initialView）已在建图参数里应用/, "应保留“应用后再上报”的说明");
});

test("MapViewer 卸载时补报最后一次真实视口", () => {
  assert.match(VIEWER, /const lastViewportRef = useRef\(null\)/, "应缓存最后一次视口");
  assert.match(VIEWER, /try \{ lastViewportRef\.current = readViewport\(\); \} catch \{\}/, "移动结束应同步缓存真实视口");
  assert.match(VIEWER, /useEffect\(\(\) => \(\) => \{[\s\S]{0,400}?callback\(\{ \.\.\.pending, updatedAt: Date\.now\(\) \}\)/, "卸载清理应补报一次");
  assert.match(VIEWER, /String\(pending\.project \|\| ""\) !== String\(projectRef\.current \|\| ""\)/, "补报前应确认项目一致，避免旧项目相机写到新项目");
});

test("只读预览不上报视口", () => {
  assert.match(VIEWER, /const readOnlyRef = useRef\(readOnly\)/, "只读状态应可选");
  assert.match(VIEWER, /if \(readOnlyRef\.current\) return;/, "只读模式应跳过视口上报");
});

console.log("▶ 归档恢复联动");

test("SessionSidebar 恢复会话成功后回调上层", () => {
  assert.match(SIDEBAR, /onArchive, onBatchArchive, onRestored,/, "SessionList 应接受 onRestored");
  assert.match(SIDEBAR, /const sessionsRef = useRef\(sessions\)/, "应用最新会话列表查找恢复后的对象");
  assert.match(SIDEBAR, /const restored = \(sessionsRef\.current \|\| \[\]\)\.find\(\(item\) => item\.id === session\.id\) \|\| session/, "应找到恢复后的会话对象");
  assert.match(SIDEBAR, /onRestored\?\.\(restored\)/, "应回调上层会话对象");
  assert.match(SIDEBAR, /onRestored=\{onRestoredSession\}/, "侧栏应把 onRestoredSession 透传给会话列表");
});

test("SettingsPanel 单个/批量恢复后回调会话 id", () => {
  assert.match(SETTINGS, /function ArchiveSettingsSection\(\{ onSessionsChanged, onRestoredSession \}\)/, "归档区应接受回调");
  assert.match(SETTINGS, /onRestoredSession\?\.\(\[id\]\)/, "单个恢复应回传会话 id 数组");
  assert.match(SETTINGS, /onRestoredSession\?\.\(Array\.isArray\(result\?\.restoredIds\) \? result\.restoredIds : \[\]\)/, "批量恢复应回传 restoredIds");
  assert.match(SETTINGS, /<ArchiveSettingsSection onSessionsChanged=\{onSessionsChanged\} onRestoredSession=\{onRestoredSession\} \/>/, "设置面板应透传回调");
  assert.match(SETTINGS, /onSessionsChanged, onRestoredSession, onModelChange/, "SettingsPanel 应接受 onRestoredSession prop");
});

console.log(`\n地图预览草稿回放：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error.stack || failure.error.message}`);
  process.exit(1);
}
