/**
 * CAD 白名单修改（CAD 方案 AC4：cad_edit 工具的服务端执行器，零依赖）。
 *
 * 设计约束：
 *   - 只做组码对级的最小手术，不重建整份 DXF：解析为组码对序列，按节/记录改写，
 *     未理解的记录原样保留，最大限度保持与原文件的兼容。
 *   - 修改是纯函数（prepareCadEdit 返回内容不落盘）：落盘统一走 agent 层
 *     writeWorkspaceFile 通道，复用 run 备份/写入清单/审批事件（与 review_copy 同构）。
 *   - DWG 修改链路：DWG→DXF（转换缓存）→改→ODA 回转 DWG；无 ODA 时另存同名 -修改.dxf（AC2 降级）。
 *
 * 白名单操作（5 种）：
 *   replace_text          替换文字：{ find, replace, layer? }        —— TEXT 的组码 1、MTEXT 的组码 1/3
 *   rename_layer          重命名图层：{ from, to }                   —— 图层表 + 全部实体（含块内）组码 8
 *   move_entities         变更实体图层：{ from, to, entityType? }    —— 仅顶层实体组码 8
 *   delete_layer_entities 删除图层实体：{ layer, entityType? }       —— 仅顶层实体
 *   add_entity            新增简单实体：{ type: LINE/CIRCLE/TEXT, layer, x/y/… }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeDxfText, dwgToDxfText, parseDxf, resolveOdaConverter } from "./CAD解析.mjs";

const execFileAsync = promisify(execFile);

/** 修改操作白名单（cad_edit 参数校验与遥测共用）。 */
export const CAD_EDIT_OPS = Object.freeze(["replace_text", "rename_layer", "move_entities", "delete_layer_entities", "add_entity"]);

/** 记录删除哨兵：transformDxf 中表示整条记录（含 0 TYPE 头）丢弃。 */
const DELETE_RECORD = Symbol("delete-record");

/** DXF 文本 → 组码对序列（与解析器同一容错口径：结构非法直接抛错）。 */
function splitPairs(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) {
      throw new Error(`不是有效的 DXF（第 ${i + 1} 行组码无法解析："${lines[i].slice(0, 40)}"）`);
    }
    pairs.push([code, lines[i + 1] ?? ""]);
  }
  return pairs;
}

/** 组码对序列 → DXF 文本（规范化为 \n 行尾、组码顶格，语义与原文件等价）。 */
function pairsToText(pairs) {
  return pairs.map(([c, v]) => `${c}\n${v}`).join("\n");
}

/**
 * 按节遍历记录并改写：
 *   handlers[section]({ section, recordType, record }) →
 *     数组   = 替换记录体（0 TYPE 头保留）
 *     DELETE_RECORD = 整条记录删除
 *     null/undefined = 原样保留
 *   appendices[section]（可选）：遍历到该节 ENDSEC 时追加在节尾（add_entity 用）。
 */
function transformDxf(text, handlers = {}, appendices = null) {
  const pairs = splitPairs(text);
  const out = [];
  let section = "";
  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val === "SECTION") {
      section = String(pairs[i + 1]?.[1] || "").trim();
      out.push(pairs[i], pairs[i + 1]);
      i += 2;
      continue;
    }
    if (code === 0 && val === "ENDSEC") {
      const closing = section;
      if (closing && appendices?.[closing]?.length) out.push(...appendices[closing]);
      section = "";
      out.push(pairs[i]);
      i++;
      continue;
    }
    if (code === 0) {
      const record = [];
      let j = i + 1;
      while (j < pairs.length && pairs[j][0] !== 0) { record.push(pairs[j]); j++; }
      const handler = handlers[section];
      const replacement = handler ? handler({ section, recordType: val, record }) : null;
      if (replacement === DELETE_RECORD) { i = j; continue; }
      if (Array.isArray(replacement)) { out.push(pairs[i], ...replacement); i = j; continue; }
      out.push(pairs[i], ...record);
      i = j;
      continue;
    }
    out.push(pairs[i]);
    i++;
  }
  return pairsToText(out);
}

