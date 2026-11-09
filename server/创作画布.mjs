/**
 * 创作画布（Work 模式）：画布/画板对象模型的读写、导入、软删除与导出编排。
 *
 * 数据模型唯一事实来源是工作区文件（计划 docs/plans/2026-11-09-003 §3）：
 *
 *   office-workspace/designs/<slug>/
 *   ├─ project/
 *   │  ├─ canvas.json                 # 画布索引（v3 兼容超集）
 *   │  ├─ boards/*.board.json         # 对象板（可编辑）
 *   │  ├─ assets/                     # 图片 / SVG 素材
 *   │  └─ legacy/                     # 兼容导入的 .dc.html（原样保留，不改写）
 *   ├─ exports/                       # 导出产物
 *   ├─ .trash/                        # 画板级软删除
 *   ├─ .history/
 *   │  ├─ index.json                  # 画布级版本索引（format 1：versions[].changes 文件 → sha|null）
 *   │  ├─ objects/<sha256>            # 版本内容（内容寻址，天然去重）
 *   │  └─ *.jsonl                     # 旧版板级快照（只读兼容，迁移后保留）
 *   └─ operations.jsonl               # 操作日志（create/save/delete/import/export）
 *
 * 约束：
 *   - 画布必须位于当前工作区内；所有板路径经 path.resolve 后仍在 designs/<slug>/project 内；
 *   - 写盘一律经 写入协调.mjs 的路径写锁 + 持久化工具.mjs 的原子写；读取不加锁；
 *   - 兼容画布（`boards` 键以 .dc.html/.html 结尾）只读渲染，V1 不写回原文件；
 *   - 错误统一 `throw Object.assign(new Error(msg), { code })`，code 以 CANVAS_ 开头。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isInside } from "./workspace.mjs";
import { appendJsonLine, atomicWriteFile, atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";
import { acquireWriteLockWithRetry, releaseWriteLock, withWriteLock } from "./写入协调.mjs";
import {
  CANVAS_CAPTURE_LIMIT,
  CANVAS_EXPORT_FORMATS,
  buildCanvasExportUrl,
  buildCanvasPptx,
  buildExportFileName,
  normalizeColor,
  normalizeFontFamily,
  reserveExportFile,
  sanitizeSvgMarkup,
  serializeBoardToSvg,
} from "./创作画布导出.mjs";

/** 画布级/画板级限额（计划 §3.2 / §3.3 / §5.8）。 */
export const CANVAS_LIMITS = Object.freeze({
  boards: 200, // 单画布画板数
  pages: 40, // 单画布页数
  files: 512, // 单画布 project 内文件数
  bytes: 256 * 1024 * 1024, // 单画布 project 总大小
  boardBytes: 5 * 1024 * 1024, // 单板文件大小
  elements: 500, // 单板元素数
  textChars: 20000, // 单个文本元素字符数
  boardMin: 40, // 画板宽高下限（CSS px）
  boardMax: 8000, // 画板宽高上限（CSS px）
  exportMaxBoards: 50, // 单次导出板数（§5.8）
  titleChars: 200,
});

/** 导出格式白名单（与服务端导出模块同源）。 */
export const CANVAS_FORMATS = CANVAS_EXPORT_FORMATS;

const DESIGNS_DIR = "designs";
const PROJECT_DIR_NAME = "project";
const CANVAS_FILE = "canvas.json";
const BOARD_DIR = "boards";
const ASSETS_DIR = "assets";
const LEGACY_DIR = "legacy";
const EXPORTS_DIR = "exports";
const TRASH_DIR = ".trash";
const OPERATIONS_FILE = "operations.jsonl";
const JOBS_FILE = ".jobs.json";
// 版本历史（2026-11-09 验收反馈）：每次写入前留存上一版，供画布内恢复。
// 2026-11-09-004：新增画布级版本索引（index.json + objects/），旧板级 JSONL 保留兼容。
const HISTORY_DIR = ".history";
const HISTORY_LIMIT = 20;
const HISTORY_FILE_MAX_BYTES = 8 * 1024 * 1024;
const VERSION_INDEX_FILE = "index.json";
const VERSION_OBJECTS_DIR = "objects";
const VERSION_FORMAT = 1;
const VERSION_KEEP_RECENT = 20;
const VERSION_LIMIT = 200;
const VERSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const VERSION_MERGE_AGENT_MS = 10 * 60 * 1000;
const VERSION_MERGE_UI_MS = 2 * 1000;

const SLUG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const ELEMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.board\.json$/;
const ELEMENT_TYPES = new Set(["text", "rect", "line", "image", "svg"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const VALIGNS = new Set(["top", "middle", "bottom"]);
const IMAGE_FITS = new Set(["cover", "contain", "fill"]);
const TEMPLATE_IDS = new Set(["", "blank", "cover", "onepager", "deck"]);
const ACTORS = new Set(["ui", "agent", "system"]);

/** 导出任务在内存里的并发闸门（同一画布同时只允许 1 个任务，§5.5）。 */
const activeExports = new Set();
let exportSeq = 0;

// ---------- 错误 ----------

/**
 * 构造带 code 的画布错误（调用方按 code 分支）。
 * 约定 code 前缀 CANVAS_，HTTP 层可按 code 映射状态码。
 */
export function canvasError(code, message, details = null) {
  const error = new Error(message);
  error.name = "CanvasError";
  error.code = String(code || "CANVAS_ERROR");
  if (details && typeof details === "object") error.details = details;
  return error;
}

function fail(code, message, details = null) {
  throw canvasError(code, message, details);
}

function normalizeActor(actor) {
  const value = String(actor || "").trim().toLowerCase();
  return ACTORS.has(value) ? value : "ui";
}

function nowIso() {
  return new Date().toISOString();
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function relativeOf(root, target) {
  return path.relative(root, target).replace(/\\/g, "/");
}

// ---------- 工作区与路径 ----------

/** 归一化工作区为 realpath；不存在/不是目录 → CANVAS_WORKSPACE_INVALID。 */
function workspaceRoot(workspace) {
  const raw = String(workspace || "").trim();
  if (!raw) fail("CANVAS_WORKSPACE_INVALID", "工作区路径不能为空");
  const abs = path.resolve(raw);
  let real;
  try { real = fs.realpathSync(abs); } catch {
    fail("CANVAS_WORKSPACE_INVALID", `工作区不存在：${abs}`);
  }
  let stat;
  try { stat = fs.statSync(real); } catch {
    fail("CANVAS_WORKSPACE_INVALID", `工作区不可访问：${abs}`);
  }
  if (!stat.isDirectory()) fail("CANVAS_WORKSPACE_INVALID", `工作区不是文件夹：${abs}`);
  return real;
}

/** slug 校验（允许中文，禁空格/点/斜杠）。 */
function assertSlug(slug) {
  const value = String(slug ?? "").trim();
  if (!value) fail("CANVAS_INVALID", "slug 不能为空");
  if (!SLUG_PATTERN.test(value)) {
    fail("CANVAS_INVALID", `slug 非法：${value}（需满足 ^[\\p{L}\\p{N}][\\p{L}\\p{N}_-]{0,63}$，允许中文，禁空格/点/斜杠）`);
  }
  return value;
}

/** 由标题推导 slug（无法推导时返回空串，由调用方报错）。 */
function slugifyTitle(title) {
  const cleaned = String(title || "")
    // 全角/半角括号、书名号与常见标点都不能进入 slug，统一折叠成连字符。
    .replace(/[\s.\\/:*?"<>|()（）【】\[\]{}｛｝、，,。;；!！?？'“”‘’]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const limited = [...cleaned].slice(0, 64).join("");
  if (!limited) return "";
  const candidate = /^[\p{L}\p{N}]/u.test(limited) ? limited : `canvas-${limited}`;
  return SLUG_PATTERN.test(candidate) ? candidate : "";
}

/** 标题无法推导 slug 时的确定性兜底（导入外部画布用）。 */
function fallbackSlug() {
  const token = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `canvas-${token}`;
}

function designsRoot(root) {
  return path.join(root, DESIGNS_DIR);
}

function canvasDirOf(root, slug) {
  const dir = path.join(designsRoot(root), slug);
  if (!isInside(designsRoot(root), dir) || path.resolve(dir) === path.resolve(designsRoot(root))) {
    fail("CANVAS_PATH_DENIED", `画布路径越界：${slug}`);
  }
  return dir;
}

/**
 * 归一化 project 内相对路径：
 * 拒绝绝对路径/盘符/URL/UNC/`..`/隐藏段，以及 exports、.trash 首段。
 */
function normalizeProjectRelativePath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) fail("CANVAS_PATH_DENIED", "板路径不能为空");
  if (raw.includes("\0")) fail("CANVAS_PATH_DENIED", "板路径含非法字符");
  if (raw.startsWith("/") || raw.startsWith("//") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    fail("CANVAS_PATH_DENIED", `板路径必须是 project 内相对路径（禁绝对路径/盘符/URL）：${raw}`);
  }
  const segments = raw.split("/").filter((item) => item && item !== ".");
  if (!segments.length) fail("CANVAS_PATH_DENIED", "板路径不能为空");
  if (segments.some((item) => item === "..")) fail("CANVAS_PATH_DENIED", `板路径不允许包含 ..：${raw}`);
  if (segments.some((item) => item.startsWith("."))) fail("CANVAS_PATH_DENIED", `板路径不允许隐藏目录/文件：${raw}`);
  const first = segments[0].toLowerCase();
  if (first === EXPORTS_DIR || first === TRASH_DIR) {
    fail("CANVAS_PATH_DENIED", `板路径不能位于 ${EXPORTS_DIR}/ 或 ${TRASH_DIR}/ 下：${raw}`);
  }
  return segments.join("/");
}

/** 可写板路径额外约束：文件名 ASCII、必须以 .board.json 结尾、不得写 legacy/。 */
function assertWritableBoardPath(rel) {
  const segments = rel.split("/");
  const leaf = segments[segments.length - 1];
  if (!BOARD_FILE_PATTERN.test(leaf)) {
    fail("CANVAS_PATH_DENIED", `画板文件名非法：${leaf}（对象板需匹配 [A-Za-z0-9_-]{1,64}.board.json；中文标题请放 title）`);
  }
  if (segments.length > 1 && !/^[A-Za-z0-9_-]{1,64}$/.test(segments[0])) {
    fail("CANVAS_PATH_DENIED", `画板子目录名非法：${segments[0]}（仅允许 [A-Za-z0-9_-]）`);
  }
  if (segments[0].toLowerCase() === LEGACY_DIR) {
    fail("CANVAS_PATH_DENIED", `legacy/ 为原样保留的兼容画布，不允许写入：${rel}`);
  }
  return rel;
}

function assertInsideProject(projectDir, target, rel = "") {
  const base = path.resolve(projectDir);
  const resolved = path.resolve(target);
  if (!isInside(base, resolved) || resolved === base) {
    fail("CANVAS_PATH_DENIED", `路径越界（必须位于 project 内）：${rel || resolved}`);
  }
  if (fs.existsSync(resolved)) {
    let real;
    try { real = fs.realpathSync(resolved); } catch { real = resolved; }
    if (!isInside(base, real)) fail("CANVAS_PATH_DENIED", `路径越界（符号链接逃逸）：${rel || resolved}`);
  }
  return resolved;
}

// ---------- canvas.json ----------

function canvasFileOf(root, slug) {
  return path.join(canvasDirOf(root, slug), PROJECT_DIR_NAME, CANVAS_FILE);
}

function projectDirOf(root, slug) {
  return path.join(canvasDirOf(root, slug), PROJECT_DIR_NAME);
}

function readCanvasIndex(root, slug) {
  const dir = canvasDirOf(root, slug);
  const projectDir = path.join(dir, PROJECT_DIR_NAME);
  const file = path.join(projectDir, CANVAS_FILE);
  if (!fs.existsSync(file)) fail("CANVAS_NOT_FOUND", `画布不存在或缺少 project/canvas.json：${slug}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("CANVAS_INVALID", `canvas.json 不是合法 JSON：${slug}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("CANVAS_INVALID", `canvas.json 结构无效（应为对象）：${slug}`);
  }
  if (!raw.boards || typeof raw.boards !== "object" || Array.isArray(raw.boards)) raw.boards = {};
  return { raw, dir, projectDir, file, slug };
}

function normalizeTitle(value, fallback = "") {
  const title = String(value ?? "").trim();
  if (!title) return String(fallback || "").trim();
  return [...title].slice(0, CANVAS_LIMITS.titleChars).join("");
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 板类型：扩展名优先，其次显式 kind 字段。 */
export function boardKindOf(boardPath, entry = {}) {
  const lower = String(boardPath || "").toLowerCase();
  if (lower.endsWith(".board.json")) return "object";
  if (lower.endsWith(".dc.html") || lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".svg")) return "svg";
  const declared = String(entry?.kind || "").toLowerCase();
  if (declared === "html" || declared === "svg") return declared;
  return "object";
}

/** 宽容归一化 boards 条目（读取/展示用；越界值钳制而不是抛错）。 */
function normalizeBoardEntry(raw, boardPath) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const entry = {
    path: boardPath,
    x: Math.round(clampNumber(source.x, -100000, 100000, 0)),
    y: Math.round(clampNumber(source.y, -100000, 100000, 0)),
    w: Math.round(clampNumber(source.w, CANVAS_LIMITS.boardMin, CANVAS_LIMITS.boardMax, 1280)),
    h: Math.round(clampNumber(source.h, CANVAS_LIMITS.boardMin, CANVAS_LIMITS.boardMax, 720)),
    role: source.role === "slide" ? "slide" : "board",
    kind: boardKindOf(boardPath, source),
  };
  if (source.title != null) entry.title = String(source.title).slice(0, CANVAS_LIMITS.titleChars);
  if (source.page != null && String(source.page)) entry.page = String(source.page).slice(0, 64);
  return entry;
}

/** 严格校验 boards 坐标补丁（写路径用；w/h 越界 → CANVAS_INVALID）。 */
function validateBoardEntryPatch(raw, boardPath, existing = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("CANVAS_INVALID", `板 ${boardPath} 的坐标补丁必须是对象`);
  }
  const merged = { ...(existing || {}) };
  for (const key of ["x", "y", "w", "h", "title", "role", "page", "kind"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) merged[key] = raw[key];
  }
  for (const key of ["x", "y"]) {
    if (!Number.isFinite(Number(merged[key]))) fail("CANVAS_INVALID", `板 ${boardPath} 的 ${key} 必须是数字`);
  }
  for (const key of ["w", "h"]) {
    const n = Number(merged[key] ?? (key === "w" ? 1280 : 720));
    if (!Number.isFinite(n) || n < CANVAS_LIMITS.boardMin || n > CANVAS_LIMITS.boardMax) {
      fail("CANVAS_INVALID", `板 ${boardPath} 的 ${key} 必须在 ${CANVAS_LIMITS.boardMin}–${CANVAS_LIMITS.boardMax} 之间（当前 ${n}）`);
    }
    merged[key] = n;
  }
  if (merged.role != null && !["slide", "board"].includes(String(merged.role))) {
    fail("CANVAS_INVALID", `板 ${boardPath} 的 role 只能是 slide/board`);
  }
  return normalizeBoardEntry(merged, boardPath);
}

function validatePages(raw) {
  if (!Array.isArray(raw)) fail("CANVAS_INVALID", "pages 必须是数组");
  if (raw.length > CANVAS_LIMITS.pages) {
    fail("CANVAS_LIMIT", `pages 超过上限 ${CANVAS_LIMITS.pages}（当前 ${raw.length}）`);
  }
  const ids = new Set();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("CANVAS_INVALID", `pages[${index}] 必须是对象`);
    const id = String(item.id ?? `p${index + 1}`).slice(0, 64);
    if (!id) fail("CANVAS_INVALID", `pages[${index}] 缺少 id`);
    if (ids.has(id)) fail("CANVAS_INVALID", `pages 存在重复 id：${id}`);
    ids.add(id);
    return { id, name: String(item.name ?? id).slice(0, 120) };
  });
}

