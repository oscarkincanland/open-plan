/**
 * CAD 解析底座（零依赖）：DXF(ASCII) 纯 JS 解析 + agent 上下文摘要 + DWG 外部转换探测。
 *
 * 对应验收标准（2026-10-21 CAD 方案）：
 *   AC1 预览：parseDxf 输出图层/实体/范围，供 CadViewer SVG 渲染（步骤 2 接线）。
 *   AC2 DWG 降级：resolveDwgConverter / dwgToDxfText 探测外部转换工具（ODA/LibreDWG），
 *       检测不到时抛出明确错误，不阻塞 DXF 主链路。
 *   AC3 agent 读取：summarizeCad 生成结构化文本摘要（图层、实体统计、文字内容、范围）。
 *   AC5 零依赖：全部使用 node: 内置模块，不新增 npm 依赖。
 *
 * DXF 组码参考：0=实体类型/节标记，8=图层，10/20=主点，11/21=副点，40=半径/字高，
 * 50/51=角度，1/3=文本，2=块名/图层名，62=颜色，70=标志位，90=多段线顶点数。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** 项目根目录：用于探测随项目分发的便携转换器（bin/ 已在 .gitignore 中，不随仓库提交）。 */
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 预览/读取的实体上限：超过即截断（防止超大图纸拖垮预览与上下文）。 */
export const CAD_ENTITY_LIMIT = 20000;
/** DWG→DXF 转换结果 LRU 缓存上限（按 文件路径|mtime|size 失效）。 */
const DWG_CACHE_MAX = 8;
/** 文本摘要在摘要中的条数与单条长度上限。 */
const SUMMARY_TEXT_LIMIT = 30;
const SUMMARY_TEXT_CHARS = 120;

const BINARY_DXF_SENTINEL = "AutoCAD Binary DXF";

/* ==================== 文本解码 ==================== */

/**
 * DXF 字节流 → 文本：utf8 优先，出现替换符时回退 GBK（中文 AutoCAD 常见出图编码）。
 * 二进制 DXF（哨兵头）不支持，抛出明确错误指导另存为 ASCII。
 * 对应 AC1 反例处理：二进制 DXF 不白屏、给可操作提示。
 */
export function decodeDxfText(buffer) {
  const head = buffer.subarray(0, 22).toString("latin1");
  if (head.startsWith(BINARY_DXF_SENTINEL)) {
    throw new Error("不支持二进制 DXF（AutoCAD Binary DXF），请在 CAD 中另存为 ASCII DXF 后重试");
  }
  let text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) {
    try {
      const gbk = new TextDecoder("gbk").decode(buffer);
      if (!gbk.includes("\uFFFD")) text = gbk;
    } catch {
      /* 当前 Node 缺少 gbk 解码表时保持 utf8 结果 */
    }
  }
  return text.replace(/^\uFEFF/, "");
}

/* ==================== DXF 解析 ==================== */

/** 从实体组码对中取数值 / 字符串（首个命中）。 */
function num(rec, code, fallback = undefined) {
  const hit = rec.find(([c]) => c === code);
  if (!hit) return fallback;
  const v = Number.parseFloat(hit[1]);
  return Number.isFinite(v) ? v : fallback;
}
function str(rec, code) {
  const hit = rec.find(([c]) => c === code);
  return hit ? hit[1].trim() : "";
}

/** MTEXT 行内格式清理：\P 换行、剥离 \X...; 控制码与花括号分组。 */
export function cleanMtext(raw) {
  return String(raw || "")
    .replace(/\\P/g, "\n")
    .replace(/\\[A-Za-z][^;\\{}]*;/g, "")
    .replace(/[{}]/g, "")
    .trim();
}

