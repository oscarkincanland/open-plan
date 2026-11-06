#!/usr/bin/env node
/**
 * CAD 解析底座守护测试（开关 cadPreview/cadAgent / OAW_CAD_PREVIEW、OAW_CAD_AGENT，默认关）：
 * 运行时校验 DXF 解析主路径与反例（空文件 / 组码非法 / 二进制 DXF / 截断上限）、
 * 摘要生成、DWG 转换器探测降级；源码校验开关注册默认关 + 快照下发。
 * 用法: node scripts/CAD解析测试.mjs（package.json: npm run test:cad）
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAD_ENTITY_LIMIT, decodeDxfText, dwgToDxfText, parseDxf, readCadDocument, resolveDwgConverter, resolveOdaConverter, summarizeCad } from "../server/CAD解析.mjs";
import { applyCadEdit, CAD_EDIT_OPS, prepareCadEdit } from "../server/CAD修改.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let failed = 0;
const pending = []; // async 测试的 promise，末尾统一 await，避免提前退出漏报
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
const test = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(() => ok(name), (e) => fail(`${name}: ${e?.message || e}`)));
      return;
    }
    ok(name);
  } catch (e) { fail(`${name}: ${e?.message || e}`); }
};

console.log("\n▶ 开关注册（源码断言）");
const flagsSource = read("server/运行开关.mjs");
const serverSource = read("server/index.mjs");
const workspaceSource = read("server/workspace.mjs");
const extSource = read("client/src/产物类型.js");
const docViewerSource = read("client/src/components/DocViewer.jsx");
const cadViewerSource = read("client/src/components/CadViewer.jsx");
const contextSource = read("server/context.mjs");
const agentSource = read("server/agent.mjs");
const taskSource = read("server/task.mjs");
const cadSource = read("server/CAD解析.mjs");
const editSource = read("server/CAD修改.mjs");
test("cadPreview 默认开（readFlagDefault 可显式退出）/ cadAgent 默认关（readFlag）", () => {
  // 2026-11-06：用户反馈「图纸点不开」——cadPreview 从默认关改为默认开（只读 SVG 渲染）；
  // cadAgent（Agent 读写图纸）仍为显式开启。
  assert.match(flagsSource, /cadPreview: readFlagDefault\("OAW_CAD_PREVIEW", true\)/);
  assert.match(flagsSource, /cadAgent: readFlag\("OAW_CAD_AGENT"\)/);
});
test("快照下发 cadPreview/cadAgent", () => {
  assert.match(flagsSource, /cadPreview: RUNTIME_FLAGS\.cadPreview/);
  assert.match(flagsSource, /cadAgent: RUNTIME_FLAGS\.cadAgent/);
});

console.log("\n▶ DXF 解析主路径");
const HEADER_PART = [
  "0", "SECTION", "2", "HEADER",
  "9", "$EXTMIN", "10", "-5.0", "20", "-2.0",
  "9", "$EXTMAX", "10", "120.0", "20", "60.0",
  "0", "ENDSEC",
];
const BODY_PART = [
  "0", "SECTION", "2", "TABLES", "0", "TABLE",
  "0", "LAYER", "2", "道路红线", "62", "1", "70", "0",
  "0", "LAYER", "2", "建筑", "62", "-3", "70", "1",
  "0", "ENDTAB", "0", "ENDSEC",
  "0", "SECTION", "2", "BLOCKS",
  "0", "BLOCK", "2", "树池",
  "0", "CIRCLE", "8", "0", "10", "1.0", "20", "1.0", "40", "0.5",
  "0", "ENDBLK", "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "道路红线", "10", "0.0", "20", "0.0", "11", "100.0", "21", "50.0",
  "0", "CIRCLE", "8", "建筑", "10", "50.0", "20", "25.0", "40", "8.0",
  "0", "ARC", "8", "0", "10", "10.0", "20", "10.0", "40", "5.0", "50", "0.0", "51", "90.0",
  "0", "LWPOLYLINE", "8", "道路红线", "90", "3", "70", "1", "10", "0.0", "20", "0.0", "10", "10.0", "20", "0.0", "10", "10.0", "20", "10.0",
  "0", "TEXT", "8", "标注", "10", "5.0", "20", "5.0", "40", "3.5", "1", "金义东线 K12+300",
  "0", "MTEXT", "8", "标注", "10", "20.0", "20", "30.0", "40", "3.0", "1", "交叉口\\P渠化设计",
  "0", "INSERT", "8", "绿化", "2", "树池", "10", "60.0", "20", "20.0", "50", "45.0",
  "0", "ENDSEC", "0", "EOF", "",
];
const SAMPLE = [...HEADER_PART, ...BODY_PART].join("\r\n");
const SAMPLE_NO_HEADER = [...BODY_PART].join("\r\n");

test("实体解析：LINE/CIRCLE/ARC/LWPOLYLINE/TEXT/MTEXT/INSERT 字段齐全", () => {
  const p = parseDxf(SAMPLE);
  const byType = Object.fromEntries(Object.entries(p.entityCounts).map(([t, n]) => [t, n]));
  assert.deepEqual(byType, { LINE: 1, CIRCLE: 1, ARC: 1, LWPOLYLINE: 1, TEXT: 1, MTEXT: 1, INSERT: 1 });
  const line = p.entities.find((e) => e.type === "LINE");
  assert.equal(line.layer, "道路红线");
  assert.equal(line.x1, 0);
  assert.equal(line.y2, 50);
  const pl = p.entities.find((e) => e.type === "LWPOLYLINE");
  assert.equal(pl.points.length, 3);
  assert.equal(pl.closed, true);
  const insert = p.entities.find((e) => e.type === "INSERT");
  assert.equal(insert.block, "树池");
  assert.equal(insert.rot, 45);
});

test("图层解析：名称/颜色/关闭/冻结（62 负值=关闭，70 bit1=冻结）", () => {
  const p = parseDxf(SAMPLE);
  const hongxian = p.layers.find((l) => l.name === "道路红线");
  const jianzhu = p.layers.find((l) => l.name === "建筑");
  assert.equal(hongxian.off, false);
  assert.equal(hongxian.frozen, false);
  assert.equal(jianzhu.off, true);
  assert.equal(jianzhu.frozen, true);
});

test("块表：块内实体计入 blocks，不重复计入顶层实体", () => {
  const p = parseDxf(SAMPLE);
  assert.equal(p.blocks.length, 1);
  assert.equal(p.blocks[0].name, "树池");
  assert.equal(p.blocks[0].entities[0].type, "CIRCLE");
  assert.equal(p.entityCounts.CIRCLE, 1);
});

test("范围：HEADER 声明优先（source=header）", () => {
  const p = parseDxf(SAMPLE);
  assert.equal(p.extents.source, "header");
  assert.equal(p.extents.min.x, -5);
  assert.equal(p.extents.max.y, 60);
});

test("范围兜底：无 HEADER 时按实体估算（source=computed）", () => {
  const p = parseDxf(SAMPLE_NO_HEADER);
  assert.equal(p.extents.source, "computed");
  assert.ok(p.extents.min.x <= 0 && p.extents.max.x >= 100);
});

test("MTEXT 清理：\\P 转换行、剥离行内控制码", () => {
  const p = parseDxf(SAMPLE);
  const mt = p.entities.find((e) => e.type === "MTEXT");
  assert.equal(mt.text, "交叉口\n渠化设计");
});

console.log("\n▶ DXF 反例");
test("空内容抛错「DXF 内容为空」", () => {
  assert.throws(() => parseDxf("   \n  "), /DXF 内容为空/);
});
test("组码非法抛错并带行号定位", () => {
  assert.throws(() => parseDxf("hello\nworld"), /第 1 行组码无法解析/);
});
test("二进制 DXF 哨兵识别并拒绝", () => {
  const bin = Buffer.concat([Buffer.from("AutoCAD Binary DXF\r\n\x1a\x00", "latin1"), Buffer.from([1, 2, 3])]);
  assert.throws(() => decodeDxfText(bin), /二进制 DXF/);
});
test("GBK 中文回退解码（utf8 出替换符时切 GBK）", () => {
  const gbk = Buffer.from([0xb5, 0xc0, 0xc2, 0xb7]); // "道路" 的 GBK 编码
  assert.equal(decodeDxfText(gbk), "道路");
});
test("实体截断：超过 maxEntities 置 truncated 且不再累加", () => {
  const many = ["0", "SECTION", "2", "ENTITIES"];
  for (let i = 0; i < 12; i++) many.push("0", "POINT", "8", "0", "10", String(i), "20", "0");
  many.push("0", "ENDSEC", "0", "EOF", "");
  const p = parseDxf(many.join("\r\n"), { maxEntities: 10 });
  assert.equal(p.truncated, true);
  assert.equal(p.entities.length, 10);
});

console.log("\n▶ 摘要（AC3：agent 读取）");
test("摘要含图层/实体统计/文字内容/范围", () => {
  const p = parseDxf(SAMPLE);
  const s = summarizeCad(p, "样例.dxf");
  assert.match(s, /【CAD 图纸】样例\.dxf/);
  assert.match(s, /图层\(2\)/);
  assert.match(s, /LINE 1/);
  assert.match(s, /金义东线 K12\+300/);
  assert.match(s, /范围：x\[-5, 120\]/);
  assert.doesNotMatch(s, /已截断/);
});
test("截断摘要带不完整提示", () => {
  const p = parseDxf(SAMPLE);
  const s = summarizeCad({ ...p, truncated: true }, "样例.dxf");
  assert.match(s, /已截断/);
});

console.log("\n▶ DWG 转换探测（AC2 降级，环境容忍：本机是否装了转换器均可）");
test("源码包含内置便携包探测（bin/libredwg，先于 PATH 与 ODA 目录）", () => {
  // 2026-11-06（ADR 0024）：随包路径解析下沉到平台适配层 server/平台/外部二进制.mjs，
  // CAD解析 只调用 bundledLibreDwg()，桌面端 resources/bin 与 web 端仓库 bin/ 共用同一解析。
  assert.match(cadSource, /import \{ bundledLibreDwg, bundledOda \} from "\.\/平台\/外部二进制\.mjs"/);
  assert.match(cadSource, /const bundled = bundledLibreDwg\(\);/);
  const platformSource = read("server/平台/外部二进制.mjs");
  assert.match(platformSource, /path\.join\(bundledBinDir\(\), "libredwg"/);
  assert.match(platformSource, /export function bundledLibreDwg/);
});
test("写入链路使用 ODA 专用探测（读取转换器与写回转换器不混用）", () => {
  assert.match(cadSource, /export async function resolveOdaConverter/);
  assert.match(cadSource, /return bundledOda\(\);/);
  const platformSource = read("server/平台/外部二进制.mjs");
  assert.match(platformSource, /path\.join\(bundledBinDir\(\), "oda"/);
  assert.match(editSource, /resolveOdaConverter/);
  assert.doesNotMatch(editSource, /resolveDwgConverter/);
});
let converter;
try {
  converter = await resolveDwgConverter();
} catch (e) {
  fail(`DWG 探测异常: ${e.message}`);
}
if (converter === undefined) {
  // 已在上方 fail
} else if (converter === null) {
  ok("本机未安装转换工具 → 探测返回 null（降级路径符合预期）");
  try {
    await dwgToDxfText("不存在的文件.dwg");
    fail("未检测到转换工具时应抛错");
  } catch (e) {
    if (/未检测到 DWG 转换工具/.test(e.message)) ok("未检测到转换工具时抛安装指引（反例）");
    else fail(`抛错但信息不符: ${e.message}`);
  }
} else {
  test("探测到转换器且描述完整", () => {
    assert.ok(["libredwg", "oda", "unknown"].includes(converter.kind));
    assert.ok(fs.existsSync(converter.program), `程序应存在: ${converter.program}`);
  });
  const bundled = path.join(root, "bin", "libredwg", process.platform === "win32" ? "dwg2dxf.exe" : "dwg2dxf");
  const bundledOdaExe = path.join(root, "bin", "oda", process.platform === "win32" ? "ODAFileConverter.exe" : "ODAFileConverter");
  if (fs.existsSync(bundledOdaExe) && !String(process.env.OAW_DWG_CONVERTER || "").trim()) {
    test("内置 ODA 存在 → 读取探测优先命中 bin/oda（兼容性优先）", () => {
      assert.equal(converter.kind, "oda");
      assert.equal(converter.program, bundledOdaExe);
    });
  } else if (fs.existsSync(bundled) && !String(process.env.OAW_DWG_CONVERTER || "").trim()) {
    test("内置 LibreDWG 存在 → 探测命中 bin/libredwg（免安装路径）", () => {
      assert.equal(converter.kind, "libredwg");
      assert.equal(converter.program, bundled);
    });
  }
}

console.log("\n▶ 预览链路接线（步骤 2 源码断言）");
test("doc 路由 dxf/dwg 分支受 cadPreview 门控（关闭时落入基线兜底）", () => {
  assert.match(serverSource, /RUNTIME_FLAGS\.cadPreview && \(ext === "dxf" \|\| ext === "dwg"\)/);
});
test("CAD 分支返回 kind=cad + 解析产物，实体数受 CAD_ENTITY_LIMIT 截断", () => {
  assert.match(serverSource, /kind: "cad", name: fileName, ext, identity,/);
  assert.match(serverSource, /readCadDocument\(p, \{ maxEntities: CAD_ENTITY_LIMIT \}\)/);
  assert.match(serverSource, /truncated: cad\.truncated/);
});
test("文件树白名单按 flag 动态包含 dxf|dwg（关闭 = 与基线逐字节一致）", () => {
  assert.match(workspaceSource, /CAD_EXT_SEGMENT = RUNTIME_FLAGS\.cadPreview \? "\|dxf\|dwg" : ""/);
  assert.match(workspaceSource, /avif\$\{CAD_EXT_SEGMENT\}\)\$`/);
});
test("产物图标单一映射：dxf/dwg → layers 图标 + CAD 图纸文案", () => {
  assert.match(extSource, /dxf: \{ icon: "layers", label: "CAD 图纸" \}/);
  assert.match(extSource, /dwg: \{ icon: "layers", label: "CAD 图纸" \}/);
});
test("DocViewer 接线：cad → CadViewer + localReady 即就绪 + 徽章", () => {
  assert.match(docViewerSource, /import CadViewer from "\.\/CadViewer\.jsx";/);
  assert.match(docViewerSource, /doc\?\.kind === "cad"/);
  assert.match(docViewerSource, /doc\.kind === "cad" && <CadViewer doc=\{doc\} \/>/);
});
test("CadViewer 三态齐备：加载/空/错误 + 截断提示 + 图层显隐 + 缩放平移", () => {
  assert.match(cadViewerSource, /正在加载 CAD 图纸/);
  assert.match(cadViewerSource, /未解析到可显示的图形实体/);
  assert.match(cadViewerSource, /CAD 渲染失败/);
  assert.match(cadViewerSource, /实体数超过解析上限/);
  assert.match(cadViewerSource, /toggleLayer/);
  assert.match(cadViewerSource, /onPointerDown/);
});
test("CadViewer 图层显隐按组切换：几何只建一次，渲染期不 setState", () => {
  // 2026-11-06：切图层不再重建全部实体（旧实现把 hiddenLayers 放进 useMemo 依赖）
  assert.match(cadViewerSource, /data-layer=\{e\.layer\}/, "实体应按图层包 <g data-layer>");
  assert.match(cadViewerSource, /querySelectorAll\("\[data-layer\]"\)/, "显隐应直接切 display");
  assert.match(cadViewerSource, /node\.style\.display = hiddenLayers\.has\(layer\) \? "none" : ""/, "隐藏层应置 display:none");
  const geometryBlock = cadViewerSource.slice(cadViewerSource.indexOf("const geometry = useMemo"), cadViewerSource.indexOf("const elements = geometry.elements"));
  assert.doesNotMatch(geometryBlock, /setRenderError|setState/, "useMemo 内不得 setState（渲染期 setState 反模式）");
  assert.doesNotMatch(cadViewerSource, /useMemo\([^)]*hiddenLayers/, "几何构建不应依赖 hiddenLayers");
});

console.log("\n▶ CAD 白名单修改（步骤 4 运行时）");
test("replace_text 主路径：TEXT 文字被替换且其余实体不动", () => {
  const { text, changes } = applyCadEdit(SAMPLE, { type: "replace_text", find: "金义东线", replace: "甬金线" });
  assert.equal(changes.changed, 1);
  const p = parseDxf(text);
  const t = p.entities.find((e) => e.type === "TEXT");
  assert.equal(t.text, "甬金线 K12+300");
  assert.equal(p.entityCounts.LINE, 1);
});
test("replace_text 反例：find 为空抛错", () => {
  assert.throws(() => applyCadEdit(SAMPLE, { type: "replace_text", find: "" }), /缺少 find/);
});
test("rename_layer：图层表与实体组码 8 同步改名", () => {
  const { text, changes } = applyCadEdit(SAMPLE, { type: "rename_layer", from: "道路红线", to: "主线" });
  assert.ok(changes.changed >= 3); // 图层表 1 + LINE 1 + LWPOLYLINE 1
  const p = parseDxf(text);
  assert.ok(p.layers.some((l) => l.name === "主线"));
  assert.ok(!p.layers.some((l) => l.name === "道路红线"));
  assert.equal(p.entities.find((e) => e.type === "LINE").layer, "主线");
});
test("move_entities：仅顶层实体迁移图层，块内不动", () => {
  const { text } = applyCadEdit(SAMPLE, { type: "move_entities", from: "标注", to: "说明层", entityType: "TEXT" });
  const p = parseDxf(text);
  assert.equal(p.entities.find((e) => e.type === "TEXT").layer, "说明层");
  assert.equal(p.entityCounts.TEXT, 1);
});
test("delete_layer_entities：目标层实体消失，其他保留", () => {
  const { text } = applyCadEdit(SAMPLE, { type: "delete_layer_entities", layer: "建筑" });
  const p = parseDxf(text);
  assert.ok(!p.entities.some((e) => e.layer === "建筑"));
  assert.ok(p.entities.some((e) => e.type === "LINE"));
});
test("add_entity：新增 LINE 并可解析", () => {
  const { text } = applyCadEdit(SAMPLE, { type: "add_entity", entityType: "LINE", layer: "新增层", x: 1, y: 2, x2: 3, y2: 4 });
  const p = parseDxf(text);
  const line = p.entities.find((e) => e.type === "LINE" && e.layer === "新增层");
  assert.equal(line.x1, 1);
  assert.equal(line.y2, 4);
});
test("add_entity 反例：不支持类型抛错", () => {
  assert.throws(() => applyCadEdit(SAMPLE, { type: "add_entity", entityType: "SPLINE" }), /暂只支持 LINE\/CIRCLE\/TEXT/);
});
test("反例：白名单之外的操作抛错", () => {
  assert.throws(() => applyCadEdit(SAMPLE, { type: "hack_layer" }), /不支持的 CAD 修改操作/);
  assert.deepEqual([...CAD_EDIT_OPS].sort(), ["add_entity", "delete_layer_entities", "move_entities", "rename_layer", "replace_text"]);
});
test("prepareCadEdit 主路径：DXF 返回文本内容不落盘，含操作明细", async () => {
  const tmp = path.join(os.tmpdir(), `oaw-cad-test-${Date.now()}.dxf`);
  fs.writeFileSync(tmp, SAMPLE, "utf8");
  try {
    const r = await prepareCadEdit(tmp, [{ type: "replace_text", find: "金义东线", replace: "甬金线" }]);
    assert.equal(r.format, "dxf");
    assert.equal(typeof r.content, "string");
    assert.match(r.content, /甬金线/);
    assert.equal(r.targetPath, tmp);
    assert.equal(fs.readFileSync(tmp, "utf8"), SAMPLE); // 未落盘
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
test("prepareCadEdit 反例：非 CAD 扩展名抛错；空 ops 抛错", async () => {
  const tmp = path.join(os.tmpdir(), `oaw-cad-test-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "hello", "utf8");
  try {
    await assert.rejects(() => prepareCadEdit(tmp, [{ type: "replace_text", find: "a", replace: "b" }]), /仅支持 DXF\/DWG/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const dxfTmp = path.join(os.tmpdir(), `oaw-cad-test-${Date.now()}.dxf`);
  fs.writeFileSync(dxfTmp, SAMPLE, "utf8");
  try {
    await assert.rejects(() => prepareCadEdit(dxfTmp, []), /ops 为空/);
  } finally {
    fs.rmSync(dxfTmp, { force: true });
  }
});

const bundledOda = path.join(root, "bin", "oda", process.platform === "win32" ? "ODAFileConverter.exe" : "ODAFileConverter");
if (fs.existsSync(bundledOda)) {
  test("ODA 探测：内置 bin/oda 命中且程序存在", async () => {
    const oda = await resolveOdaConverter();
    assert.equal(oda?.kind, "oda");
    assert.equal(oda.program, bundledOda);
    assert.ok(fs.existsSync(oda.program));
  });
  test("DWG 修改（ODA 可用）：原格式写回且文字回读生效", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-cad-oda-"));
    const inDir = path.join(dir, "in");
    const outDir = path.join(dir, "out");
    fs.mkdirSync(inDir);
    fs.mkdirSync(outDir);
    try {
      fs.writeFileSync(path.join(inDir, "sample.dxf"), SAMPLE, "utf8");
      execFileSync(bundledOda, [inDir, outDir, "ACAD2018", "DWG", "0", "1"], { windowsHide: true, timeout: 120000, stdio: "ignore" });
      const produced = fs.readdirSync(outDir).find((f) => /\.dwg$/i.test(f));
      assert.ok(produced, "ODA 未产出 DWG");
      const r = await prepareCadEdit(path.join(outDir, produced), [{ type: "replace_text", find: "K12+300", replace: "K12+500" }]);
      assert.equal(r.format, "dwg");
      assert.ok(Buffer.isBuffer(r.content), "DWG 写回应为二进制 Buffer");
      const resultPath = path.join(dir, "result.dwg");
      fs.writeFileSync(resultPath, r.content);
      const back = await readCadDocument(resultPath);
      const texts = back.entities.filter((e) => e.type === "TEXT" || e.type === "MTEXT").map((e) => String(e.text));
      assert.ok(texts.some((t) => t.includes("K12+500")), `回读文字未更新: ${texts.join(" | ")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log("\n▶ Agent 读取/修改接线（步骤 3/4 源码断言）");
test("context.mjs：SUPPORTED 与 @引用扩展名按 cadAgent 门控，提取失败返回可读错误", () => {
  assert.match(contextSource, /RUNTIME_FLAGS\.cadAgent \? \["dxf", "dwg"\] : \[\]/);
  assert.match(contextSource, /cadAgent \? "\|dxf\|dwg" : ""/);
  assert.match(contextSource, /CAD 读取失败：/);
});
test("agent.mjs：cad 工具定义并接入 customTools；模式白名单由 task.mjs 门控", () => {
  assert.match(agentSource, /name: "cad_read"/);
  assert.match(agentSource, /name: "cad_edit"/);
  assert.match(agentSource, /cadReadTool, cadEditTool,/);
  // 2026-11-04 收敛后 agent.mjs 不再维护硬编码工具名清单，统一从 task.mjs 派生。
  assert.match(agentSource, /sessionToolNames = \[\.\.\.allModeToolNames\(\)/);
  assert.match(taskSource, /RUNTIME_FLAGS\.cadAgent \? \["cad_read"\] : \[\]/);
  assert.match(taskSource, /RUNTIME_FLAGS\.cadAgent \? \["cad_edit"\] : \[\]/);
});
test("cad_edit 落盘走统一写入通道（审批 + writeWorkspaceFile），工具执行校验 cadAgent", () => {
  assert.match(agentSource, /const ctx = activeWriteContext\("cad_edit"\)/);
  assert.match(agentSource, /prepareCadEdit\(target, params\.ops \|\| \[\], \{ outputPath \}\)/);
  assert.match(agentSource, /writeWorkspaceFile\(\{ workspace: entry\.workspace, targetPath: prepared\.targetPath/);
});
test("task.mjs：CAD 能力条目受 cadAgent 门控，cad 恒 ready、cad_edit 仅 agent、cad_dwg planned", () => {
  assert.match(taskSource, /RUNTIME_FLAGS\.cadAgent && cad && \(mode === "chat" \|\| mode === "agent"\)/);
  assert.match(taskSource, /id: "cad", label: "CAD 读取", status: "ready"/);
  assert.match(taskSource, /id: "cad_dwg", label: "CAD DWG 转换", status: "planned"/);
});

console.log("\n▶ task.mjs 能力计划（步骤 4 运行时，环境容忍）");
{
  process.env.OAW_CAD_AGENT = "1";
  const { planTaskCapabilities } = await import("../server/task.mjs");
  const plan = planTaskCapabilities({ text: "把 图纸/总平面.dxf 的说明文字更新", task: { mode: "agent" } });
  test("cadAgent 开：图纸意图声明 cad/cad_edit/cad_dwg 能力", () => {
    assert.ok(plan.capabilities.some((c) => c.id === "cad"));
    assert.ok(plan.capabilities.some((c) => c.id === "cad_edit"));
    assert.ok(plan.capabilities.some((c) => c.id === "cad_dwg"));
  });
  const noIntent = planTaskCapabilities({ text: "帮我写一份报告", task: { mode: "agent" } });
  test("无 CAD 意图时不声明 CAD 能力（反例）", () => {
    assert.ok(!noIntent.capabilities.some((c) => c.id === "cad"));
  });
  delete process.env.OAW_CAD_AGENT;
  // flag 关闭场景用子进程验证：本进程已缓存过 cadAgent=true 的开关模块，无法在同一进程内回滚
  test("cadAgent 关：即使图纸意图也不声明（基线反例，子进程验证）", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const script = 'import("./server/task.mjs").then(({ planTaskCapabilities }) => { const plan = planTaskCapabilities({ text: "把 图纸/总平面.dxf 的说明文字更新", task: { mode: "agent" } }); console.log(JSON.stringify({ hasCad: plan.capabilities.some((c) => c.id === "cad") })); process.exit(0); });';
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...process.env, OAW_CAD_AGENT: "" }, windowsHide: true, timeout: 30000 });
    assert.equal(JSON.parse(stdout.trim().split(/\r?\n/).pop()).hasCad, false);
  });
}

await Promise.all(pending);
console.log(`\n实体上限常量：CAD_ENTITY_LIMIT=${CAD_ENTITY_LIMIT}`);
console.log(failed ? "\n✗ 测试失败\n" : "\n✓ 全部通过\n");
process.exit(failed);