/** boards 对象 → 按 order 排好序的条目数组（order 缺失的追加在末尾）。 */
function orderedBoardEntries(canvasRaw, projectDir) {
  const source = canvasRaw.boards && typeof canvasRaw.boards === "object" && !Array.isArray(canvasRaw.boards)
    ? canvasRaw.boards : {};
  const keys = Object.keys(source);
  const order = Array.isArray(canvasRaw.order) ? canvasRaw.order.map((item) => String(item)) : [];
  const ordered = [...order.filter((key) => keys.includes(key)), ...keys.filter((key) => !order.includes(key))];
  const seen = new Set();
  const entries = [];
  for (const key of ordered) {
    if (seen.has(key)) continue;
    let rel;
    try { rel = normalizeProjectRelativePath(key); } catch { continue; }
    seen.add(key);
    const entry = normalizeBoardEntry(source[key], rel);
    entry.exists = fs.existsSync(path.join(projectDir, rel));
    entries.push(entry);
  }
  return entries;
}

// ---------- 画板校验 ----------

function requireFinite(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail("CANVAS_INVALID", `${label} 必须是数字`);
  return n;
}

function validateStyle(raw, where) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) fail("CANVAS_INVALID", `${where} 的 style 必须是对象`);
  const style = {};
  if (raw.fontSize !== undefined) style.fontSize = clampNumber(requireFinite(raw.fontSize, `${where} fontSize`), 1, 400, 24);
  if (raw.fontWeight !== undefined) style.fontWeight = Math.round(clampNumber(requireFinite(raw.fontWeight, `${where} fontWeight`), 100, 900, 400));
  if (raw.fontFamily !== undefined) style.fontFamily = normalizeFontFamily(raw.fontFamily);
  if (raw.textAlign !== undefined) {
    const align = String(raw.textAlign || "").toLowerCase();
    if (!TEXT_ALIGNS.has(align)) fail("CANVAS_INVALID", `${where} textAlign 只能是 left/center/right`);
    style.textAlign = align;
  }
  if (raw.valign !== undefined) {
    const valign = String(raw.valign || "").toLowerCase();
    if (!VALIGNS.has(valign)) fail("CANVAS_INVALID", `${where} valign 只能是 top/middle/bottom`);
    style.valign = valign;
  }
  if (raw.lineHeight !== undefined) style.lineHeight = clampNumber(requireFinite(raw.lineHeight, `${where} lineHeight`), 0.5, 4, 1.2);
  if (raw.radius !== undefined) style.radius = clampNumber(requireFinite(raw.radius, `${where} radius`), 0, 800, 0);
  if (raw.strokeWidth !== undefined) style.strokeWidth = clampNumber(requireFinite(raw.strokeWidth, `${where} strokeWidth`), 0, 100, 1);
  if (raw.opacity !== undefined) style.opacity = clampNumber(requireFinite(raw.opacity, `${where} opacity`), 0, 1, 1);
  for (const key of ["color", "fill", "stroke", "background"]) {
    if (raw[key] === undefined) continue;
    const value = String(raw[key] ?? "").trim();
    if (!value) continue;
    const color = normalizeColor(value, "");
    if (!color) fail("CANVAS_INVALID", `${where} 的 ${key} 不是合法颜色：${value}`);
    style[key] = color;
  }
  return style;
}

/** src 相对板文件目录解析，最终必须仍在 project 内（§3.3）。 */
function validateAssetSrc(value, { projectDir, boardDir, where }) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) fail("CANVAS_INVALID", `${where} 需要 src（project 内相对路径）`);
  if (raw.length > 512 || raw.includes("\0")) fail("CANVAS_INVALID", `${where} 的 src 非法`);
  if (raw.startsWith("/") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    fail("CANVAS_INVALID", `${where} 的 src 只能是 project 内相对路径（禁绝对路径/URL/盘符）：${raw}`);
  }
  const resolved = path.resolve(boardDir, raw);
  if (!isInside(projectDir, resolved)) {
    fail("CANVAS_INVALID", `${where} 的 src 解析后越出 project：${raw}`);
  }
  return raw;
}

function validateElement(raw, index, { projectDir, boardDir, ids }) {
  const where = `元素 #${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("CANVAS_INVALID", `${where} 必须是对象`);
  const id = String(raw.id ?? "");
  if (!ELEMENT_ID_PATTERN.test(id)) {
    fail("CANVAS_INVALID", `${where} 的 id 非法：${id || "(空)"}（需匹配 [A-Za-z0-9_-]{1,64}）`);
  }
  if (ids.has(id)) fail("CANVAS_INVALID", `元素 id 重复：${id}`);
  ids.add(id);
  const type = String(raw.type ?? "");
  if (!ELEMENT_TYPES.has(type)) {
    fail("CANVAS_INVALID", `${where}(${id}) 的 type 非法：${type || "(空)"}（可用：text/rect/line/image/svg）`);
  }
  const element = { id, type };
  if (type === "line") {
    element.x1 = clampNumber(requireFinite(raw.x1 ?? 0, `${where} x1`), -100000, 100000, 0);
    element.y1 = clampNumber(requireFinite(raw.y1 ?? 0, `${where} y1`), -100000, 100000, 0);
    element.x2 = clampNumber(requireFinite(raw.x2 ?? 0, `${where} x2`), -100000, 100000, 0);
    element.y2 = clampNumber(requireFinite(raw.y2 ?? 0, `${where} y2`), -100000, 100000, 0);
  } else {
    element.x = clampNumber(requireFinite(raw.x ?? 0, `${where} x`), -100000, 100000, 0);
    element.y = clampNumber(requireFinite(raw.y ?? 0, `${where} y`), -100000, 100000, 0);
    element.w = clampNumber(requireFinite(raw.w ?? 0, `${where} w`), 0, 100000, 0);
    element.h = clampNumber(requireFinite(raw.h ?? 0, `${where} h`), 0, 100000, 0);
  }
  if (type === "text") {
    const text = String(raw.text ?? "");
    if ([...text].length > CANVAS_LIMITS.textChars) {
      fail("CANVAS_LIMIT", `${where}(${id}) 文本超过上限 ${CANVAS_LIMITS.textChars} 字符`);
    }
    element.text = text;
  }
  if (type === "image") {
    element.src = validateAssetSrc(raw.src, { projectDir, boardDir, where: `${where}(${id})` });
    if (raw.fit !== undefined) {
      const fit = String(raw.fit || "").toLowerCase();
      if (!IMAGE_FITS.has(fit)) fail("CANVAS_INVALID", `${where}(${id}) 的 fit 只能是 cover/contain/fill`);
      element.fit = fit;
    }
  }
  if (type === "svg") {
    const hasSrc = raw.src !== undefined && raw.src !== null && String(raw.src).trim() !== "";
    const hasMarkup = raw.markup !== undefined && raw.markup !== null && String(raw.markup).trim() !== "";
    if (hasSrc === hasMarkup) {
      fail("CANVAS_INVALID", `${where}(${id}) 的 svg 元素必须且只能提供 src 或 markup 之一`);
    }
    if (hasSrc) element.src = validateAssetSrc(raw.src, { projectDir, boardDir, where: `${where}(${id})` });
    if (hasMarkup) {
      const markup = String(raw.markup);
      if (markup.length > 400_000) fail("CANVAS_LIMIT", `${where}(${id}) 的内联 SVG 超过 400000 字符`);
      // 落盘即 sanitize（去 script/on*/foreignObject/外链），渲染侧再做一次。
      element.markup = sanitizeSvgMarkup(markup);
    }
    if (raw.fit !== undefined) {
      const fit = String(raw.fit || "").toLowerCase();
      if (!IMAGE_FITS.has(fit)) fail("CANVAS_INVALID", `${where}(${id}) 的 fit 只能是 cover/contain/fill`);
      element.fit = fit;
    }
  }
  element.style = validateStyle(raw.style, `${where}(${id})`);
  return element;
}

/**
 * 校验并归一化对象板（§3.3）。未知字段被丢弃，数值越界被钳制，类型/路径错误抛错。
 */
function validateBoardPayload(raw, { projectDir, boardDir, boardPath }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("CANVAS_INVALID", "画板必须是 JSON 对象");
  const board = {
    v: Math.round(numberOr(raw.v, 1)),
    w: Math.round(clampNumber(requireFinite(raw.w ?? 1280, "板宽 w"), CANVAS_LIMITS.boardMin, CANVAS_LIMITS.boardMax, 1280)),
    h: Math.round(clampNumber(requireFinite(raw.h ?? 720, "板高 h"), CANVAS_LIMITS.boardMin, CANVAS_LIMITS.boardMax, 720)),
  };
  if (raw.background !== undefined) {
    const background = normalizeColor(raw.background, "");
    if (!background) fail("CANVAS_INVALID", `画板背景色非法：${raw.background}`);
    board.background = background;
  } else {
    board.background = "#ffffff";
  }
  const elements = raw.elements === undefined || raw.elements === null ? [] : raw.elements;
  if (!Array.isArray(elements)) fail("CANVAS_INVALID", "elements 必须是数组");
  if (elements.length > CANVAS_LIMITS.elements) {
    fail("CANVAS_LIMIT", `单板元素超过上限 ${CANVAS_LIMITS.elements}（当前 ${elements.length}）`);
  }
  const ids = new Set();
  board.elements = elements.map((element, index) => validateElement(element, index, { projectDir, boardDir, ids }));
  if (raw.rev !== undefined && Number.isFinite(Number(raw.rev))) board.rev = Number(raw.rev);
  return { board, boardPath };
}

// ---------- 操作日志 / 限额测量 ----------

function operationsFileOf(canvasDir) {
  return path.join(canvasDir, OPERATIONS_FILE);
}

function appendOperation(canvasDir, { action, actor = "ui", boardPath = "", rev = 0, summary = "", detail = {} } = {}) {
  try {
    appendJsonLine(operationsFileOf(canvasDir), {
      ts: nowIso(),
      canvas: path.basename(canvasDir),
      action: String(action || ""),
      actor: normalizeActor(actor),
      boardPath: String(boardPath || ""),
      rev: Number(rev) || 0,
      summary: String(summary || "").slice(0, 300),
      detail: detail && typeof detail === "object" ? detail : {},
    });
    return true;
  } catch {
    // 日志失败不影响主流程（与 map.mjs logOperation 同口径）。
    return false;
  }
}

// ---------- 版本历史 ----------

function historyDirOf(canvasDir) {
  return path.join(canvasDir, HISTORY_DIR);
}

function historyFileOf(canvasDir, scope = "board", boardPath = "") {
  const base = scope === "canvas"
    ? "_canvas"
    : String(boardPath || "board").replace(/[\\/:*?"<>|]+/g, "_").replace(/^\.+/, "");
  return path.join(historyDirOf(canvasDir), `${base || "board"}.jsonl`);
}

/** 追加一条快照（只读日志，失败不影响保存主流程；超过条数/体积上限时丢最旧的）。 */
function appendHistorySnapshot(canvasDir, { scope = "board", boardPath = "", rev = 0, actor = "ui", summary = "", content = null } = {}) {
  if (!content || typeof content !== "object") return false;
  try {
    const file = historyFileOf(canvasDir, scope, boardPath);
    ensureDirectory(path.dirname(file));
    const parsed = [];
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
        try { parsed.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
      }
    }
    const payload = JSON.stringify(content);
    parsed.push({
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      at: nowIso(),
      scope,
      boardPath: String(boardPath || ""),
      rev: Number(rev) || 0,
      actor: normalizeActor(actor),
      summary: String(summary || "").slice(0, 200),
      bytes: Buffer.byteLength(payload, "utf8"),
      content,
    });
    while (parsed.length > HISTORY_LIMIT) parsed.shift();
    let text = `${parsed.map((item) => JSON.stringify(item)).join("\n")}\n`;
    while (parsed.length > 1 && Buffer.byteLength(text, "utf8") > HISTORY_FILE_MAX_BYTES) {
      parsed.shift();
      text = `${parsed.map((item) => JSON.stringify(item)).join("\n")}\n`;
    }
    atomicWriteFile(file, text);
    return true;
  } catch {
    return false;
  }
}

// ---------- 画布级版本（2026-11-09-004） ----------

function versionIndexFileOf(canvasDir) {
  return path.join(historyDirOf(canvasDir), VERSION_INDEX_FILE);
}

function versionObjectsDirOf(canvasDir) {
  return path.join(historyDirOf(canvasDir), VERSION_OBJECTS_DIR);
}

function versionObjectFileOf(canvasDir, sha) {
  return path.join(versionObjectsDirOf(canvasDir), String(sha || ""));
}

function sha256Of(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function emptyVersionIndex() {
  return { format: VERSION_FORMAT, next: 1, base: {}, versions: [], notices: [] };
}

function normalizeVersionIndex(raw) {
  const index = emptyVersionIndex();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return index;
  index.next = Math.max(1, Number(raw.next) || 1);
  if (raw.base && typeof raw.base === "object" && !Array.isArray(raw.base)) {
    for (const [key, value] of Object.entries(raw.base)) {
      if (typeof value === "string" && value) index.base[String(key)] = value;
    }
  }
  if (Array.isArray(raw.versions)) {
    for (const item of raw.versions) {
      if (!item || typeof item !== "object") continue;
      const n = Number(item.n) || 0;
      if (!n) continue;
      const changes = {};
      if (item.changes && typeof item.changes === "object" && !Array.isArray(item.changes)) {
        for (const [key, value] of Object.entries(item.changes)) {
          if (value === null) changes[String(key)] = null;
          else if (typeof value === "string" && value) changes[String(key)] = value;
        }
      }
      index.versions.push({
        n,
        first: String(item.first || item.at || ""),
        at: String(item.at || item.first || ""),
        by: ["agent", "human", "system"].includes(item.by) ? item.by : "human",
        user: item.user && typeof item.user === "object" ? item.user : { id: "local", name: "本机用户" },
        runId: item.runId ? String(item.runId) : null,
        summary: String(item.summary || "").slice(0, 300),
        changes,
        ...(Number(item.restoredFrom) ? { restoredFrom: Number(item.restoredFrom) } : {}),
      });
    }
    index.versions.sort((left, right) => left.n - right.n);
    index.next = Math.max(index.next, ...index.versions.map((item) => item.n + 1));
  }
  if (Array.isArray(raw.notices)) index.notices = raw.notices.slice(-20);
  return index;
}

function readVersionIndex(canvasDir) {
  const file = versionIndexFileOf(canvasDir);
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeVersionIndex(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeVersionIndex(canvasDir, index) {
  ensureDirectory(historyDirOf(canvasDir));
  atomicWriteJson(versionIndexFileOf(canvasDir), index);
}

function managedProjectFilePaths(projectDir) {
  const result = [];
  if (!fs.existsSync(projectDir)) return result;
  const stack = [projectDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = relativeOf(projectDir, full);
      if (entry.isDirectory()) {
        if (rel === ASSETS_DIR || rel === LEGACY_DIR) continue;
        stack.push(full);
        continue;
      }
      if (rel === CANVAS_FILE || rel.toLowerCase().endsWith(".board.json")) result.push(rel);
    }
  }
  result.sort();
  return result;
}

function storedVersionContent(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return Buffer.from(`${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function storeVersionObject(canvasDir, content) {
  const buffer = storedVersionContent(content);
  const sha = sha256Of(buffer);
  const file = versionObjectFileOf(canvasDir, sha);
  if (!fs.existsSync(file)) {
    ensureDirectory(versionObjectsDirOf(canvasDir));
    atomicWriteFile(file, buffer);
  }
  return sha;
}

/** 首次写入前记录基线：当前 canvas.json / *.board.json 的内容哈希。 */
function ensureVersionBase(canvasDir, projectDir, { empty = false } = {}) {
  const existing = readVersionIndex(canvasDir);
  if (existing) return existing;
  const index = emptyVersionIndex();
  if (!empty) {
    for (const rel of managedProjectFilePaths(projectDir)) {
      try {
        index.base[rel] = storeVersionObject(canvasDir, fs.readFileSync(path.join(projectDir, rel)));
      } catch { /* 读不到的文件不进入基线 */ }
    }
  }
  writeVersionIndex(canvasDir, index);
  return index;
}

function referencedVersionShas(index) {
  const shas = new Set(Object.values(index.base || {}));
  for (const version of index.versions || []) {
    for (const sha of Object.values(version.changes || {})) if (sha) shas.add(sha);
  }
  return shas;
}

function gcVersionObjects(canvasDir, index) {
  const dir = versionObjectsDirOf(canvasDir);
  if (!fs.existsSync(dir)) return;
  const keep = referencedVersionShas(index);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!keep.has(name)) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* 忽略 GC 失败 */ }
    }
  }
}

