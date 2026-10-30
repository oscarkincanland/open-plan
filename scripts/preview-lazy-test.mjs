#!/usr/bin/env node
/**
 * P3-c Excel 预览 sheet 懒加载守护测试（开关 previewLazySheets / OAW_PREVIEW_LAZY_SHEETS，默认关）：
 * 校验开关注册与快照下发、服务端单表构建与 LRU 缓存、懒加载路由门控、
 * 客户端懒加载页签接线（默认关 = 整簿一次解析，与基线一致）。
 * 用法: node scripts/preview-lazy-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const flagsSource = read("server/运行开关.mjs");
const serverSource = read("server/index.mjs");
const gridSource = read("client/src/components/ExcelGrid.jsx");
const viewerSource = read("client/src/components/DocViewer.jsx");
const urlsSource = read("client/src/文件地址.js");
const stylesSource = read("client/src/styles.css");
const pkg = JSON.parse(read("package.json"));

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
const test = (name, fn) => { try { fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); } };

console.log("\n▶ 开关注册");
test("服务端开关 previewLazySheets 注册且默认关", () => {
  assert.match(flagsSource, /previewLazySheets: readFlag\("OAW_PREVIEW_LAZY_SHEETS"\)/);
  assert.doesNotMatch(flagsSource, /previewLazySheets: readFlagWithDefault/);
});
test("快照下发 previewLazySheets", () => {
  assert.match(flagsSource, /previewLazySheets: RUNTIME_FLAGS\.previewLazySheets/);
});

console.log("\n▶ 服务端接线");
test("单表构建器抽出且整簿构建复用（输出结构不变）", () => {
  assert.match(serverSource, /function buildXlsxSheetGrid\(XLSX, wb, name\)/);
  assert.match(serverSource, /const built = buildXlsxSheetGrid\(XLSX, wb, name\);/);
});
test("工作簿 LRU 缓存：mtime 失效 + 上限 6 本", () => {
  assert.match(serverSource, /hit\.mtimeMs === stat\.mtimeMs/);
  assert.match(serverSource, /XLSX_WB_CACHE_MAX = 6/);
});
test("懒加载 readWorkbook：只建首表并带 lazySheets 标记，失败回落整簿", () => {
  assert.match(serverSource, /if \(lazy\) \{/);
  assert.match(serverSource, /lazySheets: true/);
  assert.match(serverSource, /\/\/ 回落到下方整簿路径/);
});
test("整簿路径保持基线：不经缓存，readFile 逐次解析", () => {
  assert.match(serverSource, /const wb = XLSX\.readFile\(file, \{ cellNF: true \}\);\n    return buildXlsxGrids\(XLSX, wb\);/);
});
test("sheet 端点：开关关闭返回 404，仅接受 Excel 扩展名", () => {
  assert.match(serverSource, /if \(!RUNTIME_FLAGS\.previewLazySheets\) return res\.status\(404\)\.json\(\{ error: "not found" \}\);/);
  assert.match(serverSource, /\/\^\\\/api\\\/doc\\\/\(\.\+\)\\\/sheet\$\//);
  assert.match(serverSource, /仅支持 Excel 工作簿/);
});
test("文档主路由按开关传 lazy，catch-all 跳过 /sheet 后缀", () => {
  assert.match(serverSource, /readWorkbook\(p, \{ lazy: RUNTIME_FLAGS\.previewLazySheets \}\)/);
  assert.match(serverSource, /raw\|text\|html\|comments\|watch\|outline\|sheet/);
});

console.log("\n▶ 客户端接线");
test("地址工厂暴露 sheetBase（携带 cwd/wsid/v）", () => {
  assert.match(urlsSource, /sheetBase: q\("\/sheet"\)/);
});
test("DocViewer 传递 lazySheets 与 sheetBase", () => {
  assert.match(viewerSource, /lazySheets=\{doc\.lazySheets\} sheetBase=\{urls\?\.sheetBase \|\| ""\}/);
});
test("懒加载自建页签：切页按需取数，缓存命中不重复请求", () => {
  assert.match(gridSource, /role="tablist"/);
  assert.match(gridSource, /if \(!grid\) grid = await fetchSheet\(sheetName\);/);
});
test("未保存守卫：脏表切换先确认", () => {
  assert.match(gridSource, /当前工作表有未保存的修改，切换后将丢失/);
});
test("换文件弃缓存；服务端已返回网格种入缓存", () => {
  assert.match(gridSource, /sheetCacheRef\.current = new Map\(\);/);
  assert.match(gridSource, /if \(grids\?\.\[s\] && !sheetCacheRef\.current\.has\(s\)\) sheetCacheRef\.current\.set\(s, grids\[s\]\);/);
});
test("整簿模式基线不变：非懒加载仍一次灌入全部表", () => {
  assert.match(gridSource, /const loaded = isLazy \? sheetNames\.filter\(\(s\) => sheetCacheRef\.current\.has\(s\)\) : sheetNames;/);
});
test("懒加载页签样式纯追加", () => {
  assert.match(stylesSource, /\.excel-lazy-tabs \{ display: flex;/);
  assert.match(stylesSource, /P3-c Excel sheet 懒加载页签/);
});
test("package.json 注册 test:preview-lazy", () => {
  assert.equal(pkg.scripts["test:preview-lazy"], "node scripts/preview-lazy-test.mjs");
});

console.log(failed ? "\n预览懒加载测试：失败" : "\n预览懒加载测试：通过");
process.exit(failed);