/** 将实体组码对序列转为紧凑实体对象；未知类型保留 type/layer 供统计。 */
function toEntity(type, rec) {
  const layer = str(rec, 8) || "0";
  const base = { type, layer };
  switch (type) {
    case "LINE":
      return { ...base, x1: num(rec, 10), y1: num(rec, 20), x2: num(rec, 11), y2: num(rec, 21) };
    case "CIRCLE":
      return { ...base, x: num(rec, 10), y: num(rec, 20), r: num(rec, 40) };
    case "ARC":
      return { ...base, x: num(rec, 10), y: num(rec, 20), r: num(rec, 40), a1: num(rec, 50, 0), a2: num(rec, 51, 360) };
    case "LWPOLYLINE": {
      const points = [];
      let px = null;
      for (const [c, v] of rec) {
        if (c === 10) px = Number.parseFloat(v);
        else if (c === 20 && Number.isFinite(px)) { points.push([px, Number.parseFloat(v)]); px = null; }
      }
      return { ...base, closed: (num(rec, 70, 0) & 1) === 1, points };
    }
    case "TEXT":
      return { ...base, x: num(rec, 10), y: num(rec, 20), h: num(rec, 40, 0), text: str(rec, 1) };
    case "MTEXT": {
      const parts = rec.filter(([c]) => c === 3).map(([, v]) => v);
      parts.push(str(rec, 1));
      return { ...base, x: num(rec, 10), y: num(rec, 20), h: num(rec, 40, 0), text: cleanMtext(parts.join("")) };
    }
    case "INSERT":
      return { ...base, block: str(rec, 2), x: num(rec, 10), y: num(rec, 20), sx: num(rec, 41, 1), sy: num(rec, 42, 1), rot: num(rec, 50, 0) };
    default: {
      // 未知/暂不支持实体：保留锚点供范围估算（如有）
      const x = num(rec, 10);
      const y = num(rec, 20);
      return Number.isFinite(x) && Number.isFinite(y) ? { ...base, x, y } : base;
    }
  }
}

/** 实体几何锚点（用于无 HEADER 范围时的兜底估算）。 */
function entityAnchor(e) {
  if (typeof e.x === "number" && typeof e.y === "number") return [[e.x, e.y]];
  if (typeof e.x1 === "number") return [[e.x1, e.y1], [e.x2, e.y2]];
  if (Array.isArray(e.points)) return e.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  return [];
}

/** 由实体估算绘图范围。 */
function computeExtents(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    for (const [x, y] of entityAnchor(e)) {
      const spread = typeof e.r === "number" ? e.r : 0;
      minX = Math.min(minX, x - spread); maxX = Math.max(maxX, x + spread);
      minY = Math.min(minY, y - spread); maxY = Math.max(maxY, y + spread);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY }, source: "computed" };
}

/**
 * 解析 ASCII DXF 文本 → { layers, blocks, entities, entityCounts, extents, truncated }。
 * 结构性非法输入抛出带定位信息的 Error（对应验收反例：不白屏、错误可判读）。
 */