function pruneVersionIndex(index) {
  const now = Date.now();
  while (index.versions.length > VERSION_KEEP_RECENT) {
    const oldest = index.versions[0];
    const tooMany = index.versions.length > VERSION_LIMIT;
    const tooOld = now - Date.parse(oldest.at || oldest.first || "") > VERSION_MAX_AGE_MS;
    if (!tooMany && !tooOld) break;
    index.versions.shift();
  }
  return index;
}

/**
 * 记录一次画布级版本。
 * @param {Record<string, string|object|Buffer|null>} writes project 相对路径 → 写入后的内容（null=删除）
 */
function recordCanvasVersion(canvasDir, projectDir, { writes = {}, actor = "ui", runId = null, summary = "", mergeWindowMs = null, restoredFrom = null, forceNew = false } = {}) {
  const changes = {};
  for (const [rawPath, content] of Object.entries(writes || {})) {
    let rel;
    try { rel = normalizeProjectRelativePath(rawPath); } catch { continue; }
    if (rel !== CANVAS_FILE && !rel.toLowerCase().endsWith(".board.json")) continue;
    if (content === undefined) continue;
    changes[rel] = content === null ? null : storeVersionObject(canvasDir, content);
  }
  if (!Object.keys(changes).length) return null;

  const index = ensureVersionBase(canvasDir, projectDir);
  const by = actor === "agent" ? "agent" : actor === "system" ? "system" : "human";
  const at = nowIso();
  const effectiveRunId = runId ? String(runId) : null;
  const windowMs = mergeWindowMs != null
    ? Math.max(0, Number(mergeWindowMs) || 0)
    : (by === "agent" ? VERSION_MERGE_AGENT_MS : VERSION_MERGE_UI_MS);
  const last = index.versions[index.versions.length - 1];
  const merge = !forceNew
    && Boolean(last)
    && last.by === by
    && (effectiveRunId
      ? last.runId === effectiveRunId
      : Date.now() - Date.parse(last.at || last.first || "") <= windowMs);

  let version;
  if (merge) {
    version = last;
    version.changes = { ...(version.changes || {}), ...changes };
    version.at = at;
    if (summary) version.summary = String(summary).slice(0, 300);
    if (effectiveRunId) version.runId = effectiveRunId;
    if (restoredFrom) version.restoredFrom = Number(restoredFrom);
  } else {
    version = {
      n: index.next,
      first: at,
      at,
      by,
      user: by === "agent" ? { id: "agent", name: "Agent" } : by === "system" ? { id: "system", name: "System" } : { id: "local", name: "本机用户" },
      runId: effectiveRunId,
      summary: String(summary || "").slice(0, 300),
      changes,
      ...(restoredFrom ? { restoredFrom: Number(restoredFrom) } : {}),
    };
    index.next += 1;
    index.versions.push(version);
  }
  pruneVersionIndex(index);
  writeVersionIndex(canvasDir, index);
  gcVersionObjects(canvasDir, index);
  return version.n;
}

/** base + 所有 n ≤ upto 的 changes 折叠出的文件 → sha 映射。 */
function foldVersionFiles(index, upto) {
  const files = { ...(index.base || {}) };
  for (const version of index.versions || []) {
    if (version.n > upto) break;
    for (const [rel, sha] of Object.entries(version.changes || {})) {
      if (sha) files[rel] = sha;
      else delete files[rel];
    }
  }
  return files;
}

function versionChangeList(index, version) {
  let previous = { ...(index.base || {}) };
  const byN = new Map();
  for (const item of index.versions || []) {
    const list = [];
    for (const [rel, sha] of Object.entries(item.changes || {})) {
      if (sha === null) list.push({ path: rel, status: "deleted" });
      else list.push({ path: rel, status: previous[rel] ? "modified" : "added" });
    }
    byN.set(item.n, list);
    for (const [rel, sha] of Object.entries(item.changes || {})) {
      if (sha) previous[rel] = sha;
      else delete previous[rel];
    }
  }
  return byN.get(version.n) || [];
}

/** 列出画布级版本（最新在前，不含内容）。 */
export function listCanvasVersions(workspace, slug, { limit = 100 } = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const index = readVersionIndex(dir);
  if (!index) return { items: [], next: 1 };
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const items = index.versions
    .slice()
    .sort((left, right) => right.n - left.n)
    .slice(0, max)
    .map((version) => ({
      n: version.n,
      first: version.first,
      at: version.at,
      by: version.by,
      user: version.user,
      runId: version.runId,
      summary: version.summary,
      restoredFrom: version.restoredFrom || null,
      changes: versionChangeList(index, version),
    }));
  return { items, next: index.next };
}

/** 读单个版本的元数据（含 changes 状态，不含内容）。 */
export function readCanvasVersion(workspace, slug, n) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const index = readVersionIndex(dir);
  const version = index?.versions.find((item) => item.n === Number(n));
  if (!version) fail("CANVAS_VERSION_NOT_FOUND", `版本不存在：${n}`);
  return {
    ...version,
    changes: versionChangeList(index, version),
    files: Object.keys(foldVersionFiles(index, version.n)).length,
  };
}

/** 文件级 diff：from → to（to 省略时对比当前工作区）。 */
export function diffCanvasVersions(workspace, slug, { from = 1, to = null } = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const index = readVersionIndex(dir);
  if (!index) fail("CANVAS_VERSION_NOT_FOUND", "该画布还没有版本历史");
  const fromN = Number(from);
  if (!index.versions.some((item) => item.n === fromN)) fail("CANVAS_VERSION_NOT_FOUND", `版本不存在：${from}`);
  const fromFiles = foldVersionFiles(index, fromN);
  let toFiles;
  if (to == null) {
    toFiles = {};
    for (const rel of managedProjectFilePaths(path.join(dir, PROJECT_DIR_NAME))) {
      try { toFiles[rel] = sha256Of(fs.readFileSync(path.join(dir, PROJECT_DIR_NAME, rel))); } catch { /* 忽略 */ }
    }
  } else {
    const toN = Number(to);
    if (!index.versions.some((item) => item.n === toN)) fail("CANVAS_VERSION_NOT_FOUND", `版本不存在：${to}`);
    toFiles = foldVersionFiles(index, toN);
  }
  const added = Object.keys(toFiles).filter((rel) => !fromFiles[rel]).sort();
  const removed = Object.keys(fromFiles).filter((rel) => !toFiles[rel]).sort();
  const modified = Object.keys(toFiles).filter((rel) => fromFiles[rel] && fromFiles[rel] !== toFiles[rel]).sort();
  return { from: fromN, to: to == null ? null : Number(to), added, removed, modified };
}

/** 从画布级版本恢复（整画布或指定文件）。恢复本身会生成一条新版本。 */
export function restoreCanvasVersion(workspace, slug, { version = 0, paths = null, actor = "ui", runId = null } = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const targetN = Number(version);
  if (!Number.isFinite(targetN) || targetN <= 0) fail("CANVAS_INVALID", "version 必须是正整数");

  return withCanvasLock(root, dir, cleanSlug, () => {
    const index = readVersionIndex(dir);
    const target = index?.versions.find((item) => item.n === targetN);
    if (!target) fail("CANVAS_VERSION_NOT_FOUND", `版本不存在：${version}`);
    const { projectDir, raw } = readCanvasIndex(root, cleanSlug);
    const managed = String(raw.format || "") === "oaw-canvas";
    if (!managed) fail("CANVAS_INVALID", "外部兼容画布不支持版本恢复；请先纳管");
    const folded = foldVersionFiles(index, targetN);
    const selected = Array.isArray(paths) && paths.length
      ? paths.map((item) => normalizeProjectRelativePath(item))
      : null;
    const current = {};
    for (const rel of managedProjectFilePaths(projectDir)) {
      try { current[rel] = sha256Of(fs.readFileSync(path.join(projectDir, rel))); } catch { /* 忽略 */ }
    }
    const allPaths = [...new Set([...Object.keys(current), ...Object.keys(folded)])]
      .filter((rel) => (selected ? selected.includes(rel) : true));
    const writes = {};
    const restored = [];
    const removed = [];
    const trashDir = ensureDirectory(path.join(dir, TRASH_DIR, `restore-${stamp()}`));
    for (const rel of allPaths) {
      const sha = folded[rel] || null;
      const targetFile = path.join(projectDir, rel);
      if (!sha) {
        if (fs.existsSync(targetFile)) {
          const trashFile = path.join(trashDir, rel.replace(/[\\/]+/g, "__"));
          try { fs.renameSync(targetFile, trashFile); } catch { fs.rmSync(targetFile, { force: true }); }
          removed.push(rel);
          writes[rel] = null;
        }
        continue;
      }
      const objectFile = versionObjectFileOf(dir, sha);
      if (!fs.existsSync(objectFile)) fail("CANVAS_VERSION_NOT_FOUND", `版本对象缺失：${sha}`);
      const buffer = fs.readFileSync(objectFile);
      if (rel === CANVAS_FILE) {
        let doc;
        try { doc = JSON.parse(buffer.toString("utf8")); } catch { fail("CANVAS_INVALID", "版本中的 canvas.json 无法解析"); }
        doc.rev = (Number(raw.rev) || 0) + 1;
        doc.updatedAt = nowIso();
        atomicWriteJson(path.join(projectDir, rel), doc);
        writes[rel] = doc;
      } else {
        let board;
        try { board = JSON.parse(buffer.toString("utf8")); } catch { fail("CANVAS_INVALID", `版本中的画板无法解析：${rel}`); }
        const boardPath = assertWritableBoardPath(rel);
        const boardDir = path.dirname(path.join(projectDir, boardPath));
        let currentBoardRev = 0;
        try {
          const currentBoard = JSON.parse(fs.readFileSync(path.join(projectDir, boardPath), "utf8"));
          currentBoardRev = Number(currentBoard?.rev) || 0;
        } catch { /* 当前文件不存在或损坏：按 0 起算 */ }
        board.rev = currentBoardRev + 1;
        const { board: validated } = validateBoardPayload(board, { projectDir, boardDir, boardPath });
        atomicWriteJson(path.join(projectDir, boardPath), validated);
        writes[rel] = validated;
      }
      restored.push(rel);
    }
    const versionNo = recordCanvasVersion(dir, projectDir, {
      writes,
      actor,
      runId,
      summary: `恢复画布版本 ${targetN}` + (selected ? `（${selected.length} 个文件）` : ""),
      restoredFrom: targetN,
      forceNew: true,
    });
    appendOperation(dir, {
      action: "restore",
      actor,
      summary: `恢复画布版本 ${targetN}`,
      detail: { scope: "canvas", restored, removed, restoredFrom: targetN },
    });
    return { ok: true, version: targetN, newVersion: versionNo, restored, removed };
  });
}

