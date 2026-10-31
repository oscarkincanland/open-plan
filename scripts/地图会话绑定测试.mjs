#!/usr/bin/env node
/**
 * 地图会话绑定回归（第一阶段）
 *
 * 覆盖：
 *   1. mergeMapContext：视口上报不丢地图项目；新项目覆盖旧项目；视口 project 兜底。
 *   2. normalizeMapView：白名单字段与非法值过滤。
 *   3. 源码接线：App 合并上下文、MapPanel initialProject 同步、MapViewer 上报 project、
 *      Agent 提示词/参数描述以“当前任务地图项目”为准。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeMapContext, normalizeMapView, MAP_CONTEXT_VIEW_KEYS } from "../client/src/地图/地图上下文.js";
import * as map from "../server/map.mjs";
import { buildMapContextPatch } from "../server/会话地图上下文.mjs";
import { buildMapReport } from "../server/地图报告.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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
async function testAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label} -> ${error.message}`);
  }
}

console.log("▶ 上下文合并");

test("视口上报不丢地图项目", () => {
  const prev = { mapProject: "yiwu-ai", center: [120.1, 29.3], zoom: 10, updatedAt: 1 };
  const next = mergeMapContext(prev, {
    center: [120.2, 29.4],
    zoom: 11,
    bounds: [120.1, 29.2, 120.3, 29.5],
    updatedAt: 2,
  });
  assert.equal(next.mapProject, "yiwu-ai", "纯视口上报不能覆盖项目");
  assert.deepEqual(next.center, [120.2, 29.4]);
  assert.equal(next.zoom, 11);
  assert.deepEqual(next.bounds, [120.1, 29.2, 120.3, 29.5]);
  assert.equal(next.updatedAt, 2);
});

test("新建项目覆盖旧项目", () => {
  const next = mergeMapContext({ mapProject: "zhejiang-map" }, { mapProject: "yiwu-ai" });
  assert.equal(next.mapProject, "yiwu-ai");
  assert.equal(mergeMapContext({ mapProject: "zhejiang-map" }, { mapProject: "  " }).mapProject, "zhejiang-map", "空项目不应清空已有绑定");
});

test("视口 payload 的 project 可作为项目兜底", () => {
  const next = mergeMapContext({}, { project: "yiwu-ai", zoom: 9 });
  assert.equal(next.mapProject, "yiwu-ai");
});

test("白名单外字段被忽略", () => {
  assert.ok(MAP_CONTEXT_VIEW_KEYS.includes("center"));
  const normalized = normalizeMapView({ mapProject: "x", tempLayers: [{ id: "t" }], center: [120, 29] });
  assert.equal("mapProject" in normalized, false, "normalizeMapView 不处理项目");
  assert.equal("tempLayers" in normalized, false, "临时层不应进入持久化视口");
  assert.deepEqual(normalized.center, [120, 29]);
});

test("非法视口字段被忽略", () => {
  assert.deepEqual(normalizeMapView({ center: [120, 29, 30], zoom: "abc", bounds: [1, 2, 3] }), {});
  assert.deepEqual(normalizeMapView(null), {});
  const numeric = normalizeMapView({ center: ["120.1", "29.3"], zoom: "10.5" });
  assert.deepEqual(numeric.center, [120.1, 29.3]);
  assert.equal(numeric.zoom, 10.5);
});

test("空上下文安全", () => {
  assert.deepEqual(mergeMapContext(undefined, undefined), { mapProject: "" });
  assert.deepEqual(mergeMapContext(null, { center: [120, 29] }).mapProject, "");
});

console.log("▶ 源码接线");

test("App 用合并上下文替换整条覆盖", () => {
  const app = read("client/src/App.jsx");
  assert.match(app, /mergeMapContext\(prev\[threadId\], context\)/, "视口回调应合并上下文");
  assert.ok(!app.includes("[threadId]: context }"), "不应再用整条视口覆盖会话上下文");
  assert.match(app, /initialProject=\{currentMapProject\}/, "应把会话项目传给地图面板");
});

test("MapPanel 从会话恢复项目并上报 project", () => {
  const panel = read("client/src/components/MapPanel.jsx");
  assert.match(panel, /initialProject = ""/, "应接受 initialProject");
  assert.match(panel, /useState\(initialProject \|\| "zhejiang-map"\)/, "初始项目应优先会话记录");
  assert.match(panel, /setProject\(target\)/, "会话项目变化应切换画布");
  assert.match(panel, /onViewportChange\?\.\(\{ \.\.\.context, project,/, "视口上报应带 project");
});

test("MapViewer 视口 payload 带 project", () => {
  const viewer = read("client/src/components/MapViewer.jsx");
  assert.match(viewer, /viewportCallbackRef\.current\(\{\s*\/\/[^\n]*\n\s*project,/, "视口 payload 应含 project");
});

test("Agent 提示词与描述以当前任务项目为准", () => {
  const agent = read("server/agent.mjs");
  assert.ok(agent.includes("当前任务指定 `mapProject` 时一律使用任务项目"), "系统提示应声明任务项目优先");
  assert.ok(agent.includes("缺省使用当前任务的地图项目"), "工具参数应声明任务项目优先");
  assert.ok(!agent.includes("默认项目 zhejiang-map 浙江省交通地图"), "不应再写死默认项目");
  assert.ok(!agent.includes('description: "项目名，默认 zhejiang-map"'), "参数描述不应再写死默认项目");
});

console.log("▶ 项目文件树与 agent 归档");
const PROJECT = `probe-bind-${Date.now().toString(36)}`;
const WORKSPACE = path.join(ROOT, "office-workspace");
let projectRoot = null;
try {
  map.createProject({ project: PROJECT, name: "绑定探针", kind: "blank" });
  projectRoot = map.projectDir(PROJECT);

  test("新建项目自动创建 agent 目录与清单", () => {
    assert.ok(fs.existsSync(path.join(projectRoot, "agent", "reports")), "应有 agent/reports");
    assert.ok(fs.existsSync(path.join(projectRoot, "agent", "exports")), "应有 agent/exports");
    assert.ok(fs.existsSync(path.join(projectRoot, "agent", "manifest.jsonl")), "应有 agent/manifest.jsonl");
  });

  test("manifest 追加记录生成来源", () => {
    assert.equal(map.appendAgentManifest(PROJECT, { action: "analysis", layerId: "heat-1", paths: ["layers/heat-1.geojson"] }), true);
    const lines = fs.readFileSync(path.join(projectRoot, "agent", "manifest.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.action, "analysis");
    assert.deepEqual(entry.paths, ["layers/heat-1.geojson"]);
    assert.equal(entry.layerId, "heat-1");
  });

  test("项目文件树列出 agent 内容并跳过 tiles/.trash", () => {
    fs.mkdirSync(path.join(projectRoot, "tiles", "probe"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "tiles", "probe", "0.pbf"), "x");
    fs.mkdirSync(path.join(projectRoot, ".trash"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".trash", "old.geojson"), "{}");
    const tree = map.listProjectFiles(PROJECT);
    assert.ok(tree, "应返回文件树");
    const paths = tree.files.map((file) => file.rel);
    assert.ok(paths.includes("map.config.json"), "应含项目配置");
    assert.ok(paths.includes("agent/manifest.jsonl"), "应含 agent 清单");
    assert.ok(tree.files.some((file) => file.dir === "agent"), "agent 文件应带所属目录");
    assert.ok(!paths.some((item) => item.startsWith("tiles/")), "不应列出瓦片");
    assert.ok(!paths.some((item) => item.startsWith(".trash/")), "不应列出回收站");
    assert.equal(tree.truncated, false);
  });

  test("文件树按文件夹搜索与截断", () => {
    const filtered = map.listProjectFiles(PROJECT, { q: "agent" });
    assert.ok(filtered.files.length > 0, "搜索应有结果");
    assert.ok(filtered.files.every((file) => file.rel.toLowerCase().includes("agent")), "q 应匹配目录+文件名");
    const truncated = map.listProjectFiles(PROJECT, { maxFiles: 1 });
    assert.equal(truncated.truncated, true, "超过上限应标记截断");
  });

  test("非法项目名不返回文件树", () => {
    assert.equal(map.listProjectFiles("../evil"), null);
  });

  await testAsync("地图报告落项目 agent/reports", async () => {
    const result = await buildMapReport({
      workspace: WORKSPACE,
      project: PROJECT,
      title: "绑定探针报告",
      sections: [{ heading: "摘要", bullets: ["文件树与归档自检"] }],
    });
    assert.ok(fs.existsSync(result.file), "报告应落盘");
    const normalizedFile = String(result.file).replace(/\\/g, "/");
    assert.ok(normalizedFile.includes("agent/reports"), `报告应落在项目 agent/reports（实际 ${result.file}）`);
    const manifest = fs.readFileSync(path.join(projectRoot, "agent", "manifest.jsonl"), "utf8");
    assert.match(manifest, /"action":"report"/, "报告应写入清单");
  });
} finally {
  if (projectRoot) {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}

console.log("▶ 会话地图上下文校验");

test("服务端只接收视口白名单与项目名", () => {
  const patch = buildMapContextPatch({
    mapProject: "  yiwu-ai  ",
    mapView: { center: [120, 29], zoom: 10, bounds: [1, 2, 3, 4], tempLayers: [1], mapProject: "x" },
  });
  assert.equal(patch.mapProject, "yiwu-ai");
  assert.deepEqual(patch.mapView.center, [120, 29]);
  assert.equal(patch.mapView.zoom, 10);
  assert.deepEqual(patch.mapView.bounds, [1, 2, 3, 4]);
  assert.equal("tempLayers" in patch.mapView, false, "临时层不应写进 header");
  assert.equal("mapProject" in patch.mapView, false, "视口不应携带项目");
  const invalid = buildMapContextPatch({ mapView: { center: [1], zoom: "abc", bounds: [1, 2, 3] } });
  assert.deepEqual(invalid.mapView, {});
});

console.log("▶ 文件树与初始页预览接线");

test("地图面板接入文件树", () => {
  const panel = read("client/src/components/MapPanel.jsx");
  assert.match(panel, /fileTreeOpen/, "应有文件树开关");
  assert.match(panel, /地图文件树/, "应渲染文件树浮层");
  const tree = read("client/src/components/地图文件树.jsx");
  assert.match(tree, /mapProjectTree/, "项目页签应走项目树接口");
  assert.match(tree, /insertChatText\?\.\(`@maps\//, "@ 应插入项目相对路径");
  assert.match(tree, /searchFiles/, "工作区页签应支持搜索");
  assert.match(read("client/src/api.js"), /mapProjectTree/, "应封装项目树接口");
});

test("项目切换为单向同步，避免双写循环", () => {
  const panel = read("client/src/components/MapPanel.jsx");
  assert.match(panel, /const changeProject = useCallback/, "应有用户切换项目的唯一入口");
  assert.match(panel, /onProjectChange\?\.\(next\)/, "用户切换项目应通知会话");
  assert.doesNotMatch(panel, /onProjectChange\?\.\(project\)/, "会话回填不应反向通知");
  assert.match(panel, /changeProject\(id\)/, "项目菜单应走统一入口");
});

test("初始页选择地图会话打开只读地图预览", () => {
  const mini = read("client/src/components/MiniMapPreview.jsx");
  assert.match(mini, /readOnly/, "小地图应只读");
  assert.match(mini, /initialView/, "小地图应恢复上次视口");
  const app = read("client/src/App.jsx");
  assert.match(app, /updateSessionMapContext/, "应持久化会话地图上下文");
  assert.match(app, /openCanvasView\("mapPreview"/, "选择地图会话时应打开地图预览标签");
  assert.match(app, /<MiniMapPreview/, "地图预览标签应渲染只读小地图");
  assert.match(app, /onOpen=\{\(\) => setActiveModule\("map"\)\}/, "继续编辑应进入地图模块");
  const state = read("client/src/画布状态.js");
  assert.match(state, /mapPreview/, "画布状态应登记地图预览单例标签");
  assert.match(app, /tab\.kind !== "mapPreview"/, "无地图绑定的会话应关闭过期预览");
});

test("服务端登记 tree 与 map-context 路由", () => {
  const index = read("server/index.mjs");
  assert.ok(index.includes('"/api/map/project/:name/tree"'), "应有项目文件树路由");
  assert.ok(index.includes('"/api/sessions/:id/map-context"'), "应有会话地图上下文路由");
  assert.ok(index.includes("mapProject: meta.mapProject"), "会话列表应回传地图项目");
});

console.log(`\n地图会话绑定：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error.stack || failure.error.message}`);
  process.exit(1);
}