/** 记录取值工具：首个命中组码的字符串/数值。 */
function recStr(record, code, fallback = "") {
  const hit = record.find(([c]) => c === code);
  return hit ? hit[1].trim() : fallback;
}
function recNum(record, code, fallback = NaN) {
  const hit = record.find(([c]) => c === code);
  if (!hit) return fallback;
  const v = Number.parseFloat(hit[1]);
  return Number.isFinite(v) ? v : fallback;
}

/** 新增实体记录体（0 TYPE 头由 transformDxf 统一补）。 */
function buildEntityBody(op) {
  const layer = String(op.layer || "0").trim() || "0";
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`add_entity 缺少有效参数 ${name}`);
    return n;
  };
  switch (String(op.entityType || "").toUpperCase()) {
    case "LINE":
      return [[8, layer], [10, String(num(op.x, "x"))], [20, String(num(op.y, "y"))], [11, String(num(op.x2, "x2"))], [21, String(num(op.y2, "y2"))]];
    case "CIRCLE":
      return [[8, layer], [10, String(num(op.x, "x"))], [20, String(num(op.y, "y"))], [40, String(num(op.r, "r"))]];
    case "TEXT":
      return [[8, layer], [10, String(num(op.x, "x"))], [20, String(num(op.y, "y"))], [40, String(num(op.h ?? 2.5))], [1, String(op.text ?? "")]];
    default:
      throw new Error(`add_entity 暂只支持 LINE/CIRCLE/TEXT，收到：${op.entityType}`);
  }
}

/**
 * 执行单个白名单操作（纯函数）→ { text, changes }。
 * 抛错带操作序号，便于 agent 定位 ops 序列中的非法项。
 */
export function applyCadEdit(dxfText, op, index = 0) {
  const at = `第 ${index + 1} 个操作`;
  const type = String(op?.type || "");
  if (!CAD_EDIT_OPS.includes(type)) {
    throw new Error(`${at}：不支持的 CAD 修改操作「${type}」（白名单：${CAD_EDIT_OPS.join("、")}）`);
  }
  const changes = { op: type, changed: 0 };

  if (type === "replace_text") {
    const find = String(op.find ?? "");
    if (!find) throw new Error(`${at}：replace_text 缺少 find`);
    const replace = String(op.replace ?? "");
    const layerFilter = op.layer ? String(op.layer) : null;
    const text = transformDxf(dxfText, {
      ENTITIES: ({ recordType, record }) => {
        if (!["TEXT", "MTEXT"].includes(recordType)) return null;
        if (layerFilter && recStr(record, 8) !== layerFilter) return null;
        let hit = false;
        const body = record.map(([c, v]) => {
          if ((recordType === "TEXT" && c === 1) || (recordType === "MTEXT" && (c === 1 || c === 3))) {
            if (String(v).includes(find)) { hit = true; return [c, String(v).split(find).join(replace)]; }
          }
          return [c, v];
        });
        if (hit) changes.changed++;
        return hit ? body : null;
      },
    });
    return { text, changes };
  }

  if (type === "rename_layer") {
    const from = String(op.from ?? "");
    const to = String(op.to ?? "");
    if (!from || !to) throw new Error(`${at}：rename_layer 需要 from 与 to`);
    const renameBody = (record) => record.map(([c, v]) => {
      if (c === 8 && v === from) { changes.changed++; return [c, to]; }
      return [c, v];
    });
    const text = transformDxf(dxfText, {
      TABLES: ({ recordType, record }) => {
        if (recordType !== "LAYER") return null;
        let hit = false;
        const body = record.map(([c, v]) => {
          if (c === 2 && v === from) { hit = true; return [c, to]; }
          return [c, v];
        });
        if (hit) changes.changed++;
        return hit ? body : null;
      },
      ENTITIES: ({ record }) => renameBody(record),
      BLOCKS: ({ record }) => renameBody(record),
    });
    return { text, changes };
  }

  if (type === "move_entities") {
    const from = String(op.from ?? "");
    const to = String(op.to ?? "");
    if (!from || !to) throw new Error(`${at}：move_entities 需要 from 与 to`);
    const typeFilter = op.entityType ? String(op.entityType).toUpperCase() : null;
    const text = transformDxf(dxfText, {
      ENTITIES: ({ recordType, record }) => {
        if (typeFilter && recordType.toUpperCase() !== typeFilter) return null;
        let hit = false;
        const body = record.map(([c, v]) => {
          if (c === 8 && v === from) { hit = true; return [c, to]; }
          return [c, v];
        });
        if (hit) changes.changed++;
        return hit ? body : null;
      },
    });
    return { text, changes };
  }

  if (type === "delete_layer_entities") {
    const layer = String(op.layer ?? "");
    if (!layer) throw new Error(`${at}：delete_layer_entities 缺少 layer`);
    const typeFilter = op.entityType ? String(op.entityType).toUpperCase() : null;
    const text = transformDxf(dxfText, {
      ENTITIES: ({ recordType, record }) => {
        if (typeFilter && recordType.toUpperCase() !== typeFilter) return null;
        if (recStr(record, 8) !== layer) return null;
        changes.changed++;
        return DELETE_RECORD;
      },
    });
    return { text, changes };
  }

  // add_entity
  const body = buildEntityBody(op);
  const entityType = String(op.entityType || "").toUpperCase();
  const appendices = { ENTITIES: [[0, entityType], ...body.map(([c, v]) => [c, v])] };
  const text = transformDxf(dxfText, {}, appendices);
  changes.changed = 1;
  return { text, changes };
}