/** 画布 project 内文件数与总字节（导出产物不计入画布配额）。 */
function measureProject(projectDir) {
  const result = { files: 0, bytes: 0 };
  if (!fs.existsSync(projectDir)) return result;
  const stack = [projectDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) stack.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      result.files += 1;
      try { result.bytes += fs.statSync(target).size; } catch { /* 文件消失即跳过 */ }
    }
  }
  return result;
}

function assertProjectQuota(projectDir, { extraFiles = 0, extraBytes = 0 } = {}) {
  const measured = measureProject(projectDir);
  if (measured.files + extraFiles > CANVAS_LIMITS.files) {
    fail("CANVAS_LIMIT", `画布文件数超过上限 ${CANVAS_LIMITS.files}（当前 ${measured.files + extraFiles}）`);
  }
  if (measured.bytes + extraBytes > CANVAS_LIMITS.bytes) {
    fail("CANVAS_LIMIT", `画布总大小超过上限 ${Math.round(CANVAS_LIMITS.bytes / 1024 / 1024)}MB（当前 ${Math.round((measured.bytes + extraBytes) / 1024 / 1024)}MB）`);
  }
  return measured;
}

// ---------- 写锁 ----------

function mapLockError(error, slug) {
  if (error?.code === "WRITE_CONFLICT") {
    return canvasError("CANVAS_BUSY", `画布正在被其他任务修改：${slug}（请稍后重试）`, { cause: error.message });
  }
  if (error?.code === "WRITE_SCOPE_ERROR" || error?.code === "WORKSPACE_INVALID") {
    return canvasError("CANVAS_PATH_DENIED", `画布路径不在当前工作区内：${slug}`);
  }
  return error;
}

/** 同步写锁（写路径都是秒级，冲突立即按 CANVAS_BUSY 返回，由调用方重试）。 */
function withCanvasLock(root, canvasDir, slug, fn) {
  const runId = `canvas_${crypto.randomUUID()}`;
  try {
    return withWriteLock({ workspace: root, targetPath: canvasDir, runId, kind: "canvas" }, fn);
  } catch (error) {
    throw mapLockError(error, slug);
  }
}

/** 异步写锁（导出任务可能长时间占用，允许短退避等待）。 */
async function withCanvasLockAsync(root, canvasDir, slug, fn) {
  const runId = `canvas_export_${crypto.randomUUID()}`;
  const timeoutMs = Math.max(0, Number(process.env.OAW_CANVAS_LOCK_TIMEOUT_MS ?? 15000) || 0);
  let token;
  try {
    token = await acquireWriteLockWithRetry({ workspace: root, targetPath: canvasDir, runId, kind: "canvas_export" }, { timeoutMs });
  } catch (error) {
    throw mapLockError(error, slug);
  }
  try {
    return await fn();
  } finally {
    releaseWriteLock(token);
  }
}

// ---------- 模板 ----------

function blankBoard() {
  return { v: 1, w: 1280, h: 720, background: "#ffffff", rev: 1, elements: [] };
}

function headerElements(title) {
  return [
    {
      id: "el-title",
      type: "text",
      x: 80, y: 220, w: 960, h: 140,
      text: String(title || "").slice(0, 200),
      style: { fontSize: 56, fontWeight: 700, fontFamily: "Microsoft YaHei", color: "#141413", textAlign: "left", lineHeight: 1.2 },
    },
    { id: "el-accent", type: "rect", x: 80, y: 384, w: 120, h: 6, style: { fill: "#2f6bff", radius: 3 } },
  ];
}

/** 模板 → 板集合（确定性，无时间戳；可被 createCanvas 直接落盘）。 */
function buildTemplateBoards({ title, kind, template }) {
  const requested = String(template ?? "").trim().toLowerCase();
  if (!TEMPLATE_IDS.has(requested)) {
    fail("CANVAS_INVALID", `未知模板：${template}（可用：blank/cover/onepager/deck）`);
  }
  const effective = requested === "" ? (kind === "deck" ? "deck" : "blank") : requested;
  const role = kind === "deck" ? "slide" : "board";
  const pages = effective === "deck" ? [{ id: "p1", name: "主页面" }] : [];

  if (effective === "cover" || effective === "deck") {
    return {
      pages,
      boards: [{
        path: `${BOARD_DIR}/cover.board.json`,
        entry: { x: 0, y: 0, w: 1280, h: 720, title: "封面", role, ...(pages.length ? { page: pages[0].id } : {}) },
        board: { v: 1, w: 1280, h: 720, background: "#ffffff", rev: 1, elements: headerElements(title) },
      }],
    };
  }
  if (effective === "onepager") {
    return {
      pages: [],
      boards: [{
        path: `${BOARD_DIR}/page.board.json`,
        entry: { x: 0, y: 0, w: 1280, h: 720, title: "一页纸", role },
        board: { v: 1, w: 1280, h: 720, background: "#ffffff", rev: 1, elements: headerElements(title) },
      }],
    };
  }
  return {
    pages: [],
    boards: [{
      path: `${BOARD_DIR}/cover.board.json`,
      entry: { x: 0, y: 0, w: 1280, h: 720, title: "封面", role },
      board: blankBoard(),
    }],
  };
}

// ---------- 公开 API：列表 / 读取 ----------

/**
 * 列出工作区内全部创作画布。
 * @returns {{canvases: Array<{slug, title, kind, boards: number, updatedAt, path: string, dir: string, compatible: boolean}>}}
 *   path = 工作区相对路径（`designs/<slug>/project/canvas.json`）；boards = 板数。
 */
export function listCanvases(workspace) {
  const root = workspaceRoot(workspace);
  const designs = designsRoot(root);
  if (!fs.existsSync(designs)) return { canvases: [] };
  let entries;
  try { entries = fs.readdirSync(designs, { withFileTypes: true }); } catch { return { canvases: [] }; }
  const canvases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!SLUG_PATTERN.test(entry.name)) continue;
    const file = path.join(designs, entry.name, PROJECT_DIR_NAME, CANVAS_FILE);
    if (!fs.existsSync(file)) continue;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { raw = null; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    let updatedAt = String(raw.updatedAt || "");
    if (!updatedAt) {
      try { updatedAt = fs.statSync(file).mtime.toISOString(); } catch { updatedAt = ""; }
    }
    const boardsRaw = raw.boards && typeof raw.boards === "object" && !Array.isArray(raw.boards) ? raw.boards : {};
    const boardKeys = Object.keys(boardsRaw);
    canvases.push({
      slug: entry.name,
      title: String(raw.title || entry.name),
      kind: raw.kind === "deck" ? "deck" : "board",
      boards: boardKeys.length,
      updatedAt,
      path: `${DESIGNS_DIR}/${entry.name}/${PROJECT_DIR_NAME}/${CANVAS_FILE}`,
      dir: `${DESIGNS_DIR}/${entry.name}`,
      compatible: boardKeys.some((key) => boardKindOf(key, boardsRaw[key]) === "html"),
    });
  }
  canvases.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return { canvases };
}

/**
 * 读画布索引 + 板摘要（不返回板内容）。
 * @returns {{canvas: object, boards: Array<{path,x,y,w,h,title,role,kind,exists}>, compatible: boolean, warnings: string[]}}
 *   compatible = 含至少一块 `.dc.html`/`.html` 兼容板。
 */
export function readCanvas(workspace, slug) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const { raw, dir, projectDir } = readCanvasIndex(root, cleanSlug);
  const warnings = [];
  const boards = orderedBoardEntries(raw, projectDir);
  const declared = Object.keys(raw.boards || {});
  if (declared.length !== boards.length) {
    const shown = new Set(boards.map((item) => item.path));
    for (const key of declared) {
      if (!shown.has(key)) warnings.push(`忽略非法或不可达的板路径：${key}`);
    }
  }
  const managed = String(raw.format || "") === "oaw-canvas";
  const canvas = {
    ...raw,
    v: Number(raw.v) || 3,
    title: String(raw.title || cleanSlug),
    kind: raw.kind === "deck" ? "deck" : "board",
    rev: Number(raw.rev) || 0,
    pages: Array.isArray(raw.pages) ? raw.pages : [],
    order: boards.map((item) => item.path),
    managed,
    dir: relativeOf(root, dir),
  };
  return { canvas, boards, compatible: boards.some((item) => item.kind === "html"), warnings };
}

/**
 * 读单块画板。
 * @returns {{board: object, rev: number}}
 *   对象板：解析后的 board JSON（含 rev）；
 *   兼容板：`{ kind: "html", path, title, html }`，rev = 0（不参与 CAS）；
 *   SVG 板：`{ kind: "svg", path, markup }`，rev = 0。
 */
export function readBoard(workspace, slug, boardPath) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const index = readCanvasIndex(root, cleanSlug);
  const rel = normalizeProjectRelativePath(boardPath);
  const target = assertInsideProject(index.projectDir, path.join(index.projectDir, rel), rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    fail("CANVAS_NOT_FOUND", `画板不存在：${rel}`);
  }
  const entry = index.raw.boards?.[rel] || {};
  const kind = boardKindOf(rel, entry);
  if (kind === "html") {
    return {
      board: { kind: "html", path: rel, title: String(entry.title || path.basename(rel)), html: fs.readFileSync(target, "utf8") },
      rev: 0,
    };
  }
  if (kind === "svg") {
    return { board: { kind: "svg", path: rel, title: String(entry.title || path.basename(rel)), markup: fs.readFileSync(target, "utf8") }, rev: 0 };
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    fail("CANVAS_INVALID", `画板 JSON 无法解析：${rel}`);
  }
  if (!board || typeof board !== "object" || Array.isArray(board)) fail("CANVAS_INVALID", `画板 JSON 结构无效：${rel}`);
  return { board, rev: Number(board.rev) || 0 };
}

/** 读操作日志（最新在前），便于产物归属与追溯。 */
export function listOperations(workspace, slug, { limit = 200 } = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  const file = operationsFileOf(dir);
  if (!fs.existsSync(file)) return [];
  const max = Math.max(1, Math.min(1000, Number(limit) || 200));
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let index = lines.length - 1; index >= 0 && out.length < max; index -= 1) {
    try { out.push(JSON.parse(lines[index])); } catch { /* 跳过损坏行 */ }
  }
  return out;
}

// ---------- 公开 API：创建 / 更新 / 写板 ----------

/**
 * 新建画布。
 * @param {string} workspace 工作区绝对路径
 * @param {{slug?: string, title?: string, kind?: "board"|"deck", template?: ""|"blank"|"cover"|"onepager"|"deck", actor?: string}} options
 * @returns {{slug: string, path: string, title: string, kind: string, boards: number, rev: number, dir: string}}
 *   path = 工作区相对路径（`designs/<slug>/project/canvas.json`）。
 */
export function createCanvas(workspace, options = {}) {
  const root = workspaceRoot(workspace);
  const actor = normalizeActor(options?.actor);
  const kind = options?.kind === "deck" ? "deck" : "board";
  const title = normalizeTitle(options?.title) || normalizeTitle(options?.slug);
  if (!title) fail("CANVAS_INVALID", "画布标题不能为空");
  const rawSlug = String(options?.slug ?? "").trim();
  let slug;
  if (rawSlug) {
    slug = assertSlug(rawSlug);
  } else {
    slug = slugifyTitle(title);
    if (!slug) fail("CANVAS_INVALID", `无法从标题生成 slug（${title}），请显式提供 slug`);
  }
  const dir = canvasDirOf(root, slug);
  if (fs.existsSync(dir)) fail("CANVAS_EXISTS", `画布已存在：${slug}`);
  const template = buildTemplateBoards({ title, kind, template: options?.template });

  return withCanvasLock(root, dir, slug, () => {
    if (fs.existsSync(dir)) fail("CANVAS_EXISTS", `画布已存在：${slug}`);
    const projectDir = path.join(dir, PROJECT_DIR_NAME);
    for (const sub of [PROJECT_DIR_NAME, `${PROJECT_DIR_NAME}/${BOARD_DIR}`, `${PROJECT_DIR_NAME}/${ASSETS_DIR}`,
      `${PROJECT_DIR_NAME}/${LEGACY_DIR}`, EXPORTS_DIR, TRASH_DIR]) {
      ensureDirectory(path.join(dir, sub));
    }
    const createdAt = nowIso();
    const boardsMap = {};
    const writtenBoards = {};
    const order = [];
    for (const item of template.boards) {
      const boardRel = assertWritableBoardPath(normalizeProjectRelativePath(item.path));
      assertInsideProject(projectDir, path.join(projectDir, boardRel), boardRel);
      boardsMap[boardRel] = normalizeBoardEntry(item.entry, boardRel);
      order.push(boardRel);
      const boardDir = path.dirname(path.join(projectDir, boardRel));
      const validated = validateBoardPayload(item.board, { projectDir, boardDir, boardPath: boardRel }).board;
      atomicWriteJson(path.join(projectDir, boardRel), validated);
      writtenBoards[boardRel] = validated;
    }
    const canvasDoc = {
      v: 3,
      format: "oaw-canvas",
      title,
      kind,
      rev: 1,
      pages: template.pages,
      boards: boardsMap,
      order,
      notes: {},
      designSystems: [],
      createdAt,
      updatedAt: createdAt,
    };
    atomicWriteJson(path.join(projectDir, CANVAS_FILE), canvasDoc);
    ensureVersionBase(dir, projectDir, { empty: true });
    recordCanvasVersion(dir, projectDir, {
      writes: { [CANVAS_FILE]: canvasDoc, ...writtenBoards },
      actor,
      summary: `新建画布「${title}」（${order.length} 块板）`,
    });
    appendOperation(dir, {
      action: "create",
      actor,
      summary: `新建画布「${title}」（${order.length} 块板）`,
      detail: { kind, template: String(options?.template || ""), boards: order },
    });
    return { slug, path: `${DESIGNS_DIR}/${slug}/${PROJECT_DIR_NAME}/${CANVAS_FILE}`, dir: `${DESIGNS_DIR}/${slug}`, title, kind, boards: order.length, rev: 1 };
  });
}