export function parseDxf(text, { maxEntities = CAD_ENTITY_LIMIT } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("DXF 内容为空");
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) {
      throw new Error(`不是有效的 DXF（第 ${i + 1} 行组码无法解析："${lines[i].slice(0, 40)}"）`);
    }
    pairs.push([code, lines[i + 1] ?? ""]);
  }

  const out = { layers: [], blocks: [], entities: [], entityCounts: {}, extents: null, truncated: false };

  // 实体收集器：sink=实体数组，counts 仅在顶层 ENTITIES 时传入（块内实体不计入顶层统计）
  const readEntitiesUntil = (start, stopAt, sink, counts = null) => {
    let i = start;
    while (i < pairs.length) {
      const [code, val] = pairs[i];
      if (code === 0) {
        if (val === stopAt || val === "SECTION" || val === "ENDSEC") return i;
        const type = val;
        const rec = [];
        let j = i + 1;
        while (j < pairs.length && pairs[j][0] !== 0) { rec.push(pairs[j]); j++; }
        if (sink.length >= maxEntities) { out.truncated = true; return j; }
        const entity = toEntity(type, rec);
        sink.push(entity);
        if (counts) counts[type] = (counts[type] || 0) + 1;
        i = j;
      } else i++;
    }
    return i;
  };

  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val === "SECTION" && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1].trim();
      i += 2;
      if (name === "HEADER") {
        const headerPairs = [];
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
          headerPairs.push(pairs[i]);
          i++;
        }
        const declared = headerExtents(headerPairs);
        if (declared) out.extents = declared;
        i++; // 跳过 ENDSEC
      } else if (name === "TABLES") {
        // LAYER 表：0/LAYER 记录 → 2=名称 62=颜色(负=关) 70=标志位(bit1=冻结)。
        // 注意连续 LAYER 记录：新记录开始前必须先收口上一条，否则首条被覆盖丢弃。
        let rec = null;
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
          const [c, v] = pairs[i];
          if (c === 0 && v === "LAYER") {
            if (rec) pushLayer(out, rec);
            rec = [];
          } else if (c === 0 && rec) { pushLayer(out, rec); rec = null; }
          else if (rec) rec.push([c, v]);
          i++;
        }
        if (rec) pushLayer(out, rec);
        i++;
      } else if (name === "BLOCKS") {
        // 0/BLOCK(2=块名, 10/20=基点) ... 0/ENDBLK：块内实体计入 blocks[k].entities（不重复计入顶层实体）；
        // 基点供 CadViewer 展开 INSERT 时平移对位（基点默认 0,0）
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
          if (pairs[i][0] === 0 && pairs[i][1] === "BLOCK") {
            const rec = [];
            let j = i + 1;
            while (j < pairs.length && pairs[j][0] !== 0) { rec.push(pairs[j]); j++; }
            const block = {
              name: str(rec, 2) || str(rec, 3) || "未命名块",
              baseX: num(rec, 10, 0) || 0,
              baseY: num(rec, 20, 0) || 0,
              entities: [],
            };
            const after = readEntitiesUntil(j, "ENDBLK", block.entities);
            out.blocks.push(block);
            i = after;
          } else i++;
        }
        i++;
      } else if (name === "ENTITIES") {
        i = readEntitiesUntil(i, "ENDSEC", out.entities, out.entityCounts);
      } else {
        // 不关心的节：快进到 ENDSEC
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) i++;
        i++;
      }
    } else i++;
  }

  if (!out.extents) out.extents = computeExtents(out.entities);
  return out;
}

/** LAYER 记录组码对 → 图层对象。 */
function pushLayer(out, rec) {
  const name = str(rec, 2);
  if (!name) return;
  const color = num(rec, 62, 7);
  const flags = num(rec, 70, 0);
  out.layers.push({ name, color: Math.abs(color) || 7, off: color < 0, frozen: (flags & 1) === 1 });
}

/**
 * HEADER 的 $EXTMIN/$EXTMAX 提取（在 parseDxf 主循环中替代简化占位）。
 * 返回 {min:{x,y}, max:{x,y}, source:"header"} 或 null。
 */
export function headerExtents(headerPairs) {
  let currentVar = "";
  let min = null, max = null;
  for (const [c, v] of headerPairs) {
    if (c === 9) currentVar = String(v).trim();
    else if (currentVar === "$EXTMIN" && c === 10) min = { x: Number.parseFloat(v) };
    else if (currentVar === "$EXTMIN" && c === 20 && min) min.y = Number.parseFloat(v);
    else if (currentVar === "$EXTMAX" && c === 10) max = { x: Number.parseFloat(v) };
    else if (currentVar === "$EXTMAX" && c === 20 && max) max.y = Number.parseFloat(v);
  }
  if (min && max && Number.isFinite(min.x) && Number.isFinite(min.y) && Number.isFinite(max.x) && Number.isFinite(max.y)) {
    return { min, max, source: "header" };
  }
  return null;
}

