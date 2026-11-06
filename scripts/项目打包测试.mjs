/**
 * 地图项目打包归档（G9）回归：zip 内容、清单、瓦片索引、错误路径。
 * 运行：node scripts/项目打包测试.mjs
 *
 * 用现有工作区项目 zhejiang-map（只读）作为夹具，不写真实项目目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

process.env.OAW_MAP_PACK = "1"; // 模块内不读 flag，这里仅保持口径一致

const { buildProjectZip } = await import("../server/项目打包.mjs");
const { projectDir } = await import("../server/map.mjs");

const passed = [];
async function check(name, fn) {
  try { await fn(); passed.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const PROJECT = "zhejiang-map";
const dir = projectDir(PROJECT);
if (!dir || !fs.existsSync(path.join(dir, "map.config.json"))) {
  console.error(`  ✗ 夹具缺失：工作区项目 ${PROJECT} 不存在（${dir}）`);
  process.exit(1);
}

console.log("▶ buildProjectZip");
await check("默认打包：配置 + 脱敏样式 + 图层 + MANIFEST + 瓦片索引", async () => {
  const out = await buildProjectZip({ project: PROJECT });
  assert.ok(Buffer.isBuffer(out.buffer) && out.buffer.length > 0);
  assert.match(out.fileName, new RegExp(`^${PROJECT}-map-\\d{4}-\\d{2}-\\d{2}\\.zip$`));
  const zip = await JSZip.loadAsync(out.buffer);
  assert.ok(zip.file("map.config.json"), "应有 map.config.json");
  assert.ok(zip.file("style.json"), "应有 style.json");
  assert.ok(zip.file("MANIFEST.json"), "应有 MANIFEST.json");
  // 样式脱敏：zip 内的 style.json 不应含真实 key（tracked 版本应为占位符或无 key）
  const styleText = await zip.file("style.json").async("string");
  assert.ok(!/[?&]key=[A-Za-z0-9]{16,}/.test(styleText), "style.json 不应包含真实 Key");
  // 瓦片本体不进包
  const pbf = Object.keys(zip.files).filter((n) => n.endsWith(".pbf"));
  assert.equal(pbf.length, 0, `默认不应包含 .pbf（发现 ${pbf.length} 个）`);
  // MANIFEST 结构
  const manifest = JSON.parse(await zip.file("MANIFEST.json").async("string"));
  assert.equal(manifest.kind, "open-plan-map-project");
  assert.equal(manifest.project, PROJECT);
  assert.equal(manifest.tilesIncluded, false);
  assert.match(manifest.restoreHint, /重建瓦片/);
  assert.ok(manifest.files.includes("map.config.json"));
  assert.ok(manifest.files.includes("style.json"));
  // 瓦片索引与磁盘一致（无 tiles 目录时为空对象，也算一致）
  const tilesDir = path.join(dir, "tiles");
  if (fs.existsSync(tilesDir)) {
    const layers = fs.readdirSync(tilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const layer of layers) {
      assert.ok(manifest.tilesIndex[layer], `索引应含图层 ${layer}`);
      assert.ok(manifest.tilesIndex[layer].files >= 0);
    }
  }
});

await check("清单/统计自洽：files 数与 zip 内文件数一致", async () => {
  const out = await buildProjectZip({ project: PROJECT });
  const zip = await JSZip.loadAsync(out.buffer);
  const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  assert.equal(out.manifest.files.length + 1, entries.length, "manifest.files + MANIFEST.json 应等于 zip 条目数");
  assert.equal(out.stats.files, out.manifest.files.length);
});

await check("图层文件进包（项目有 layers 目录时）", async () => {
  const layersDir = path.join(dir, "layers");
  if (!fs.existsSync(layersDir)) return; // 夹具无图层时跳过断言
  const out = await buildProjectZip({ project: PROJECT });
  const zip = await JSZip.loadAsync(out.buffer);
  const diskLayers = fs.readdirSync(layersDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith("."));
  assert.ok(diskLayers.length > 0, "夹具应有图层文件");
  for (const f of diskLayers) assert.ok(zip.file(`layers/${f.name}`), `layers/${f.name} 应在包内`);
});

await check("zip 解压后可读取工程配置与图层（恢复演练）", async () => {
  const out = await buildProjectZip({ project: PROJECT });
  const zip = await JSZip.loadAsync(out.buffer);
  const tmp = path.join(os.tmpdir(), `oaw-pack-restore-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [name, entry] of Object.entries(zip.files)) {
      const target = path.join(tmp, name);
      if (entry.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.async("nodebuffer"));
    }
    const config = JSON.parse(fs.readFileSync(path.join(tmp, "map.config.json"), "utf8"));
    assert.equal(config.project, PROJECT);
    assert.equal(config.schemaVersion, 2, "解压后工程配置应为 v2 可读");
    assert.ok(Array.isArray(config.layers) && config.layers.length > 0, "解压后应有图层定义");
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "MANIFEST.json"), "utf8"));
    assert.match(manifest.restoreHint, /重建瓦片/, "恢复提示应说明重建瓦片");
    const layersDir = path.join(tmp, "layers");
    if (fs.existsSync(layersDir)) {
      const files = fs.readdirSync(layersDir).filter((n) => n.endsWith(".geojson"));
      assert.ok(files.length > 0, "解压后应有图层数据文件");
      for (const name of files.slice(0, 3)) {
        const geo = JSON.parse(fs.readFileSync(path.join(layersDir, name), "utf8"));
        assert.equal(geo.type, "FeatureCollection", `${name} 应为可解析的 FeatureCollection`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("不存在的项目 → MAP_PROJECT_NOT_FOUND", async () => {
  await assert.rejects(
    () => buildProjectZip({ project: "no-such-project-xyz" }),
    (e) => e.code === "MAP_PROJECT_NOT_FOUND",
  );
});

await check("非法项目名（目录穿越）→ MAP_PROJECT_NOT_FOUND", async () => {
  await assert.rejects(
    () => buildProjectZip({ project: "../evil" }),
    (e) => e.code === "MAP_PROJECT_NOT_FOUND",
  );
});

await check("空项目名 → MAP_PROJECT_NOT_FOUND", async () => {
  await assert.rejects(() => buildProjectZip({}), (e) => e.code === "MAP_PROJECT_NOT_FOUND");
});

console.log("▶ flag 路由口径");
await check("路由源码挂 OAW_MAP_PACK 门控", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "server", "index.mjs"), "utf8");
  assert.match(src, /app\.get\("\/api\/map\/project\/export"/);
  assert.match(src, /RUNTIME_FLAGS\.mapPack/);
});
await check("运行开关含 mapPack 位", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "server", "运行开关.mjs"), "utf8");
  assert.match(src, /mapPack: readFlagDefault\("OAW_MAP_PACK", true\)/);
  assert.match(src, /mapPack: RUNTIME_FLAGS\.mapPack/);
});

console.log(process.exitCode ? "项目打包回归：存在失败用例" : `项目打包回归：通过（${passed.length} 项）`);