/** 素材 MIME 白名单（图片 / SVG / 字体，禁止可执行类型）。 */
const ASSET_MIME_BY_EXT = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
});

/**
 * 读取 project 内素材字节（供 `GET /api/canvas/:slug/asset?path=` 路由使用）。
 * 路径必须是 project 内相对路径；只放行图片/SVG/字体白名单，返回 Buffer 与 MIME。
 *
 * @returns {{file: string, relative: string, mime: string, bytes: number, buffer: Buffer}}
 */
export function readCanvasAsset(workspace, slug, assetPath) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const index = readCanvasIndex(root, cleanSlug);
  const rel = normalizeProjectRelativePath(assetPath);
  const target = assertInsideProject(index.projectDir, path.join(index.projectDir, rel), rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    fail("CANVAS_NOT_FOUND", `素材不存在：${rel}`);
  }
  let real;
  try { real = fs.realpathSync(target); } catch { fail("CANVAS_NOT_FOUND", `素材不可读：${rel}`); }
  if (!isInside(index.projectDir, real)) fail("CANVAS_PATH_DENIED", `素材路径越界：${rel}`);
  const ext = path.extname(real).toLowerCase();
  const mime = ASSET_MIME_BY_EXT[ext];
  if (!mime) fail("CANVAS_INVALID", `不支持的素材类型：${ext || "(无扩展名)"}（只允许图片/SVG/字体）`);
  let buffer;
  try { buffer = fs.readFileSync(real); } catch { fail("CANVAS_NOT_FOUND", `素材不可读：${rel}`); }
  return { file: real, relative: rel, mime, bytes: buffer.length, buffer };
}

/**
 * 更新画布索引（标题 / pages / order / 板坐标）。
 * patch 可带 `expectedRev` 做 CAS；带 `actor` 记录操作来源。
 *
 * boards 语义：只给 `boards` 时按字段合并（单板拖动/改属性）；
 * `boards` + `order` 同时给时整体替换（删除板/重排，前端画布状态就是全量映射）。
 * @returns {{rev: number, managed: boolean, boards: number, warnings: string[]}}
 */
export function updateCanvas(workspace, slug, patch = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const actor = normalizeActor(patch?.actor);
  const source = patch && typeof patch === "object" ? patch : {};

  return withCanvasLock(root, dir, cleanSlug, () => {
    const index = readCanvasIndex(root, cleanSlug);
    const { raw, projectDir, file } = index;
    const previousRaw = JSON.parse(JSON.stringify(raw));
    const managed = String(raw.format || "") === "oaw-canvas";
    if (managed) ensureVersionBase(dir, projectDir);
    const currentRev = Number(raw.rev) || 0;
    if (managed && source.expectedRev != null && Number(source.expectedRev) !== currentRev) {
      fail("CANVAS_REV_CONFLICT", `画布已被其他会话修改：${cleanSlug}（期望 rev ${source.expectedRev}，当前 ${currentRev}）`, {
        expectedRev: Number(source.expectedRev), actualRev: currentRev,
      });
    }
    const next = JSON.parse(JSON.stringify(raw));
    const warnings = [];

    if (source.title !== undefined) {
      const title = normalizeTitle(source.title);
      if (!title) fail("CANVAS_INVALID", "标题不能为空");
      next.title = title;
    }

    let boardsRaw = next.boards && typeof next.boards === "object" && !Array.isArray(next.boards) ? { ...next.boards } : {};
    if (source.boards !== undefined) {
      if (!source.boards || typeof source.boards !== "object" || Array.isArray(source.boards)) {
        fail("CANVAS_INVALID", "boards 补丁必须是对象（boardPath → 坐标）");
      }
      // 语义：只给 boards → 按字段合并（前端单板拖动/属性改动）；
      // boards + order 同时给 → 整体替换（前端画布状态是全量映射，删除/重排靠这一形态）。
      const replace = source.order !== undefined;
      const base = replace ? {} : { ...boardsRaw };
      for (const [key, value] of Object.entries(source.boards)) {
        const rel = normalizeProjectRelativePath(key);
        const existed = Object.prototype.hasOwnProperty.call(boardsRaw, rel);
        if (!existed && !fs.existsSync(path.join(projectDir, rel))) {
          fail("CANVAS_INVALID", `画布中没有该板，且 project 内不存在该文件：${rel}`);
        }
        base[rel] = validateBoardEntryPatch(value, rel, existed ? boardsRaw[rel] : null);
      }
      boardsRaw = base;
    }
    const boardKeys = Object.keys(boardsRaw);
    if (boardKeys.length > CANVAS_LIMITS.boards) {
      fail("CANVAS_LIMIT", `画布板数超过上限 ${CANVAS_LIMITS.boards}（当前 ${boardKeys.length}）`);
    }
    next.boards = boardsRaw;

    if (managed) {
      if (source.order !== undefined) {
        if (!Array.isArray(source.order)) fail("CANVAS_INVALID", "order 必须是板路径数组");
        const ordered = [];
        for (const item of source.order) {
          const rel = normalizeProjectRelativePath(item);
          if (!boardKeys.includes(rel)) fail("CANVAS_INVALID", `order 含未登记的板：${rel}`);
          if (!ordered.includes(rel)) ordered.push(rel);
        }
        const missing = boardKeys.filter((key) => !ordered.includes(key));
        if (missing.length) fail("CANVAS_INVALID", `order 必须覆盖全部画板，缺少：${missing.join(", ")}`);
        next.order = ordered;
      } else {
        const kept = Array.isArray(next.order) ? next.order.map(String).filter((key) => boardKeys.includes(key)) : [];
        next.order = [...kept, ...boardKeys.filter((key) => !kept.includes(key))];
      }
      if (source.pages !== undefined) next.pages = validatePages(source.pages);
      else if (!Array.isArray(next.pages)) next.pages = [];
      next.v = Number(next.v) || 3;
      next.format = "oaw-canvas";
      next.rev = currentRev + 1;
    } else {
      // 外部画布只写最小字段（标题/坐标）：不新增 rev/pages/order 等运行字段（§3.4），
      // 但来源文件里本来就有这些字段时保持原值，不破坏外部工具的元数据。
      for (const key of ["rev", "pages", "order"]) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) delete next[key];
      }
      if (source.order !== undefined || source.pages !== undefined) {
        warnings.push("外部兼容画布不写入 order/pages（只写最小字段）；如需纳管请在 canvas.json 增加 format: oaw-canvas");
      }
      if (!next.updatedAt) next.updatedAt = nowIso();
    }
    next.updatedAt = nowIso();

    atomicWriteJson(file, next);
    if (managed) {
      appendHistorySnapshot(dir, {
        scope: "canvas",
        rev: currentRev,
        actor,
        summary: "更新画布索引前版本",
        content: previousRaw,
      });
      recordCanvasVersion(dir, projectDir, {
        writes: { [CANVAS_FILE]: next },
        actor,
        runId: source?.runId || null,
        summary: String(source?.summary || "更新画布索引"),
        mergeWindowMs: source?.mergeWindowMs,
      });
    }
    appendOperation(dir, {
      action: "save",
      actor,
      rev: managed ? next.rev : 0,
      summary: managed ? "更新画布索引" : "更新外部画布最小字段",
      detail: { scope: "canvas", keys: Object.keys(source).filter((key) => key !== "actor" && key !== "expectedRev") },
    });
    return { rev: managed ? next.rev : 0, managed, boards: boardKeys.length, warnings };
  });
}

/**
 * 写入单块对象板（CAS）。
 * @param {string} workspace 工作区绝对路径
 * @param {string} slug 画布 slug
 * @param {string} boardPath project 内相对路径（必须以 .board.json 结尾）
 * @param {object} board 板 JSON（按 §3.3 校验后落盘）
 * @param {{expectedRev?: number, actor?: string, page?: string, title?: string, role?: "board"|"slide", layout?: object, runId?: string, summary?: string}} [options]
 * @returns {{rev: number, created: boolean, canvasRev: number, path: string, page: string}}
 */
export function writeBoard(workspace, slug, boardPath, board, options = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const rel = assertWritableBoardPath(normalizeProjectRelativePath(boardPath));
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const actor = normalizeActor(options?.actor);
  const expectedRev = options?.expectedRev != null ? Number(options.expectedRev) : null;
  const requestedPage = options?.page != null ? String(options.page).slice(0, 64) : "";
  const requestedTitle = options?.title != null ? normalizeTitle(options.title) : "";

  return withCanvasLock(root, dir, cleanSlug, () => {
    const index = readCanvasIndex(root, cleanSlug);
    const { projectDir, raw } = index;
    const managed = String(raw.format || "") === "oaw-canvas";
    if (managed) ensureVersionBase(dir, projectDir);
    const target = assertInsideProject(projectDir, path.join(projectDir, rel), rel);
    const existed = fs.existsSync(target);
    if (existed && !fs.statSync(target).isFile()) fail("CANVAS_INVALID", `目标不是文件：${rel}`);

    let currentRev = 0;
    let previousBoard = null;
    if (existed) {
      try {
        const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
        previousBoard = parsed;
        currentRev = Number(parsed?.rev) || 0;
      } catch {
        fail("CANVAS_INVALID", `已有画板 JSON 无法解析，拒绝覆盖：${rel}（请先用 readBoard 检查或改路径）`);
      }
    }
    if (expectedRev != null && Number.isFinite(expectedRev) && expectedRev !== currentRev) {
      fail("CANVAS_REV_CONFLICT", `画板已被其他会话修改：${rel}（期望 rev ${expectedRev}，当前 ${currentRev}）`, {
        expectedRev, actualRev: currentRev, boardPath: rel,
      });
    }
    if (!existed && !managed) {
      fail("CANVAS_INVALID", "外部兼容画布不支持新增对象板；请先纳管（canvas.json 增加 format: oaw-canvas）");
    }

    const boardDir = path.dirname(target);
    const { board: validated } = validateBoardPayload(board, { projectDir, boardDir, boardPath: rel });
    validated.rev = currentRev + 1;
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > CANVAS_LIMITS.boardBytes) {
      fail("CANVAS_LIMIT", `画板文件超过上限 ${Math.round(CANVAS_LIMITS.boardBytes / 1024 / 1024)}MB（当前 ${Math.round(bytes / 1024 / 1024)}MB）`);
    }
    if (!existed) {
      const boardsCount = Object.keys(raw.boards || {}).length;
      if (boardsCount >= CANVAS_LIMITS.boards) {
        fail("CANVAS_LIMIT", `画布板数超过上限 ${CANVAS_LIMITS.boards}（当前 ${boardsCount}）`);
      }
      assertProjectQuota(projectDir, { extraFiles: 1, extraBytes: bytes });
    }
    ensureDirectory(boardDir);
    atomicWriteFile(target, serialized);

    let canvasRev = Number(raw.rev) || 0;
    let nextCanvas = null;
    let boardPage = "";
    if (!existed) {
      const pages = Array.isArray(raw.pages) ? raw.pages : [];
      if (requestedPage) {
        if (!pages.some((item) => String(item?.id) === requestedPage)) {
          fail("CANVAS_PAGE_NOT_FOUND", `页不存在：${requestedPage}`);
        }
        boardPage = requestedPage;
      } else if (pages.length) {
        boardPage = String(pages[0]?.id || "");
      }
      const layout = options?.layout && typeof options.layout === "object" ? options.layout : {};
      const boardsRaw = raw.boards && typeof raw.boards === "object" && !Array.isArray(raw.boards) ? { ...raw.boards } : {};
      const entries = Object.entries(boardsRaw).map(([key, value]) => normalizeBoardEntry(value, key));
      const maxBottom = entries.reduce((acc, item) => Math.max(acc, item.y + item.h), 0);
      const nextX = Number.isFinite(Number(layout.x)) ? Number(layout.x) : 0;
      const nextY = Number.isFinite(Number(layout.y)) ? Number(layout.y) : (entries.length ? maxBottom + 120 : 0);
      boardsRaw[rel] = normalizeBoardEntry({
        // 坐标按板自身尺寸登记，导出计划/截图尺寸才与画板一致（否则会被当成 1280×720）。
        x: nextX, y: nextY,
        w: Number(layout.w) || validated.w,
        h: Number(layout.h) || validated.h,
        title: requestedTitle || path.basename(rel).replace(/\.board\.json$/i, ""),
        role: options?.role === "slide" ? "slide" : (raw.kind === "deck" ? "slide" : "board"),
        ...(boardPage ? { page: boardPage } : {}),
      }, rel);
      const keptOrder = Array.isArray(raw.order) ? raw.order.map(String).filter((key) => boardsRaw[key]) : [];
      const order = [...keptOrder, ...Object.keys(boardsRaw).filter((key) => !keptOrder.includes(key))];
      nextCanvas = { ...raw, boards: boardsRaw, order, updatedAt: nowIso() };
      nextCanvas.v = Number(nextCanvas.v) || 3;
      nextCanvas.format = "oaw-canvas";
      nextCanvas.rev = canvasRev + 1;
      canvasRev = nextCanvas.rev;
      atomicWriteJson(canvasFileOf(root, cleanSlug), nextCanvas);
    }

    appendOperation(dir, {
      action: "save",
      actor,
      boardPath: rel,
      rev: validated.rev,
      summary: String(options?.summary || `${existed ? "保存" : "新增"}画板 ${rel}`).slice(0, 300),
      detail: { scope: "board", elements: validated.elements.length, bytes, created: !existed },
    });
    if (previousBoard) {
      appendHistorySnapshot(dir, {
        scope: "board",
        boardPath: rel,
        rev: currentRev,
        actor,
        summary: `保存前版本（rev ${currentRev}）`,
        content: previousBoard,
      });
    }
    if (managed) {
      const writes = { [rel]: validated };
      if (nextCanvas) writes[CANVAS_FILE] = nextCanvas;
      recordCanvasVersion(dir, projectDir, {
        writes,
        actor,
        runId: options?.runId || null,
        summary: options?.summary || `${existed ? "保存" : "新增"}画板 ${rel}`,
      });
    }
    return {
      rev: validated.rev,
      created: !existed,
      canvasRev,
      path: rel,
      page: boardPage || String(raw.boards?.[rel]?.page || ""),
    };
  });
}

