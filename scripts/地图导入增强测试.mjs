#!/usr/bin/env node
/**
 * GIS 导入增强测试（T2.4 / T4.1）
 *
 * 覆盖：
 *   1. CSV 点表解析（中英文列名、无效坐标跳过、空表报错）
 *   2. 前端导入入口同时支持 GeoJSON / CSV / SHP / ZIP，并支持拖拽
 *   3. SHP 解析走 shpjs（parseShp + parseDbf），不新增依赖
 *   4. 图层替换 API 先备份旧数据（源码约束）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvPoints } from "../client/src/地图/CSV解析.js";

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

console.log("▶ CSV 点表解析");
test("中文列名（经度/纬度）", () => {
  const r = parseCsvPoints("名称,经度,纬度\n甲,120.1,29.3\n乙,120.2,29.4");
  assert.equal(r.count, 2);
  assert.equal(r.invalid, 0);
  const [first] = r.geojson.features;
  assert.deepEqual(first.geometry.coordinates, [120.1, 29.3]);
  assert.equal(first.properties["名称"], "甲");
});

test("英文列名与制表符分隔", () => {
  const r = parseCsvPoints("name\tlng\tlat\nA\t120.5\t29.5");
  assert.equal(r.count, 1);
  assert.deepEqual(r.geojson.features[0].geometry.coordinates, [120.5, 29.5]);
});

test("无效坐标行跳过并计数", () => {
  const r = parseCsvPoints("lng,lat\n120,29\nabc,29\n200,29\n120,95");
  assert.equal(r.count, 1);
  assert.equal(r.invalid, 3);
});

test("缺少经纬度列与空表给出可读错误", () => {
  assert.throws(() => parseCsvPoints("name,value\n甲,1"), /未找到经纬度列/);
  assert.throws(() => parseCsvPoints("lng,lat"), /至少需要表头/);
});

console.log("▶ 导入入口与 SHP");
test("导入弹窗同时接受 GeoJSON / CSV / SHP / ZIP", () => {
  const src = read("client/src/components/MapPanel.jsx");
  assert.match(src, /accept="\.geojson,\.json,\.zip,\.shp,\.dbf,\.prj,\.cpg,\.csv"/, "文件选择器应接受 CSV");
  assert.match(src, /parseCsvPoints\(await f\.text\(\)/, "CSV 应走统一解析器");
  assert.match(src, /parseShapefile\(shp, f, selected\)/, "SHP 应同时读取 DBF/PRJ/CPG");
  assert.match(src, /\.zip\$\/i\.test\(x\.name\)/, "ZIP 应走 shpjs 解析");
});

test("导入弹窗支持拖拽文件", () => {
  const src = read("client/src/components/MapPanel.jsx");
  assert.match(src, /onDrop=\{(?:\(e\)|e) => \{ e\.preventDefault\(\); handleBatchImport\(e\.dataTransfer\.files\); \}\}/, "导入面板应支持拖拽");
});

test("SHP 解析复用 shpjs（零新增依赖）", () => {
  const src = read("client/src/components/MapViewer.jsx");
  assert.match(src, /shpjs\.parseShp/, "应使用 shpjs.parseShp");
  assert.match(src, /shpjs\.parseDbf/, "应使用 shpjs.parseDbf");
  const pkg = JSON.parse(read("client/package.json"));
  assert.ok(pkg.dependencies?.shpjs || pkg.devDependencies?.shpjs, "shpjs 应在依赖中");
});

console.log("▶ 替换与锁定");
test("替换 API 先把旧数据移入回收站", () => {
  const src = read("server/map.mjs");
  const block = src.slice(src.indexOf("export async function replaceLayer"), src.indexOf("function validateGeoJSON"));
  assert.match(block, /moveLayerToTrash\(name, safeId, "replace"\)/, "替换前应备份");
  assert.match(block, /layer\.replace/, "应写替换日志");
  const index = read("server/index.mjs");
  assert.ok(index.includes("/api/map/project/:name/layer/:layerId/replace"), "应有替换路由");
});

test("Agent 写工具拒绝锁定图层", () => {
  const src = read("server/agent.mjs");
  assert.match(src, /图层已锁定，Agent 不得修改/, "map_edit 应有锁定拒绝");
  assert.match(src, /已锁定，Agent 不得覆盖/, "map_import 应有锁定拒绝");
});

test("审批策略覆盖新增工程级写工具", () => {
  const src = read("server/审批策略.mjs");
  assert.match(src, /tool: "map_reset", pattern: "\*", action: "ask"/, "map_reset 需审批");
  assert.match(src, /tool: "map_project_create", pattern: "\*", action: "ask"/, "map_project_create 需审批");
});

console.log(`\nGIS 导入增强：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error.stack || f.error.message}`);
  process.exit(1);
}
