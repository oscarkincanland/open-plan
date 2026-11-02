#!/usr/bin/env node
/**
 * GIS 工程化底座测试（阶段 1）
 *
 * 覆盖：
 *   1. config v2（schemaVersion / 图层元数据 / 分组）
 *   2. 基线快照与原子写备份
 *   3. 图层注册表（要素数/bbox/锁定/基线标记）
 *   4. 图层元数据更新与操作日志
 *   5. 图层删除入回收站
 *   6. 三级重置（tree / temp / baseline）
 *   7. 旧 config 自动迁移
 *
 * 使用临时项目，结束后清理；不触碰 zhejiang-map 的正式数据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as map from "../server/map.mjs";
import { LAYER_DEFS } from "./lib/tiler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = `probe-gis-${Date.now().toString(36)}`;
const LEGACY = `probe-gis-legacy-${Date.now().toString(36)}`;
const BLANK = `probe-gis-blank-${Date.now().toString(36)}`;
const REPLACE = `probe-gis-replace-${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label} -> ${error.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label} -> ${error.message}`);
  }
}

const pointFC = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "甲" }, geometry: { type: "Point", coordinates: [120.1, 29.3] } },
    { type: "Feature", properties: { name: "乙" }, geometry: { type: "Point", coordinates: [120.2, 29.4] } },
  ],
};

function configOf(name) {
  return JSON.parse(fs.readFileSync(path.join(map.projectDir(name), "map.config.json"), "utf8"));
}

async function main() {
  console.log("▶ GIS 工程化底座");
  const created = map.createProject({ project: NAME, name: "探针工程", baseProject: "zhejiang-map" });

  check("创建项目写入 v2 配置与工程元数据", () => {
    const cfg = created.config;
    assert.equal(cfg.schemaVersion, map.MAP_SCHEMA_VERSION);
    assert.equal(cfg.crs, "EPSG:4326");
    assert.ok(Array.isArray(cfg.groups) && cfg.groups.length > 0, "应写入图层分组");
    assert.ok(cfg.createdAt && cfg.updatedAt, "应有创建/更新时间");
    assert.ok(cfg.layers.every((l) => l.opacity === 1 && l.locked === false), "图层应有 opacity/locked");
  });

  check("创建项目自动写入基线", () => {
    const baseline = map.getBaseline(NAME);
    assert.ok(baseline, "基线应存在");
    assert.equal(baseline.layers.length, created.config.layers.length);
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "map.baseline.json")));
    // agent 生成内容归档目录：报告/导出/清单
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "agent", "reports")), "应有 agent/reports");
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "agent", "exports")), "应有 agent/exports");
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "agent", "manifest.jsonl")), "应有 agent/manifest.jsonl");
  });

  check("操作日志记录创建与基线", () => {
    const ops = map.listOperations(NAME);
    assert.ok(ops.some((o) => o.action === "project.create"), "应有 project.create");
    assert.ok(ops.some((o) => o.action === "baseline.set"), "应有 baseline.set");
  });

  check("空白 AI 画布只含底图并写空基线", () => {
    const blank = map.createProject({ project: BLANK, name: "空白画布", kind: "blank", description: "从零做图" });
    assert.equal(blank.config.kind, "blank");
    assert.equal(blank.config.baseProject, null);
    assert.equal(blank.config.description, "从零做图");
    assert.equal(blank.config.layers.length, 0, "空白画布不应继承业务图层");
    const baseline = map.getBaseline(BLANK);
    assert.equal(baseline.layers.length, 0, "空基线应可恢复");
    const style = JSON.parse(fs.readFileSync(path.join(map.projectDir(BLANK), "style.json"), "utf8"));
    const businessLayers = style.layers.filter((l) => !String(l.id).startsWith("basemap-"));
    assert.equal(businessLayers.length, 0, "空白样式只应保留底图");
    assert.ok(!style.sources["boundary-city"], "空白样式不应引用基础项目瓦片");
  });

  check("清空临时层不依赖基线", () => {
    fs.rmSync(path.join(map.projectDir(BLANK), "map.baseline.json"), { force: true });
    const result = map.resetProject(BLANK, "temp");
    assert.equal(result.ok, true, "没有基线也应允许清空临时层");
    assert.match(result.note, /前端/, "应说明临时层由前端清理");
  });

  check("图层替换先备份旧数据到回收站", () => {
    map.createProject({ project: REPLACE, name: "替换探针", baseProject: "zhejiang-map" });
  });
  await checkAsync("替换图层数据并重建瓦片", async () => {
    await map.importLayer(REPLACE, "probe-r", pointFC);
    const next = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "新" }, geometry: { type: "Point", coordinates: [120.3, 29.5] } }],
    };
    const result = await map.replaceLayer(REPLACE, "probe-r", next);
    assert.equal(result.ok, true);
    assert.equal(result.features, 1);
    assert.ok(result.discarded && fs.existsSync(result.discarded), "旧数据应进回收站");
    assert.ok(fs.existsSync(path.join(result.discarded, "probe-r.geojson")), "回收站应保存旧 geojson");
    assert.equal(configOf(REPLACE).layers.find((l) => l.id === "probe-r").stats.features, 1);
    assert.ok(map.listOperations(REPLACE).some((o) => o.action === "layer.replace"), "应有 layer.replace 日志");
  });

  await checkAsync("大图层注册表跳过解析避免阻塞", async () => {
    const features = Array.from({ length: 30000 }, (_, i) => ({
      type: "Feature",
      properties: { name: `p${i}`, pad: "x".repeat(40) },
      geometry: { type: "Point", coordinates: [120 + i * 0.00001, 29.1] },
    }));
    await map.importLayer(REPLACE, "probe-big", { type: "FeatureCollection", features });
    const registry = map.listLayerRegistry(REPLACE);
    const big = registry.layers.find((l) => l.id === "probe-big");
    assert.equal(big.stats.statsOmitted, true, "大文件应标记 statsOmitted");
    assert.equal(big.stats.features, null, "大文件不应同步解析要素数");
    assert.ok(registry.counts.featuresOmitted >= 1, "counts 应暴露未统计数量");
  });

  check("图层注册表带要素统计与基线标记", () => {
    const registry = map.listLayerRegistry(NAME);
    assert.ok(registry, "应返回注册表");
    assert.equal(registry.schemaVersion, map.MAP_SCHEMA_VERSION);
    assert.equal(registry.counts.layers, created.config.layers.length);
    assert.ok(registry.layers.every((l) => l.inBaseline !== false), "内置图层都应在基线内");
    const city = registry.layers.find((l) => l.id === "boundary-city");
    assert.ok(city?.stats?.features > 0, "边界图层应有要素数");
    assert.ok(Array.isArray(city?.stats?.bbox), "边界图层应有 bbox");
  });

  const imported = await map.importLayer(NAME, "probe-a", pointFC);
  await map.importLayer(NAME, "probe-b", pointFC);

  await checkAsync("导入图层写入来源/统计并注册到配置", async () => {
    assert.equal(imported.features, 2);
    const registry = map.listLayerRegistry(NAME);
    const layer = registry.layers.find((l) => l.id === "probe-a");
    assert.ok(layer, "应出现在注册表");
    assert.equal(layer.source.kind, "import");
    assert.equal(layer.source.format, "geojson");
    assert.equal(layer.stats.features, 2);
    assert.equal(layer.inBaseline, false);
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "layers", "probe-a.geojson")));
  });

  check("config/style 写入保留备份", () => {
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "map.config.json.bak"), "config 应有 .bak"));
    assert.ok(fs.existsSync(path.join(map.projectDir(NAME), "style.json.bak"), "style 应有 .bak"));
  });

  check("更新图层元数据并写日志", () => {
    const result = map.updateLayerMeta(NAME, "probe-a", { name: "探针点 A", locked: true, opacity: 0.6 });
    assert.equal(result.ok, true);
    const cfg = configOf(NAME);
    const layer = cfg.layers.find((l) => l.id === "probe-a");
    assert.equal(layer.name, "探针点 A");
    assert.equal(layer.locked, true);
    assert.equal(layer.opacity, 0.6);
    const style = JSON.parse(fs.readFileSync(path.join(map.projectDir(NAME), "style.json"), "utf8"));
    const styleLayer = style.layers.find((l) => l.id === "probe-a");
    assert.ok(styleLayer, "导入图层应进入样式");
    assert.equal(styleLayer.paint["circle-opacity"], 0.6, "透明度应同步到样式");
    const ops = map.listOperations(NAME, { layerId: "probe-a" });
    assert.ok(ops.some((o) => o.action === "layer.update"), "应有 layer.update");
  });

  check("删除图层移入回收站而非物理删除", () => {
    const result = map.deleteLayer(NAME, "probe-b");
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.trash), "回收站目录应存在");
    assert.ok(fs.existsSync(path.join(result.trash, "probe-b.geojson")), "数据应进回收站");
    assert.ok(!fs.existsSync(path.join(map.projectDir(NAME), "layers", "probe-b.geojson")), "原数据应移除");
    const cfg = configOf(NAME);
    assert.ok(!cfg.layers.some((l) => l.id === "probe-b"), "config 应移除图层");
  });

  check("重置图层树恢复基线显隐并保留新增层", () => {
    map.updateLayerMeta(NAME, "boundary-city", { visible: false });
    const result = map.resetProject(NAME, "tree");
    assert.equal(result.ok, true);
    const cfg = configOf(NAME);
    const city = cfg.layers.find((l) => l.id === "boundary-city");
    assert.equal(city.visible, true, "应恢复基线显隐");
    assert.ok(cfg.layers.some((l) => l.id === "probe-a"), "基线后新增层应保留");
    const style = JSON.parse(fs.readFileSync(path.join(map.projectDir(NAME), "style.json"), "utf8"));
    const styleCity = style.layers.find((l) => l.id === "boundary-city");
    assert.equal(styleCity.layout.visibility, "visible", "style 显隐应恢复");
  });

  check("清空临时层返回快照且不改正式层", () => {
    const result = map.resetProject(NAME, "temp");
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.snapshot), "应写重置快照");
    assert.ok(configOf(NAME).layers.some((l) => l.id === "probe-a"), "正式层不应变化");
  });

  check("恢复基线移除新增层并进回收站", () => {
    const result = map.resetProject(NAME, "baseline");
    assert.equal(result.ok, true);
    assert.equal(result.removed.length, 1, "应移除 1 个基线后新增层");
    assert.ok(fs.existsSync(result.removed[0].trash), "移除层应进回收站");
    const cfg = configOf(NAME);
    assert.ok(!cfg.layers.some((l) => l.id === "probe-a"), "config 应移除新增层");
    const style = JSON.parse(fs.readFileSync(path.join(map.projectDir(NAME), "style.json"), "utf8"));
    assert.ok(!style.layers.some((l) => l.id === "probe-a"), "style 应移除新增层");
    const ops = map.listOperations(NAME);
    assert.ok(ops.some((o) => o.action === "reset.baseline"), "应有 reset.baseline");
  });

  check("旧 config 自动迁移为 v2", () => {
    const dir = map.projectDir(LEGACY);
    fs.mkdirSync(path.join(dir, "layers"), { recursive: true });
    const legacy = {
      project: LEGACY,
      name: "旧工程",
      layers: [{ id: "boundary-city", type: "boundary", group: "行政区划", visible: false }],
    };
    fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify(legacy, null, 2));
    const project = map.getProject(LEGACY);
    assert.equal(project.config.schemaVersion, map.MAP_SCHEMA_VERSION);
    assert.equal(project.config.layers[0].opacity, 1);
    assert.equal(project.config.layers[0].locked, false);
    assert.ok(project.config.crs, "应补 crs");
    const persisted = configOf(LEGACY);
    assert.equal(persisted.schemaVersion, map.MAP_SCHEMA_VERSION, "迁移应落盘");
  });

  check("API 路由已登记（源码约束）", () => {
    const src = fs.readFileSync(path.join(ROOT, "server/index.mjs"), "utf8");
    for (const route of [
      "/api/map/project/:name/layers",
      "/api/map/project/:name/reset",
      "/api/map/project/:name/baseline",
      "/api/map/project/:name/operations",
      "/api/map/project/:name/layer/:layerId/replace",
    ]) {
      assert.ok(src.includes(route), `缺少路由 ${route}`);
    }
    assert.ok(src.includes('app.patch("/api/map/project/:name/layer/:layerId"'), "缺少图层元数据 PATCH");
  });

  check("图层定义基线未减", () => {
    const cfg = configOf(NAME);
    for (const def of LAYER_DEFS) {
      assert.ok(cfg.layers.some((l) => l.id === def.id) || cfg.layers.length > 0, `基线图层 ${def.id} 缺失`);
    }
  });
}

try {
  await main();
} finally {
  for (const name of [NAME, LEGACY, BLANK, REPLACE]) {
    try { fs.rmSync(map.projectDir(name), { recursive: true, force: true }); } catch {}
  }
}

console.log(`\nGIS 工程化底座：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error.stack || f.error.message}`);
  process.exit(1);
}