// ---------- 公开 API：版本历史 ----------

/** 列出某块板（或画布索引）的历史快照元数据（不含内容），按时间倒序。 */
export function listCanvasHistory(workspace, slug, { boardPath = "", scope = "board" } = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const file = historyFileOf(dir, scope, boardPath);
  if (!fs.existsSync(file)) return { items: [] };
  const items = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        items.push({
          id: String(entry.id || ""),
          at: String(entry.at || ""),
          rev: Number(entry.rev) || 0,
          actor: normalizeActor(entry.actor),
          summary: String(entry.summary || ""),
          bytes: Number(entry.bytes) || 0,
          scope: String(entry.scope || scope),
        });
      } catch { /* 跳过损坏行 */ }
    }
  } catch {
    return { items: [] };
  }
  items.sort((left, right) => String(right.at).localeCompare(String(left.at)));
  return { items };
}

/** 把一条历史快照恢复为当前板内容（写入前仍会留存当前版本）。 */
export function restoreBoardHistory(workspace, slug, { boardPath = "", id = "", expectedRev = null, actor = "ui" } = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const rel = assertWritableBoardPath(normalizeProjectRelativePath(boardPath));
  const file = historyFileOf(dir, "board", rel);
  if (!fs.existsSync(file)) fail("CANVAS_HISTORY_NOT_FOUND", "该画板还没有历史版本");
  let snapshot = null;
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (String(entry.id) === String(id)) { snapshot = entry; break; }
      } catch { /* 跳过损坏行 */ }
    }
  } catch {
    snapshot = null;
  }
  if (!snapshot?.content) fail("CANVAS_HISTORY_NOT_FOUND", `历史版本不存在：${id}`);
  return writeBoard(workspace, cleanSlug, rel, snapshot.content, {
    expectedRev: expectedRev != null ? Number(expectedRev) : undefined,
    actor,
    summary: `恢复历史版本 rev ${Number(snapshot.rev) || 0}`,
  });
}

// ---------- 公开 API：删除 ----------

/** 画板软删除：移入 `designs/<slug>/.trash/<时间戳>/`，并从 canvas.json 移除登记。 */
export function deleteBoard(workspace, slug, boardPath, options = {}) {
  if (options?.confirmed !== true) fail("CANVAS_CONFIRM_REQUIRED", "删除画板需要显式 confirmed: true");
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const rel = normalizeProjectRelativePath(boardPath);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const actor = normalizeActor(options?.actor);

  return withCanvasLock(root, dir, cleanSlug, () => {
    const index = readCanvasIndex(root, cleanSlug);
    const { projectDir, raw } = index;
    const managed = String(raw.format || "") === "oaw-canvas";
    if (managed) ensureVersionBase(dir, projectDir);
    const target = assertInsideProject(projectDir, path.join(projectDir, rel), rel);
    if (!fs.existsSync(target)) fail("CANVAS_NOT_FOUND", `画板不存在：${rel}`);
    const trashDir = ensureDirectory(path.join(dir, TRASH_DIR, stamp()));
    const trashFile = path.join(trashDir, path.basename(rel));
    try {
      fs.renameSync(target, trashFile);
    } catch {
      fs.copyFileSync(target, trashFile);
      fs.rmSync(target, { force: true });
    }
    let rev = Number(raw.rev) || 0;
    let nextCanvas = null;
    if (managed && raw.boards && Object.prototype.hasOwnProperty.call(raw.boards, rel)) {
      const next = JSON.parse(JSON.stringify(raw));
      delete next.boards[rel];
      const keys = Object.keys(next.boards);
      next.order = (Array.isArray(next.order) ? next.order.map(String) : []).filter((key) => keys.includes(key));
      next.rev = rev + 1;
      next.updatedAt = nowIso();
      rev = next.rev;
      nextCanvas = next;
      atomicWriteJson(index.file, next);
    }
    if (managed) {
      recordCanvasVersion(dir, projectDir, {
        writes: { [rel]: null, ...(nextCanvas ? { [CANVAS_FILE]: nextCanvas } : {}) },
        actor,
        runId: options?.runId || null,
        summary: String(options?.summary || `删除画板 ${rel}（软删）`),
      });
    }
    appendOperation(dir, {
      action: "delete",
      actor,
      boardPath: rel,
      rev,
      summary: `删除画板 ${rel}（软删）`,
      detail: { scope: "board", trash: relativeOf(root, trashFile) },
    });
    return { ok: true, slug: cleanSlug, boardPath: rel, trash: relativeOf(root, trashFile), rev };
  });
}