/* ==================== 摘要（AC3：agent 读取） ==================== */

/**
 * 解析结果 → agent 上下文摘要文本：图层、实体统计、文字内容、范围。
 * 长度受控（文字 ≤30 条 × 120 字符），避免超大图纸撑爆上下文。
 */
export function summarizeCad(parsed, name = "") {
  const { layers, entities, entityCounts, extents, truncated } = parsed;
  const lines = [];
  lines.push(`【CAD 图纸】${name || "（未命名）"}`);
  lines.push(`图层(${layers.length})：${layers.slice(0, 30).map((l) => `${l.name}(${l.frozen ? "冻结" : "可见"})`).join("、") || "无"}${layers.length > 30 ? ` …共${layers.length}层` : ""}`);
  const counts = Object.entries(entityCounts).map(([t, n]) => `${t} ${n}`);
  const total = Object.values(entityCounts).reduce((a, b) => a + b, 0);
  lines.push(`实体(${total})：${counts.join("、") || "无"}`);
  const texts = entities.filter((e) => (e.type === "TEXT" || e.type === "MTEXT") && e.text).slice(0, SUMMARY_TEXT_LIMIT);
  if (texts.length) {
    lines.push(`文字内容(${texts.length}条)：`);
    for (const t of texts) lines.push(`  [${t.layer}] ${String(t.text).slice(0, SUMMARY_TEXT_CHARS)}`);
  }
  if (extents) lines.push(`范围：x[${round(extents.min.x)}, ${round(extents.max.x)}]、y[${round(extents.min.y)}, ${round(extents.max.y)}]（${extents.source === "header" ? "图纸声明" : "按实体估算"}）`);
  if (truncated) lines.push(`注意：实体数超过上限 ${CAD_ENTITY_LIMIT}，已截断，统计与渲染不完整。`);
  return lines.join("\n");
}

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : "?";
}

/* ==================== DWG 外部转换（AC2：降级链路） ==================== */

let converterCache; // 进程内缓存：探测结果在整个生命周期内复用

/**
 * 探测 DWG→DXF 转换工具（非 npm 依赖，零新增依赖约束下的豁免通道）：
 * 1) OAW_DWG_CONVERTER 环境变量显式指定可执行文件路径；
 * 2) 项目内置便携包 bin/libredwg（免安装，下载后即可用）；
 * 3) PATH 中的 dwg2dxf（LibreDWG）或 ODAFileConverter；
 * 4) Windows 常见安装目录 C:\Program Files\ODA\*\ODAFileConverter.exe。
 * 都找不到返回 null（调用方降级并提示安装），结果进程内缓存。
 */
export async function resolveDwgConverter() {
  if (converterCache !== undefined) return converterCache;
  converterCache = await detectConverter();
  return converterCache;
}

async function detectConverter() {
  const explicit = String(process.env?.OAW_DWG_CONVERTER || "").trim();
  if (explicit) {
    if (fs.existsSync(explicit)) return kindOf(explicit);
    return null; // 显式配置了但不存在：视为未安装，不猜测
  }
  const bundled = path.join(PROJECT_DIR, "bin", "libredwg", process.platform === "win32" ? "dwg2dxf.exe" : "dwg2dxf");
  if (fs.existsSync(bundled)) return { kind: "libredwg", program: bundled };
  const finder = process.platform === "win32" ? "where" : "which";
  for (const name of ["dwg2dxf", "ODAFileConverter"]) {
    try {
      const { stdout } = await execFileAsync(finder, [name], { windowsHide: true, timeout: 5000 });
      const hit = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      if (hit) return kindOf(hit);
    } catch { /* 未命中继续 */ }
  }
  if (process.platform === "win32") {
    const odaRoot = "C:\\Program Files\\ODA";
    try {
      for (const dir of fs.readdirSync(odaRoot)) {
        const exe = path.join(odaRoot, dir, "ODAFileConverter.exe");
        if (fs.existsSync(exe)) return { kind: "oda", program: exe };
      }
    } catch { /* 目录不存在 */ }
  }
  return null;
}

