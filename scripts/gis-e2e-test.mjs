#!/usr/bin/env node
/**
 * GIS 工程链路端到端验收（HTTP 层，真实服务）——T1.3 / T1.4 / T1.5 / T3.5
 *
 * 与 `GIS交付端到端测试.mjs` 的区别：后者验证 G 系列既有交付能力（报告/模板/打包/
 * 批量导出/适配器，需全 flag 独立服务）；本脚本验证本次 QGIS 化新增的工程链路：
 *
 *   空白画布创建 → 导入临时/正式层 → 图层元数据 PATCH（锁定/透明度）→ 设为基线
 *   → 基线后新增层 → 三级重置（tree / temp / baseline）→ 单层导出 → 数据替换
 *   → 操作日志 → 删除图层入回收站 → 删除项目 → 不存在项目的 404/400 语义
 *
 * 前置：服务已在运行（默认 http://127.0.0.1:3002），无需额外 flag；
 * 使用临时项目 probe-e2e-*，结束后经 HTTP 删除，不触碰正式项目数据。
 *
 * 运行：node scripts/gis-e2e-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3002";
const NAME = `probe-e2e-${Date.now().toString(36)}`;
const passed = [];
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name} -> ${error.message}`);
  }
}

async function api(pathname, options = {}) {
  const resp = await fetch(`${BASE}${pathname}`, options);
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, body, headers: resp.headers };
}

const json = (payload, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const pointFC = (label, coords = [120.1, 29.3]) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { name: label }, geometry: { type: "Point", coordinates: coords } }],
});
const twoPointFC = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "甲" }, geometry: { type: "Point", coordinates: [120.1, 29.3] } },
    { type: "Feature", properties: { name: "乙" }, geometry: { type: "Point", coordinates: [120.2, 29.4] } },
  ],
};

async function registry() {
  const { status, body } = await api(`/api/map/project/${NAME}/layers`);
  assert.equal(status, 200, `注册表 status=${status}`);
  return body;
}

async function main() {
  console.log(`▶ GIS 工程链路（${BASE}）`);

  await check("服务可达", async () => {
    const { status, body } = await api("/api/status");
    assert.equal(status, 200, `status=${status}`);
    assert.equal(body.ok, true, "健康状态应为 ok");
  });

  await check("空白画布通过 HTTP 创建（kind=blank）", async () => {
    const { status, body } = await api("/api/map/projects", json({
      project: NAME, name: "E2E 工程链路", kind: "blank", description: "端到端探针",
    }));
    assert.equal(status, 201, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    assert.equal(body.config.schemaVersion, 2, "应为 config v2");
    assert.equal(body.config.kind, "blank");
    assert.equal(body.config.description, "端到端探针");
    assert.equal(body.config.layers.length, 0, "空白画布不应继承业务图层");
  });

  await check("空白画布注册表为空且带 schemaVersion", async () => {
    const reg = await registry();
    assert.equal(reg.schemaVersion, 2);
    assert.equal(reg.counts.layers, 0);
  });

  await check("项目详情响应包含 schemaVersion 与工程字段（只增不改）", async () => {
    const { status, body } = await api(`/api/map/project?name=${NAME}`);
    assert.equal(status, 200);
    assert.equal(body.config.schemaVersion, 2);
    assert.equal(body.config.crs, "EPSG:4326");
    assert.ok(Array.isArray(body.layerViews), "应增补 layerViews 归属视图");
    assert.ok(body.config.createdAt && body.config.updatedAt, "应有创建/更新时间");
  });

  await check("导入图层并反映在注册表（要素数/来源/基线归属）", async () => {
    const imported = await api(`/api/map/project/${NAME}/import`, json({ layerId: "e2e-a", geojson: twoPointFC }));
    assert.equal(imported.status, 200, JSON.stringify(imported.body).slice(0, 200));
    assert.equal(imported.body.features, 2);
    const reg = await registry();
    const layer = reg.layers.find((l) => l.id === "e2e-a");
    assert.ok(layer, "导入层应出现在注册表");
    assert.equal(layer.stats.features, 2);
    assert.equal(layer.source.kind, "import");
    assert.equal(layer.inBaseline, false, "基线前导入层不应标记为基线内");
  });

  await check("PATCH 图层元数据（改名/锁定/透明度）持久化", async () => {
    const { status, body } = await api(
      `/api/map/project/${NAME}/layer/e2e-a`,
      json({ name: "E2E 点 A", locked: true, opacity: 0.5 }, "PATCH"),
    );
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    const reg = await registry();
    const layer = reg.layers.find((l) => l.id === "e2e-a");
    assert.equal(layer.name, "E2E 点 A");
    assert.equal(layer.locked, true);
    assert.equal(layer.opacity, 0.5);
  });

  await check("设为基线后注册表标记 inBaseline", async () => {
    const { status, body } = await api(`/api/map/project/${NAME}/baseline`, json({}));
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    assert.equal(body.baseline.layers.length, 1, "基线应含 1 层");
    const reg = await registry();
    assert.equal(reg.layers.find((l) => l.id === "e2e-a").inBaseline, true);
  });

  await check("基线后新增层在注册表中标记非基线", async () => {
    const imported = await api(`/api/map/project/${NAME}/import`, json({ layerId: "e2e-b", geojson: pointFC("B", [120.3, 29.5]) }));
    assert.equal(imported.status, 200);
    const reg = await registry();
    assert.equal(reg.layers.find((l) => l.id === "e2e-b").inBaseline, false);
  });

  await check("重置图层树恢复基线显隐并保留新增正式层", async () => {
    const patched = await api(
      `/api/map/project/${NAME}/layer/e2e-a`,
      json({ visible: false }, "PATCH"),
    );
    assert.equal(patched.status, 200);
    const { status, body } = await api(`/api/map/project/${NAME}/reset`, json({ level: "tree" }));
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    const detail = await api(`/api/map/project?name=${NAME}`);
    const a = detail.body.config.layers.find((l) => l.id === "e2e-a");
    assert.equal(a.visible, true, "应恢复基线显隐");
    assert.equal(a.locked, true, "应恢复基线锁定");
    assert.equal(a.opacity, 0.5, "应恢复基线透明度");
    assert.ok(detail.body.config.layers.some((l) => l.id === "e2e-b"), "基线后新增层应保留");
    const styleA = detail.body.style.layers.find((l) => l.id === "e2e-a");
    assert.equal(styleA.layout.visibility, "visible", "style 显隐应同步恢复");
  });

  await check("重置临时层返回快照且不改正式层", async () => {
    const { status, body } = await api(`/api/map/project/${NAME}/reset`, json({ level: "temp" }));
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    assert.ok(body.snapshot && fs.existsSync(body.snapshot), "应写重置快照");
    const reg = await registry();
    assert.equal(reg.counts.layers, 2, "正式层不应变化");
  });

  await check("恢复基线移除新增层并移入回收站", async () => {
    const { status, body } = await api(`/api/map/project/${NAME}/reset`, json({ level: "baseline" }));
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    assert.equal(body.removed.length, 1, "应移除 1 个基线后新增层");
    assert.equal(body.removed[0].id, "e2e-b");
    assert.ok(fs.existsSync(body.removed[0].trash), "移除层应进回收站");
    const reg = await registry();
    assert.equal(reg.counts.layers, 1);
    assert.ok(!reg.layers.some((l) => l.id === "e2e-b"));
  });

  await check("单层导出返回 GeoJSON 且要素完整", async () => {
    const { status, body, headers } = await api(`/api/map/project/${NAME}/layer/e2e-a/export`, { method: "POST" });
    assert.equal(status, 200);
    assert.match(String(headers.get("content-type") || ""), /application\/geo\+json/);
    assert.equal(body.type, "FeatureCollection");
    assert.equal(body.features.length, 2);
  });

  await check("替换图层数据先备份旧数据到回收站", async () => {
    const { status, body } = await api(
      `/api/map/project/${NAME}/layer/e2e-a/replace`,
      json({ geojson: pointFC("新", [120.4, 29.6]) }),
    );
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    assert.equal(body.features, 1);
    assert.ok(body.discarded && fs.existsSync(body.discarded), "旧数据应进回收站");
    assert.ok(fs.existsSync(`${body.discarded}/e2e-a.geojson`), "回收站应保存旧 geojson");
    const reg = await registry();
    assert.equal(reg.layers.find((l) => l.id === "e2e-a").stats.features, 1);
  });

  await check("操作日志可区分动作且不写入要素内容", async () => {
    const { status, body } = await api(`/api/map/project/${NAME}/operations?limit=200`);
    assert.equal(status, 200);
    const actions = new Set((body.operations || []).map((o) => o.action));
    for (const action of ["project.create", "baseline.set", "layer.update", "reset.tree", "reset.temp", "reset.baseline", "layer.replace"]) {
      assert.ok(actions.has(action), `缺少操作日志 ${action}（实际 ${[...actions].join(",")}）`);
    }
    assert.ok((body.operations || []).every((o) => o.actor === "user" || o.actor === "agent"), "actor 应可区分");
    const serialized = JSON.stringify(body.operations);
    assert.ok(!serialized.includes("coordinates"), "日志不应写入要素坐标/文档内容");
  });

  await check("删除图层移入回收站而非物理删除", async () => {
    const { status, body } = await api(`/api/map/project/${NAME}/layer/e2e-a`, { method: "DELETE" });
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    assert.ok(fs.existsSync(body.trash), "回收站应存在");
    const reg = await registry();
    assert.ok(!reg.layers.some((l) => l.id === "e2e-a"), "注册表应移除图层");
  });

  await check("项目文件树接口（含 agent 清单，跳过瓦片）", async () => {
    const { status, body } = await api(`/api/map/project/${NAME}/tree`);
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    const paths = (body.files || []).map((file) => file.rel);
    assert.ok(paths.includes("map.config.json"), "应含项目配置");
    assert.ok(paths.includes("agent/manifest.jsonl"), "应含 agent 清单");
    assert.ok(!paths.some((item) => item.startsWith("tiles/")), "不应列出瓦片");
    assert.equal(body.truncated, false);
    const filtered = await api(`/api/map/project/${NAME}/tree?q=agent`);
    assert.equal(filtered.status, 200);
    assert.ok((filtered.body.files || []).length > 0, "按 agent 目录搜索应有结果");
    assert.ok(filtered.body.files.every((file) => file.rel.includes("agent")), "结果应匹配目录");
    const missing = await api(`/api/map/project/${NAME}-missing/tree`);
    assert.equal(missing.status, 404, "项目不存在应 404");
  });

  await check("会话地图上下文写入/回传/无效项目拒绝", async () => {
    const created = await api("/api/sessions", json({ label: "E2E 地图绑定" }));
    assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 200));
    const sessionId = created.body.id;
    assert.ok(sessionId, "应返回会话 id");
    try {
      const saved = await api(`/api/sessions/${sessionId}/map-context`, json({
        mapProject: NAME,
        mapView: { center: [120.1, 29.3], zoom: 9, bounds: [120, 29, 120.4, 29.6], tempLayers: [{ id: "x" }] },
      }));
      assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));
      assert.equal(saved.body.mapProject, NAME);
      assert.deepEqual(saved.body.mapView.center, [120.1, 29.3]);
      assert.equal("tempLayers" in saved.body.mapView, false, "临时层不应写进会话 header");
      const list = await api("/api/sessions");
      const found = (list.body.sessions || []).find((item) => item.id === sessionId);
      assert.ok(found, "会话列表应包含该会话");
      assert.equal(found.mapProject, NAME, "列表应回传地图项目");
      const invalid = await api(`/api/sessions/${sessionId}/map-context`, json({ mapProject: `${NAME}-missing` }));
      assert.equal(invalid.status, 400, "无效地图项目应 400");
    } finally {
      await api(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
  });

  await check("不存在项目的 404 / 400 语义", async () => {
    const missing = `${NAME}-missing`;
    const reg = await api(`/api/map/project/${missing}/layers`);
    assert.equal(reg.status, 404, `注册表应 404（实际 ${reg.status}）`);
    const reset = await api(`/api/map/project/${missing}/reset`, json({ level: "tree" }));
    assert.equal(reset.status, 400, `重置应 400（实际 ${reset.status}）`);
    assert.ok(!reset.body.ok);
  });

  await check("HTTP 删除临时项目并清理目录", async () => {
    const { status, body } = await api("/api/map/projects/delete", json({ project: NAME }));
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, true);
    const after = await api(`/api/map/project/${NAME}/layers`);
    assert.notEqual(after.status, 200, "删除后注册表应不可读");
  });
}

try {
  await main();
} finally {
  const leftover = await api("/api/map/projects/delete", json({ project: NAME })).catch(() => null);
  void leftover;
}

console.log(`\nGIS 工程链路端到端：通过 ${passed.length} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.name}: ${f.error.stack || f.error.message}`);
  process.exit(1);
}