/** 生成不冲突的板路径（ASCII 文件名；标题只用于可读性，不直接进路径）。 */
function uniqueBoardPath(projectDir, rawBoards, preferred = "") {
  const boards = rawBoards && typeof rawBoards === "object" ? rawBoards : {};
  const base = String(preferred || "").replace(/\.board\.json$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "board";
  for (let index = 1; index < 1000; index += 1) {
    const name = index === 1 ? `${base}.board.json` : `${base}-${index}.board.json`;
    const rel = `${BOARD_DIR}/${name}`;
    if (!Object.prototype.hasOwnProperty.call(boards, rel) && !fs.existsSync(path.join(projectDir, rel))) return rel;
  }
  fail("CANVAS_LIMIT", "无法生成不冲突的画板路径");
}

/**
 * 新建一块画板（画布内“子画布”）。
 * @param {{path?: string, title?: string, template?: "blank"|"cover"|"onepager", page?: string, layout?: object, role?: "board"|"slide", actor?: string, runId?: string}} options
 */
export function createBoard(workspace, slug, options = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const index = readCanvasIndex(root, cleanSlug);
  const title = normalizeTitle(options?.title) || "画板";
  const rel = options?.path
    ? assertWritableBoardPath(normalizeProjectRelativePath(options.path))
    : uniqueBoardPath(index.projectDir, index.raw.boards);
  if (Object.prototype.hasOwnProperty.call(index.raw.boards || {}, rel) || fs.existsSync(path.join(index.projectDir, rel))) {
    fail("CANVAS_EXISTS", `画板已存在：${rel}`);
  }
  const layout = options?.layout && typeof options.layout === "object" ? options.layout : {};
  const width = Math.round(clampNumber(layout.w, CANVAS_LIMITS.boardMin, CANVAS_LIMITS.boardMax, 1280));
  const height = Math.round(clampNumber(layout.h, CANVAS_LIMITS.boardMin, CANVAS_LIMITS.boardMax, 720));
  const template = String(options?.template || "").trim().toLowerCase();
  const board = {
    v: 1,
    w: width,
    h: height,
    background: "#ffffff",
    rev: 1,
    elements: template === "cover" || template === "onepager" ? headerElements(title) : [],
  };
  const saved = writeBoard(workspace, cleanSlug, rel, board, {
    actor: options?.actor,
    page: options?.page,
    title,
    role: options?.role,
    layout: { x: layout.x, y: layout.y, w: width, h: height },
    runId: options?.runId,
    summary: `新增画板「${title}」`,
  });
  return { slug: cleanSlug, boardPath: rel, title, page: saved.page, rev: saved.rev, canvasRev: saved.canvasRev, board };
}

/** 复制一块画板（元素 id 重新生成；插入到源板之后）。 */
export function duplicateBoard(workspace, slug, boardPath, options = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const index = readCanvasIndex(root, cleanSlug);
  const sourceRel = assertWritableBoardPath(normalizeProjectRelativePath(boardPath));
  const source = readBoard(workspace, cleanSlug, sourceRel);
  if (source.board?.kind === "html" || source.board?.kind === "svg") {
    fail("CANVAS_UNSUPPORTED", "兼容板/矢量板不支持复制为对象板");
  }
  const clone = JSON.parse(JSON.stringify(source.board || {}));
  const used = new Set();
  clone.elements = (Array.isArray(clone.elements) ? clone.elements : []).map((element, elementIndex) => {
    let id = `el-copy-${elementIndex + 1}`;
    let suffix = 2;
    while (used.has(id)) { id = `el-copy-${elementIndex + 1}-${suffix}`; suffix += 1; }
    used.add(id);
    return { ...element, id };
  });
  clone.rev = 1;
  const sourceEntry = index.raw.boards?.[sourceRel] || {};
  const title = normalizeTitle(options?.title) || `${String(sourceEntry.title || path.basename(sourceRel)).slice(0, 100)} 副本`;
  const rel = options?.path
    ? assertWritableBoardPath(normalizeProjectRelativePath(options.path))
    : uniqueBoardPath(index.projectDir, index.raw.boards, `${path.basename(sourceRel).replace(/\.board\.json$/i, "")}-copy`);
  const saved = writeBoard(workspace, cleanSlug, rel, clone, {
    actor: options?.actor,
    page: options?.page !== undefined ? options.page : sourceEntry.page,
    title,
    role: sourceEntry.role,
    layout: options?.layout && typeof options.layout === "object" ? options.layout : null,
    runId: options?.runId,
    summary: `复制画板 ${sourceRel} → ${rel}`,
  });
  return { slug: cleanSlug, source: sourceRel, boardPath: rel, title, page: saved.page, rev: saved.rev, canvasRev: saved.canvasRev };
}

/**
 * 更新页（新建/重命名/排序/删除）。删除页时把该页的画板移动到 moveTo（缺省第一页）。
 * @param {{pages: Array<{id:string,name:string}>, moveTo?: string, expectedRev?: number, actor?: string, runId?: string}} options
 */
export function updatePages(workspace, slug, options = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const index = readCanvasIndex(root, cleanSlug);
  const managed = String(index.raw.format || "") === "oaw-canvas";
  if (!managed) fail("CANVAS_INVALID", "外部兼容画布不支持页管理；请先纳管");
  const nextPages = validatePages(options?.pages);
  const nextIds = new Set(nextPages.map((item) => item.id));
  const currentPages = Array.isArray(index.raw.pages) ? index.raw.pages : [];
  const currentIds = new Set(currentPages.map((item) => String(item?.id || "")));
  const removed = [...currentIds].filter((id) => id && !nextIds.has(id));
  const movedBoards = {};
  if (removed.length) {
    const affected = Object.entries(index.raw.boards || {})
      .filter(([, entry]) => removed.includes(String(entry?.page || "")));
    if (affected.length) {
      const moveTo = String(options?.moveTo || "").trim();
      if (moveTo && !nextIds.has(moveTo)) fail("CANVAS_PAGE_NOT_FOUND", `moveTo 页不存在：${moveTo}`);
      if (!moveTo && !nextPages.length) fail("CANVAS_INVALID", "至少保留一页，或显式提供 moveTo");
      const target = moveTo || nextPages[0].id;
      for (const [rel] of affected) movedBoards[rel] = { page: target };
    }
  }
  const updated = updateCanvas(workspace, cleanSlug, {
    pages: nextPages,
    ...(Object.keys(movedBoards).length ? { boards: movedBoards } : {}),
    expectedRev: options?.expectedRev,
    actor: options?.actor,
    runId: options?.runId,
    summary: String(options?.summary || "更新画布页"),
  });
  return { ...updated, pages: nextPages, movedBoards: Object.keys(movedBoards), removedPages: removed };
}


/**
 * 画布软删除：整体移入 `designs/.trash/`（不物理删除，可人工恢复）。
 * @param {{confirmed?: boolean, actor?: string}} [options] 必须 confirmed: true
 * @returns {{ok: boolean, slug: string, trash: string}}
 */
export function deleteCanvas(workspace, slug, options = {}) {
  if (options?.confirmed !== true) fail("CANVAS_CONFIRM_REQUIRED", "删除画布需要显式 confirmed: true");
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const dir = canvasDirOf(root, cleanSlug);
  if (!fs.existsSync(dir)) fail("CANVAS_NOT_FOUND", `画布不存在：${cleanSlug}`);
  const actor = normalizeActor(options?.actor);

  return withCanvasLock(root, dir, cleanSlug, () => {
    appendOperation(dir, {
      action: "delete",
      actor,
      summary: `删除画布「${cleanSlug}」（软删到 designs/.trash）`,
      detail: { scope: "canvas" },
    });
    const trashRoot = ensureDirectory(path.join(designsRoot(root), TRASH_DIR));
    let target = path.join(trashRoot, `${cleanSlug}-${stamp()}`);
    let index = 2;
    while (fs.existsSync(target)) {
      target = path.join(trashRoot, `${cleanSlug}-${stamp()}-${index}`);
      index += 1;
    }
    try {
      fs.renameSync(dir, target);
    } catch {
      fs.cpSync(dir, target, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true, slug: cleanSlug, trash: relativeOf(root, target) };
  });
}

// ---------- 公开 API：兼容画布导入 ----------

/** 递归复制目录（保持原字节），跳过隐藏项与指定名字。 */
function copyTree(srcDir, destDir, { skipNames = new Set(), maxFiles = CANVAS_LIMITS.files } = {}) {
  const stack = [srcDir];
  let files = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (skipNames.has(entry.name)) continue;
      const src = path.join(current, entry.name);
      const rel = path.relative(srcDir, src);
      const dest = path.join(destDir, rel);
      if (entry.isDirectory()) {
        ensureDirectory(dest);
        stack.push(src);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > maxFiles) fail("CANVAS_LIMIT", `导入文件数超过上限 ${maxFiles}`);
      ensureDirectory(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
  }
  return files;
}

/** 解析导入来源：画布根目录 / project 目录 / canvas.json 均可。 */
function resolveImportSource(root, sourcePath) {
  const raw = String(sourcePath ?? "").trim();
  if (!raw) fail("CANVAS_INVALID", "导入需要 sourcePath（工作区内画布目录或 canvas.json）");
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  // 先按字面路径做边界检查，再 realpath：既拦住 ../ 逃逸，也不让越界路径以“不存在”混过去。
  if (!isInside(root, abs)) fail("CANVAS_PATH_DENIED", `导入来源必须位于当前工作区内：${raw}`);
  let real;
  try { real = fs.realpathSync(abs); } catch { fail("CANVAS_NOT_FOUND", `导入来源不存在：${raw}`); }
  if (!isInside(root, real)) fail("CANVAS_PATH_DENIED", `导入来源必须位于当前工作区内：${raw}`);
  const stat = fs.statSync(real);
  if (stat.isFile()) {
    if (path.basename(real).toLowerCase() !== CANVAS_FILE) {
      fail("CANVAS_INVALID", `导入来源文件必须是 canvas.json：${raw}`);
    }
    return { projectDir: path.dirname(real), canvasRoot: path.dirname(path.dirname(real)), canvasFile: real };
  }
  const candidates = [real, path.join(real, PROJECT_DIR_NAME), path.dirname(real)];
  for (const candidate of candidates) {
    const file = path.join(candidate, CANVAS_FILE);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const projectDir = candidate;
    const canvasRoot = path.basename(candidate) === PROJECT_DIR_NAME ? path.dirname(candidate) : candidate;
    return { projectDir, canvasRoot, canvasFile: file };
  }
  fail("CANVAS_INVALID", `导入来源不是创作画布（缺少 project/canvas.json）：${raw}`);
  return null;
}

/**
 * 导入兼容画布：把来源 `project/` 内容复制到 `designs/<slug>/project/legacy/`（保持原字节），
 * 只写本产品需要的最小字段，不改来源文件。
 * @returns {{slug: string, boards: Array<object>, boardCount: number, path: string, compatible: boolean}}
 */
export function importCanvas(workspace, options = {}) {
  const root = workspaceRoot(workspace);
  const actor = normalizeActor(options?.actor);
  const source = resolveImportSource(root, options?.sourcePath);
  let sourceIndex;
  try {
    sourceIndex = JSON.parse(fs.readFileSync(source.canvasFile, "utf8"));
  } catch {
    fail("CANVAS_INVALID", `导入来源的 canvas.json 不是合法 JSON：${options?.sourcePath}`);
  }
  if (!sourceIndex || typeof sourceIndex !== "object" || Array.isArray(sourceIndex)) {
    fail("CANVAS_INVALID", `导入来源的 canvas.json 结构无效：${options?.sourcePath}`);
  }
  const sourceBoards = sourceIndex.boards && typeof sourceIndex.boards === "object" && !Array.isArray(sourceIndex.boards)
    ? sourceIndex.boards : {};
  const sourceKeys = Object.keys(sourceBoards);
  if (!sourceKeys.length) fail("CANVAS_INVALID", "导入来源画布没有画板");

  const title = normalizeTitle(options?.title) || normalizeTitle(sourceIndex.title) || "导入画布";
  const rawSlug = String(options?.slug ?? "").trim();
  const slug = rawSlug
    ? assertSlug(rawSlug)
    : assertSlug(slugifyTitle(sourceIndex.title || title) || slugifyTitle(title) || fallbackSlug());
  const dir = canvasDirOf(root, slug);
  if (fs.existsSync(dir)) fail("CANVAS_EXISTS", `画布已存在：${slug}`);

  return withCanvasLock(root, dir, slug, () => {
    if (fs.existsSync(dir)) fail("CANVAS_EXISTS", `画布已存在：${slug}`);
    const projectDir = ensureDirectory(path.join(dir, PROJECT_DIR_NAME));
    for (const sub of [BOARD_DIR, ASSETS_DIR, LEGACY_DIR]) ensureDirectory(path.join(projectDir, sub));
    ensureDirectory(path.join(dir, EXPORTS_DIR));
    ensureDirectory(path.join(dir, TRASH_DIR));
    const legacyDir = path.join(projectDir, LEGACY_DIR);
    try {
      // 整棵 project 树复制到 legacy/（保持相对引用可用），canvas.json 不复制。
      const copiedFiles = copyTree(source.projectDir, legacyDir, { skipNames: new Set([CANVAS_FILE]) });
      if (!copiedFiles) fail("CANVAS_INVALID", "导入来源没有可复制的文件");
      // 素材同时镜像到 project/assets，对象板的 ../assets/... 引用保持可用。
      const sourceAssets = path.join(source.projectDir, ASSETS_DIR);
      if (fs.existsSync(sourceAssets) && fs.statSync(sourceAssets).isDirectory()) {
        copyTree(sourceAssets, path.join(projectDir, ASSETS_DIR));
      }
      const measured = assertProjectQuota(projectDir);

      const boardsMap = {};
      const boards = [];
      const order = [];
      const sourceOrder = Array.isArray(sourceIndex.order) ? sourceIndex.order.map(String) : [];
      const orderedKeys = [...sourceOrder.filter((key) => sourceKeys.includes(key)), ...sourceKeys.filter((key) => !sourceOrder.includes(key))];
      for (const key of orderedKeys) {
        let rel;
        try { rel = normalizeProjectRelativePath(key); } catch { continue; }
        const targetRel = `${LEGACY_DIR}/${rel}`;
        const copied = path.join(projectDir, targetRel);
        if (!fs.existsSync(copied) || !fs.statSync(copied).isFile()) continue;
        const entry = normalizeBoardEntry(sourceBoards[key], targetRel);
        boardsMap[targetRel] = entry;
        boards.push(entry);
        order.push(targetRel);
      }
      if (!boards.length) fail("CANVAS_INVALID", "导入来源画布没有可复制的画板文件");

      const createdAt = nowIso();
      const canvasDoc = {
        v: 3,
        format: "oaw-canvas",
        title,
        kind: sourceIndex.kind === "deck" ? "deck" : "board",
        rev: 1,
        pages: Array.isArray(sourceIndex.pages) && sourceIndex.pages.length
          ? validatePages(sourceIndex.pages)
          : [],
        boards: boardsMap,
        order,
        notes: {},
        designSystems: [],
        createdAt,
        updatedAt: createdAt,
      };
      atomicWriteJson(path.join(projectDir, CANVAS_FILE), canvasDoc);
      ensureVersionBase(dir, projectDir, { empty: true });
      recordCanvasVersion(dir, projectDir, {
        writes: { [CANVAS_FILE]: canvasDoc },
        actor,
        summary: `导入兼容画布「${title}」（${boards.length} 块板）`,
      });
      appendOperation(dir, {
        action: "import",
        actor,
        summary: `导入兼容画布「${title}」（${boards.length} 块板）`,
        detail: {
          source: relativeOf(root, source.canvasRoot),
          boards: order,
          files: measured.files,
          compatibleFiles: boards.filter((item) => item.kind === "html").map((item) => item.path),
        },
      });
      return {
        slug,
        path: `${DESIGNS_DIR}/${slug}/${PROJECT_DIR_NAME}/${CANVAS_FILE}`,
        dir: `${DESIGNS_DIR}/${slug}`,
        title,
        boards,
        boardCount: boards.length,
        compatible: boards.some((item) => item.kind === "html"),
      };
    } catch (error) {
      // 导入失败回滚半成品目录，避免留下不可用画布。
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  });
}

// ---------- 公开 API：导出计划 ----------

function captureSizeFor(width, height) {
  const w = Math.max(1, Number(width) || 1280);
  const h = Math.max(1, Number(height) || 720);
  const scale = Math.min(1, CANVAS_CAPTURE_LIMIT.width / w, CANVAS_CAPTURE_LIMIT.height / h);
  return {
    width: Math.max(320, Math.round(w * scale)),
    height: Math.max(240, Math.round(h * scale)),
    scaled: scale < 1,
  };
}

function asBoardList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/**
 * 展开导出计划（纯函数：只读文件，不写盘、不启动浏览器）。
 * @param {{format?: "svg"|"png"|"pdf"|"pptx", boards?: string[]|string}} [options]
 * @returns {{jobs: Array<object>, errors: string[], warnings: string[], format: string, boards: string[]}}
 *   jobs 是“实际执行单元”：svg/png 每板一个；pdf/pptx 整本一个。
 */
export function planExport(workspace, slug, options = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const format = String(options?.format || "").trim().toLowerCase();
  if (!CANVAS_EXPORT_FORMATS.includes(format)) {
    return {
      jobs: [],
      errors: [`未知导出格式：${format || "(空)"}（可用：${CANVAS_EXPORT_FORMATS.join("/")}）`],
      warnings: [],
      format,
      boards: [],
    };
  }
  const { canvas, boards } = readCanvas(root, cleanSlug);
  const errors = [];
  const warnings = [];

  const requested = asBoardList(options?.boards);
  let selected;
  if (requested.length) {
    const byPath = new Map(boards.map((item) => [item.path, item]));
    selected = [];
    for (const rawPath of requested) {
      let rel;
      try { rel = normalizeProjectRelativePath(rawPath); } catch {
        errors.push(`非法板路径：${rawPath}`);
        continue;
      }
      const entry = byPath.get(rel);
      if (!entry) {
        errors.push(`画布中不存在该板：${rel}`);
        continue;
      }
      if (!selected.includes(entry)) selected.push(entry);
    }
  } else {
    selected = [...boards];
  }
  if (!selected.length) errors.push("没有可导出的画板");
  if (selected.length > CANVAS_LIMITS.exportMaxBoards) {
    errors.push(`单次导出最多 ${CANVAS_LIMITS.exportMaxBoards} 块板（当前 ${selected.length}）`);
  }
  if (errors.length) return { jobs: [], errors, warnings, format, boards: selected.map((item) => item.path) };

  const title = canvas.title || cleanSlug;
  const jobs = [];

  if (format === "svg") {
    selected.forEach((entry, index) => {
      if (entry.kind === "html") {
        errors.push(`兼容板不支持 SVG 导出：${entry.path}（请改用 PNG/PDF/PPTX）`);
        return;
      }
      if (!entry.exists) {
        errors.push(`画板文件不存在：${entry.path}`);
        return;
      }
      jobs.push({
        id: `job-${index + 1}`,
        format: "svg",
        boardPath: entry.path,
        boardTitle: entry.title || path.basename(entry.path),
        kind: entry.kind,
        width: entry.w,
        height: entry.h,
      });
    });
  } else if (format === "png") {
    selected.forEach((entry, index) => {
      if (!entry.exists) {
        errors.push(`画板文件不存在：${entry.path}`);
        return;
      }
      const capture = captureSizeFor(entry.w, entry.h);
      if (capture.scaled) {
        warnings.push(`画板 ${entry.path} 尺寸 ${entry.w}×${entry.h} 超过浏览器上限，已等比缩放到 ${capture.width}×${capture.height}`);
      }
      jobs.push({
        id: `job-${index + 1}`,
        format: "png",
        boardPath: entry.path,
        boardTitle: entry.title || path.basename(entry.path),
        kind: entry.kind,
        width: entry.w,
        height: entry.h,
        captureWidth: capture.width,
        captureHeight: capture.height,
        scaled: capture.scaled,
        viewUrl: buildCanvasExportUrl({ workspace: root, slug: cleanSlug, boards: [entry.path], format: "png" }),
      });
    });
  } else if (format === "pdf") {
    const sizes = new Set(selected.map((entry) => `${entry.w}x${entry.h}`));
    if (sizes.size > 1) {
      errors.push(`PDF 导出要求所有板尺寸一致（当前 ${[...sizes].join(" / ")}）；请改用 PNG 逐板导出`);
      return { jobs: [], errors, warnings, format, boards: selected.map((item) => item.path) };
    }
    const missing = selected.filter((entry) => !entry.exists);
    if (missing.length) {
      errors.push(`画板文件不存在：${missing.map((item) => item.path).join(", ")}`);
      return { jobs: [], errors, warnings, format, boards: selected.map((item) => item.path) };
    }
    const capture = captureSizeFor(selected[0].w, selected[0].h);
    if (capture.scaled) warnings.push(`PDF 页尺寸超过浏览器上限，已等比缩放到 ${capture.width}×${capture.height}`);
    jobs.push({
      id: "job-1",
      format: "pdf",
      boards: selected.map((entry) => entry.path),
      width: selected[0].w,
      height: selected[0].h,
      captureWidth: capture.width,
      captureHeight: capture.height,
      scaled: capture.scaled,
      viewUrl: buildCanvasExportUrl({ workspace: root, slug: cleanSlug, boards: selected.map((entry) => entry.path), format: "pdf" }),
    });
  } else {
    const missing = selected.filter((entry) => !entry.exists);
    if (missing.length) {
      errors.push(`画板文件不存在：${missing.map((item) => item.path).join(", ")}`);
      return { jobs: [], errors, warnings, format, boards: selected.map((item) => item.path) };
    }
    jobs.push({
      id: "job-1",
      format: "pptx",
      boards: selected.map((entry) => entry.path),
      width: selected[0].w,
      height: selected[0].h,
      imagePages: selected.map((entry, index) => (entry.kind === "html" ? { index: index + 1, boardPath: entry.path, title: entry.title || "" } : null)).filter(Boolean),
    });
  }
  if (errors.length) return { jobs: [], errors, warnings, format, boards: selected.map((item) => item.path) };
  return { jobs, errors: [], warnings, format, boards: selected.map((item) => item.path), title };
}

// ---------- 公开 API：导出执行 ----------

function jobsFileOf(canvasDir) {
  return path.join(canvasDir, EXPORTS_DIR, JOBS_FILE);
}

function loadExportJobs(canvasDir) {
  const raw = readJsonFile(jobsFileOf(canvasDir), []);
  return Array.isArray(raw) ? raw.filter((item) => item && typeof item === "object") : [];
}

function saveExportJobs(canvasDir, jobs) {
  try {
    ensureDirectory(path.join(canvasDir, EXPORTS_DIR));
    atomicWriteJson(jobsFileOf(canvasDir), jobs.slice(0, 50));
  } catch {
    // 任务记录失败不影响导出产物本身。
  }
}

/**
 * 列出画布导出任务（最新在前）。
 *
 * - `listExportJobs(workspace, slug)`：单画布任务；
 * - `listExportJobs(workspace, slug, { jobId })`：单画布内按 jobId 过滤；
 * - `listExportJobs(workspace, null, { jobId })`：省略 slug 时跨工作区全部画布查（
 *   便于 `/api/canvas/exports/:jobId` 这类不带 slug 的路由）。
 */
export function listExportJobs(workspace, slug, options = {}) {
  const root = workspaceRoot(workspace);
  const jobId = String(options?.jobId || "").trim();
  const designs = designsRoot(root);
  let dirs = [];
  if (slug == null || String(slug).trim() === "") {
    if (fs.existsSync(designs)) {
      dirs = fs.readdirSync(designs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && SLUG_PATTERN.test(entry.name))
        .map((entry) => path.join(designs, entry.name));
    }
  } else {
    dirs = [readCanvasIndex(root, assertSlug(slug)).dir];
  }
  const jobs = [];
  for (const dir of dirs) jobs.push(...loadExportJobs(dir));
  jobs.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return jobId ? jobs.filter((job) => String(job.jobId || "") === jobId) : jobs;
}

function browserSessionKeyOf(browser, jobId) {
  if (browser && typeof browser.browserSessionKey === "function") return browser.browserSessionKey("canvas-export", jobId);
  return `canvas-export-${jobId}`;
}

/** 取得浏览器依赖：deps.browser 显式注入（含 null）优先，否则动态 import 内置浏览器。 */
async function resolveBrowser(deps, format) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, "browser")) {
    if (!deps.browser) {
      fail("CANVAS_BROWSER_UNAVAILABLE", `${format.toUpperCase()} 导出需要内置浏览器，但 deps.browser 为空`);
    }
    return deps.browser;
  }
  try {
    return await import("./内置浏览器.mjs");
  } catch (error) {
    fail("CANVAS_BROWSER_UNAVAILABLE", `内置浏览器不可用，无法导出 ${format.toUpperCase()}：${error?.message || error}`);
  }
  return null;
}