function kindOf(program) {
  const base = path.basename(program).toLowerCase();
  if (base.startsWith("dwg2dxf")) return { kind: "libredwg", program };
  if (base.startsWith("odafileconverter")) return { kind: "oda", program };
  return { kind: "unknown", program };
}

const dwgCache = new Map();

/**
 * DWG 文件 → DXF 文本（LRU 缓存按 mtime+size 失效）。
 * 未检测到转换工具时抛出带安装指引的 Error（AC2 降级：明确提示，不静默失败）。
 */
export async function dwgToDxfText(dwgPath) {
  // 先探转换能力再碰文件：未装转换工具时无论文件是否存在都给出安装指引（降级提示优先）
  const converter = await resolveDwgConverter();
  if (!converter) {
    throw new Error("未检测到 DWG 转换工具：请安装 ODA File Converter 或 LibreDWG（dwg2dxf），或用 OAW_DWG_CONVERTER 指定路径；也可在 CAD 中将文件另存为 DXF");
  }
  const st = fs.statSync(dwgPath);
  const key = `${dwgPath}|${st.mtimeMs}|${st.size}`;
  const hit = dwgCache.get(key);
  if (hit) {
    dwgCache.delete(key);
    dwgCache.set(key, hit);
    return hit;
  }
  const text = converter.kind === "oda" ? await convertViaOda(converter.program, dwgPath) : await convertViaLibreDwg(converter.program, dwgPath);
  const result = { text, converter: converter.kind };
  while (dwgCache.size >= DWG_CACHE_MAX) dwgCache.delete(dwgCache.keys().next().value);
  dwgCache.set(key, result);
  return result;
}

async function convertViaLibreDwg(program, dwgPath) {
  const out = path.join(os.tmpdir(), `oaw-dwg-${Date.now()}-${Math.random().toString(36).slice(2)}.dxf`);
  try {
    await execFileAsync(program, ["-o", out, dwgPath], { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
    return decodeDxfText(fs.readFileSync(out));
  } finally {
    fs.rmSync(out, { force: true });
  }
}

async function convertViaOda(program, dwgPath) {
  // ODA File Converter 是目录批处理：把单个 DWG 放进临时输入目录，产出 DXF 后读取
  const inDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-dwg-in-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-dwg-out-"));
  try {
    fs.copyFileSync(dwgPath, path.join(inDir, path.basename(dwgPath)));
    await execFileAsync(program, [inDir, outDir, "ACAD2018", "DXF", "0", "1"], { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const produced = fs.readdirSync(outDir).find((f) => /\.dxf$/i.test(f));
    if (!produced) throw new Error("ODA File Converter 未产出 DXF（文件可能损坏或版本不受支持）");
    return decodeDxfText(fs.readFileSync(path.join(outDir, produced)));
  } finally {
    fs.rmSync(inDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/* ==================== 统一读取入口（AC1 预览 / AC3 agent 读取共用） ==================== */

/**
 * 按扩展名读取并解析 CAD 文件 → { format, converter, layers, blocks, entities, entityCounts, extents, truncated }。
 * DXF 直读；DWG 自动经外部转换（无工具时抛安装指引，AC2 降级链路由调用方转述给用户）。
 */
export async function readCadDocument(absPath, { maxEntities = CAD_ENTITY_LIMIT } = {}) {
  if (/\.dwg$/i.test(absPath)) {
    const { text, converter } = await dwgToDxfText(absPath);
    return { format: "dwg", converter, ...parseDxf(text, { maxEntities }) };
  }
  if (!/\.dxf$/i.test(absPath)) throw new Error("仅支持 DXF/DWG 图纸文件");
  const text = decodeDxfText(fs.readFileSync(absPath));
  return { format: "dxf", converter: null, ...parseDxf(text, { maxEntities }) };
}