/**
 * ODA 通用转换：DXF 文本 → 目标格式（dwg/dxf）字节（DXF→DWG 回转用）。
 */
async function convertDxfViaOda(program, dxfText, targetExt, baseName) {
  const inDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-cad-in-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-cad-out-"));
  try {
    fs.writeFileSync(path.join(inDir, `${baseName}.dxf`), dxfText, "utf8");
    await execFileAsync(program, [inDir, outDir, "ACAD2018", String(targetExt).toUpperCase(), "0", "1"], { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const produced = fs.readdirSync(outDir).find((f) => new RegExp(`\\.${String(targetExt).toLowerCase()}$`, "i").test(f));
    if (!produced) throw new Error(`ODA File Converter 未产出 ${targetExt.toUpperCase()}`);
    return fs.readFileSync(path.join(outDir, produced));
  } finally {
    fs.rmSync(inDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * 读取 → 依序应用 ops → 决定落盘形态（不写盘，写入由 agent 层 writeWorkspaceFile 统一登记）。
 * 返回 { content: string|Buffer, targetPath, format, changes, note }。
 */
export async function prepareCadEdit(absPath, ops = [], { outputPath = "" } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw new Error("未提供任何修改操作（ops 为空）");
  let sourceFormat;
  let dxfText;
  if (/\.dwg$/i.test(absPath)) {
    sourceFormat = "dwg";
    dxfText = (await dwgToDxfText(absPath)).text;
  } else if (/\.dxf$/i.test(absPath)) {
    sourceFormat = "dxf";
    dxfText = decodeDxfText(fs.readFileSync(absPath));
  } else {
    throw new Error("仅支持 DXF/DWG 图纸文件");
  }
  parseDxf(dxfText); // 修改前预检：解析不过直接报错，不产出半吊子结果
  let text = dxfText;
  const changes = [];
  for (const [idx, op] of ops.entries()) {
    const result = applyCadEdit(text, op, idx);
    text = result.text;
    changes.push(result.changes);
  }
  if (sourceFormat === "dxf") {
    return { content: text, targetPath: outputPath || absPath, format: "dxf", changes, note: "" };
  }
  // DWG：能 ODA 回转则原格式写回；否则降级另存 -修改.dxf（AC2）
  const converter = await resolveOdaConverter();
  if (converter?.kind === "oda") {
    const buffer = await convertDxfViaOda(converter.program, text, "dwg", path.basename(absPath, path.extname(absPath)));
    return { content: buffer, targetPath: outputPath || absPath, format: "dwg", changes, note: "" };
  }
  const fallback = outputPath && /\.dxf$/i.test(outputPath)
    ? outputPath
    : (outputPath || path.join(path.dirname(absPath), path.basename(absPath).replace(/\.dwg$/i, "") + "-修改.dxf"));
  return {
    content: text,
    targetPath: fallback,
    format: "dxf",
    changes,
    note: "DWG 回转需要 ODA File Converter（未检测到），修改结果已另存为 DXF",
  };
}