/** 打开导出视图并等待 `__OAW_EXPORT_READY` 握手。 */
async function prepareExportView(browser, key, url, width, height) {
  if (!browser || typeof browser.browserOpen !== "function") {
    fail("CANVAS_BROWSER_UNAVAILABLE", "内置浏览器不可用：缺少 browserOpen");
  }
  await browser.browserOpen(key, url);
  if (typeof browser.browserResize === "function") await browser.browserResize(key, width, height);
  if (typeof browser.browserWaitForExpression === "function") {
    await browser.browserWaitForExpression(key, "window.__OAW_EXPORT_READY === true", { timeoutMs: 45000 });
  }
  if (typeof browser.browserEvaluateValue === "function") {
    const pageError = await browser.browserEvaluateValue(key, "window.__OAW_EXPORT_ERROR || ''").catch(() => "");
    if (pageError) throw canvasError("CANVAS_EXPORT_FAILED", `导出视图异常：${pageError}`);
  }
}

async function capturePage(browser, key, { url, width, height, mode }) {
  await prepareExportView(browser, key, url, width, height);
  if (mode === "pdf") {
    if (typeof browser.browserPrintToPdf !== "function") fail("CANVAS_BROWSER_UNAVAILABLE", "内置浏览器不可用：缺少 browserPrintToPdf");
    const pdf = await browser.browserPrintToPdf(key);
    return Buffer.from(String(pdf?.base64 || ""), "base64");
  }
  if (typeof browser.browserScreenshot !== "function") fail("CANVAS_BROWSER_UNAVAILABLE", "内置浏览器不可用：缺少 browserScreenshot");
  const shot = await browser.browserScreenshot(key, { format: "png" });
  return Buffer.from(String(shot?.base64 || ""), "base64");
}

function writeExportFile(root, exportsDir, fileName, buffer, extra = {}) {
  const dir = path.resolve(exportsDir);
  const target = reserveExportFile(dir, fileName);
  if (!isInside(dir, target)) fail("CANVAS_PATH_DENIED", `导出产物路径越界：${target}`);
  atomicWriteFile(target, buffer);
  return { path: target, relative: relativeOf(root, target), bytes: Buffer.byteLength(buffer), ...extra };
}

/**
 * 执行导出任务（同一画布同时只允许 1 个任务）。
 *
 * @param {string} workspace 工作区绝对路径
 * @param {string} slug 画布 slug
 * @param {{format?: string, boards?: string[]|string, outputName?: string, actor?: string}} options
 * @param {{browser?: object|null, rasterizeSvg?: Function}} [deps]
 *   deps.browser 注入浏览器（缺省时动态 import 内置浏览器；显式 null 表示禁止）。
 * @returns {Promise<{files: Array<{path: string, relative: string, bytes: number}>, jobId: string, format: string, warnings: string[], imagePages: Array}>}
 *   files[].path 为绝对路径（与地图批量导出一致），relative 为工作区相对路径。
 */
export async function runExport(workspace, slug, options = {}, deps = {}) {
  const root = workspaceRoot(workspace);
  const cleanSlug = assertSlug(slug);
  const index = readCanvasIndex(root, cleanSlug);
  const actor = normalizeActor(options?.actor);
  const plan = planExport(root, cleanSlug, { format: options?.format, boards: options?.boards });
  if (plan.errors.length) {
    fail("CANVAS_INVALID", `导出计划无效：${plan.errors.join("；")}`, { errors: plan.errors });
  }
  if (activeExports.has(index.dir)) {
    fail("CANVAS_BUSY", "该画布已有导出任务在执行，请等待完成后再发起");
  }
  // 允许路由层传入自己的任务号（便于 HTTP 任务队列与事件/进度共用同一个 jobId）。
  const jobId = String(options?.jobId || "").trim() || `canvas-export-${Date.now()}-${++exportSeq}`;
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(jobId)) fail("CANVAS_INVALID", `jobId 非法：${jobId}`);
  activeExports.add(index.dir);
  const job = {
    jobId,
    slug: cleanSlug,
    format: plan.format,
    status: "running",
    total: plan.jobs.length,
    done: 0,
    failed: 0,
    files: [],
    errors: [],
    warnings: [...plan.warnings],
    outputName: String(options?.outputName || ""),
    createdAt: nowIso(),
    finishedAt: "",
  };
  const history = loadExportJobs(index.dir);
  saveExportJobs(index.dir, [job, ...history]);

  const at = new Date();
  const canvasTitle = (() => {
    try { return readCanvas(root, cleanSlug).canvas.title; } catch { return cleanSlug; }
  })();

  try {
    const result = await withCanvasLockAsync(root, index.dir, cleanSlug, async () => {
      const exportsDir = ensureDirectory(path.join(index.dir, EXPORTS_DIR));
      const { projectDir } = index;
      const files = [];
      const warnings = [...plan.warnings];
      const imagePages = [];
      // 浏览器按需解析：SVG 导出完全不需要浏览器；PPTX 仅在含兼容板（整页图片）时才需要。
      let browser = null;
      let key = "";
      const ensureBrowser = async () => {
        if (!browser) {
          browser = await resolveBrowser(deps, plan.format);
          key = browserSessionKeyOf(browser, jobId);
        }
        return browser;
      };

      const boardEntries = new Map(orderedBoardEntries(index.raw, projectDir).map((item) => [item.path, item]));

      for (const item of plan.jobs) {
        if (plan.format === "svg") {
          const entry = boardEntries.get(item.boardPath);
          if (!entry) fail("CANVAS_NOT_FOUND", `画板不存在：${item.boardPath}`);
          const target = path.join(projectDir, item.boardPath);
          if (entry.kind === "svg") {
            files.push(writeExportFile(root, exportsDir, buildExportFileName({
              title: canvasTitle, boardTitle: item.boardTitle, format: "svg", outputName: options?.outputName, at,
            }), fs.readFileSync(target)));
          } else {
            const { board } = readBoard(root, cleanSlug, item.boardPath);
            const serialized = serializeBoardToSvg({
              board, projectDir, baseDir: path.dirname(target), title: `${canvasTitle} · ${item.boardTitle}`,
            });
            warnings.push(...serialized.warnings);
            files.push(writeExportFile(root, exportsDir, buildExportFileName({
              title: canvasTitle, boardTitle: item.boardTitle, format: "svg", outputName: options?.outputName, at,
            }), Buffer.from(serialized.svg, "utf8")));
          }
        } else if (plan.format === "png") {
          const page = await ensureBrowser();
          const buffer = await capturePage(page, key, {
            url: item.viewUrl, width: item.captureWidth, height: item.captureHeight, mode: "png",
          });
          if (!buffer.length) fail("CANVAS_EXPORT_FAILED", `截图失败（无图像数据）：${item.boardPath}`);
          files.push(writeExportFile(root, exportsDir, buildExportFileName({
            title: canvasTitle, boardTitle: item.boardTitle, format: "png", outputName: options?.outputName, at,
          }), buffer));
        } else if (plan.format === "pdf") {
          const page = await ensureBrowser();
          const buffer = await capturePage(page, key, {
            url: item.viewUrl, width: item.captureWidth, height: item.captureHeight, mode: "pdf",
          });
          if (!buffer.length) fail("CANVAS_EXPORT_FAILED", "PDF 导出失败（无文件数据）");
          // 多板分页依赖导出视图按 `boards=` 逐板渲染并注入 @page；视图只渲染了一部分时
          // 宁可失败也不要悄悄产出“只有第一页”的 PDF。
          if (Array.isArray(item.boards) && item.boards.length > 1 && typeof page.browserEvaluateValue === "function") {
            const rendered = await page.browserEvaluateValue(key, "document.querySelectorAll('[data-board]').length").catch(() => null);
            const count = Number(rendered);
            if (Number.isFinite(count) && count > 0 && count < item.boards.length) {
              fail("CANVAS_EXPORT_FAILED", `导出视图只渲染了 ${count}/${item.boards.length} 块板：PDF 多板分页需要导出视图支持 boards 参数（或改用 PNG 逐板导出）`);
            }
          }
          files.push(writeExportFile(root, exportsDir, buildExportFileName({
            title: canvasTitle, boardTitle: "", format: "pdf", outputName: options?.outputName, at,
          }), buffer));
        } else {
          // PPTX：对象板映射为可编辑对象；兼容板先截图成整页图片。
          const slides = [];
          for (const boardPath of item.boards) {
            const entry = boardEntries.get(boardPath);
            if (!entry) fail("CANVAS_NOT_FOUND", `画板不存在：${boardPath}`);
            const boardAbs = path.join(projectDir, boardPath);
            if (entry.kind === "html") {
              const capture = captureSizeFor(entry.w, entry.h);
              const page = await ensureBrowser();
              const url = buildCanvasExportUrl({ workspace: root, slug: cleanSlug, boards: [boardPath], format: "png" });
              const buffer = await capturePage(page, key, { url, width: capture.width, height: capture.height, mode: "png" });
              if (!buffer.length) fail("CANVAS_EXPORT_FAILED", `兼容板截图失败：${boardPath}`);
              slides.push({
                kind: "html",
                imageBase64: buffer.toString("base64"),
                width: entry.w,
                height: entry.h,
                title: entry.title || path.basename(boardPath),
                boardPath,
              });
            } else if (entry.kind === "svg") {
              slides.push({
                kind: "object",
                boardPath,
                assetBase: path.dirname(boardAbs),
                board: {
                  w: entry.w,
                  h: entry.h,
                  background: "#ffffff",
                  elements: [{ id: "el-board-svg", type: "svg", x: 0, y: 0, w: entry.w, h: entry.h, src: boardPath }],
                },
              });
            } else {
              const { board } = readBoard(root, cleanSlug, boardPath);
              slides.push({ kind: "object", board, boardPath, assetBase: path.dirname(boardAbs) });
            }
          }
          // SVG 块栅格化优先级：deps.rasterizeSvg（函数=注入实现）。
          // 默认不栅格化、直接内嵌矢量 SVG —— 栅格化需要导出视图支持
          // `render=svg&element=<id>`（单元素渲染），接口就绪后由调用方注入 deps.rasterizeSvg；
          // 否则按整板截图会被裁成左上角，反而更失真。
          const rasterizeSvg = Object.prototype.hasOwnProperty.call(deps, "rasterizeSvg")
            && typeof deps.rasterizeSvg === "function"
            ? deps.rasterizeSvg
            : null;
          const built = await buildCanvasPptx({
            title: canvasTitle,
            slides,
            projectDir,
            rasterizeSvg,
          });
          warnings.push(...built.warnings);
          imagePages.push(...built.imagePages);
          files.push(writeExportFile(root, exportsDir, buildExportFileName({
            title: canvasTitle, boardTitle: "", format: "pptx", outputName: options?.outputName, at,
          }), built.buffer, { slides: built.slideCount }));
        }
        job.done += 1;
        job.files = [...files];
        saveExportJobs(index.dir, [job, ...loadExportJobs(index.dir).filter((item) => item.jobId !== jobId)]);
      }

      job.status = "completed";
      job.done = plan.jobs.length;
      job.files = files;
      job.warnings = warnings;
      job.finishedAt = nowIso();
      saveExportJobs(index.dir, [job, ...loadExportJobs(index.dir).filter((item) => item.jobId !== jobId)]);
      appendOperation(index.dir, {
        action: "export",
        actor,
        rev: Number(index.raw.rev) || 0,
        summary: `导出 ${plan.format.toUpperCase()}（${files.length} 个文件）`,
        detail: { format: plan.format, jobId, boards: plan.boards, files: files.map((file) => file.relative), imagePages },
      });
      return { files, jobId, format: plan.format, warnings, imagePages };
    });
    return result;
  } catch (error) {
    job.status = "failed";
    job.failed = 1;
    job.errors = [String(error?.message || error)];
    job.finishedAt = nowIso();
    saveExportJobs(index.dir, [job, ...loadExportJobs(index.dir).filter((item) => item.jobId !== jobId)]);
    try {
      appendOperation(index.dir, {
        action: "export",
        actor,
        summary: `导出 ${plan.format.toUpperCase()} 失败`,
        detail: { format: plan.format, jobId, error: String(error?.message || error).slice(0, 500) },
      });
    } catch { /* 日志失败不影响错误返回 */ }
    if (error?.code && String(error.code).startsWith("CANVAS_")) throw error;
    throw canvasError("CANVAS_EXPORT_FAILED", `导出失败：${String(error?.message || error)}`, { jobId, format: plan.format });
  } finally {
    activeExports.delete(index.dir);
  }
}
