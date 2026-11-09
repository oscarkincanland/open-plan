/**
 * 创作画布导出：SVG 序列化 + 导出视图 URL 构造 + PPTX 生成。
 *
 * 设计口径（计划 docs/plans/2026-11-09-003 §5.5）：
 *   - SVG：服务端按板 JSON 序列化（text→<text>、rect→<rect>、line→<line>、
 *     image→内嵌 base64、svg 块→内嵌并 sanitize）。仅对象板 / SVG 板适用；
 *   - PNG / PDF：由内置浏览器打开导出视图（`/?export=canvas&...`，握手
 *     `window.__OAW_EXPORT_READY`）截图与分页打印，URL 构造集中在本模块；
 *   - PPTX：pptxgenjs 逐对象映射（text→addText 可编辑、rect/line→addShape、
 *     image→addImage、svg 块→图片、兼容板→整页图片）；1280×720 px → 13.333×7.5 in，
 *     字号 pt = px × 0.75。
 *
 * 本模块不写盘、不启动浏览器，纯粹做内容变换；写盘与浏览器编排在
 * `server/创作画布.mjs`。这样导出映射可以脱离浏览器在 CI 里被断言。
 */
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./workspace.mjs";

/** 导出格式白名单（顺序即界面展示顺序）。 */
export const CANVAS_EXPORT_FORMATS = Object.freeze(["svg", "png", "pdf", "pptx"]);

/** 内置浏览器截图上限（与 内置浏览器.mjs 的 MAX_CAPTURE 同源）。 */
export const CANVAS_CAPTURE_LIMIT = Object.freeze({ width: 2400, height: 1600 });

/** 文本字体白名单：只用系统字体，避免导出时联网拉字体（§5.7 不联网）。 */
export const CANVAS_FONT_WHITELIST = Object.freeze(["Microsoft YaHei", "PingFang SC", "Arial", "sans-serif"]);
export const CANVAS_FONT_STACK = "Microsoft YaHei, PingFang SC, Arial, sans-serif";

/** CSS px → inch（96 px/in）与 px → pt（0.75）。 */
export const PX_PER_INCH = 96;
export const PT_PER_PX = 0.75;

const MIME_BY_EXT = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
});

const URL_SAFE_EXT = /^\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

// ---------- 通用小工具 ----------

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/** XML 文本转义（元素内容）。 */
export function escapeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** XML 属性转义。 */
export function escapeXmlAttr(value) {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * 归一化 CSS 颜色：只接受 #hex / rgb()/hsl() / 关键字 / transparent|none，
 * 其它一律回退到 fallback（防止把任意字符串塞进 SVG/PPTX）。
 */
export function normalizeColor(value, fallback = "") {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 64) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return raw.toLowerCase();
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]{1,60}\)$/i.test(raw)) return raw.toLowerCase();
  if (/^[a-zA-Z]{3,20}$/.test(raw) && !/^(?:javascript|expression)$/i.test(raw)) return raw.toLowerCase();
  return fallback;
}

/** PPTX 只认 6 位 hex（不带 #）；其它颜色回退。 */
export function toPptxColor(value, fallback = "000000") {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = /^#([0-9a-f]{3,8})$/.exec(raw) || /^([0-9a-f]{3,8})$/.exec(raw);
  if (!match) return fallback;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 4) hex = hex.slice(0, 3).split("").map((c) => c + c).join("");
  if (hex.length === 8) hex = hex.slice(0, 6);
  return hex.length === 6 ? hex : fallback;
}

/** 字体族归一化到白名单（非白名单回退 Microsoft YaHei）。 */
export function normalizeFontFamily(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "Microsoft YaHei";
  const direct = CANVAS_FONT_WHITELIST.find((font) => font.toLowerCase() === raw.toLowerCase());
  if (direct) return direct;
  // 允许 "PingFang SC" 这类多词字体名做包含匹配，仍限定在白名单内。
  const contained = CANVAS_FONT_WHITELIST.find((font) => raw.toLowerCase().includes(font.toLowerCase()));
  return contained || "Microsoft YaHei";
}

/**
 * 最小 SVG sanitize（§5.7）：去 script/iframe/foreignObject/事件属性/
 * javascript: 协议/外链 href/外链 url()/@import/expression()。
 * 这不是完整 HTML 清洗器，但覆盖导出与内嵌所需的攻击面，且结果确定可测。
 */
export function sanitizeSvgMarkup(markup) {
  let out = String(markup ?? "");
  if (!out) return "";
  out = out.replace(/<\?xml[\s\S]*?\?>/gi, "");
  out = out.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  // 成对危险标签整体移除（含内容）
  out = out.replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video|form|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  // 自闭合 / 未闭合危险标签
  out = out.replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video|form|link|meta|base|style)\b[^>]*\/?>/gi, "");
  // 事件属性（on*）与 javascript: 协议
  out = out.replace(/\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, "");
  out = out.replace(/\b(?:href|xlink:href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, "");
  out = out.replace(/javascript:/gi, "");
  // 外链引用（http/https/协议相对）一律清空
  out = out.replace(/\b(?:href|xlink:href|src)\s*=\s*("\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*')/gi, 'href="#"');
  out = out.replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, "none");
  out = out.replace(/@import[^;]*;/gi, "");
  out = out.replace(/expression\s*\(/gi, "");
  return out.trim();
}

/**
 * 解析 project 内素材为 base64（图片/SVG 内嵌用）。
 *
 * `src` 相对**板文件所在目录**解析（计划 §3.3 的 `../assets/map.png` 就是相对板文件），
 * 但解析后的绝对路径必须仍在 project 内：绝对路径、盘符、URL 一律拒绝，
 * `..` 只在最终没有逃出 project 时被接受。
 *
 * @param {string} projectDir project 绝对路径
 * @param {string} src 板内 src（相对板文件）
 * @param {{baseDir?: string}} [options] baseDir = 板文件所在目录
 */
export function resolveProjectAsset(projectDir, src, { baseDir = "" } = {}) {
  const base = path.resolve(String(projectDir || ""));
  const from = path.resolve(String(baseDir || base));
  const raw = String(src ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return null;
  if (raw.startsWith("/") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return null;
  const segments = raw.split("/").filter((item) => item && item !== ".");
  if (!segments.length) return null;
  const target = path.resolve(from, segments.join("/"));
  if (!isInside(base, target) || !fs.existsSync(target)) return null;
  let real;
  try { real = fs.realpathSync(target); } catch { return null; }
  if (!isInside(base, real)) return null;
  let stat;
  try { stat = fs.statSync(real); } catch { return null; }
  if (!stat.isFile()) return null;
  const ext = path.extname(real).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime || !URL_SAFE_EXT.test(ext)) return null;
  let buffer;
  try { buffer = fs.readFileSync(real); } catch { return null; }
  return {
    file: real,
    ext,
    mime,
    bytes: buffer.length,
    base64: buffer.toString("base64"),
    text: mime === "image/svg+xml" ? buffer.toString("utf8") : null,
    relative: path.relative(base, real).replace(/\\/g, "/"),
  };
}

/** 从 `<svg ...>` 根标签解析 width/height/viewBox 并取出内部内容。 */
function unwrapSvgRoot(markup) {
  const source = String(markup ?? "");
  const open = /<svg\b([^>]*)>/i.exec(source);
  if (!open) return { inner: source, width: 0, height: 0, viewBox: "" };
  const attrs = open[1] || "";
  const readAttr = (name) => {
    const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
    return match ? String(match[2] ?? match[3] ?? "") : "";
  };
  const width = Number.parseFloat(readAttr("width")) || 0;
  const height = Number.parseFloat(readAttr("height")) || 0;
  const viewBox = readAttr("viewBox") || readAttr("viewbox");
  const start = open.index + open[0].length;
  const end = source.toLowerCase().lastIndexOf("</svg>");
  const inner = end > start ? source.slice(start, end) : "";
  const selfClosing = /\/>\s*$/i.test(open[0]);
  return { inner: selfClosing ? "" : inner, width, height, viewBox };
}

function svgViewBoxOf(asset, fallbackW, fallbackH) {
  const unwrapped = unwrapSvgRoot(asset?.text || "");
  const viewBox = unwrapped.viewBox && /^[-\d.\s,]+$/.test(unwrapped.viewBox.trim()) ? unwrapped.viewBox.trim() : "";
  const width = unwrapped.width || fallbackW;
  const height = unwrapped.height || fallbackH;
  return { inner: unwrapped.inner, viewBox: viewBox || `0 0 ${round(width)} ${round(height)}`, width, height };
}

// ---------- SVG 序列化 ----------

function svgTextElement(element, warnings) {
  const style = element.style || {};
  const fontSize = Number(style.fontSize) || 24;
  const lineHeight = Number(style.lineHeight) || 1.2;
  // 字体只用白名单栈：先声明具体字体，再兜底通用族，避免导出时联网取字体。
  const family = CANVAS_FONT_STACK;
  const fill = normalizeColor(style.color, "#141413");
  const align = style.textAlign === "center" ? "center" : style.textAlign === "right" ? "right" : "left";
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const x = align === "center" ? Number(element.x) + Number(element.w) / 2
    : align === "right" ? Number(element.x) + Number(element.w)
      : Number(element.x);
  const weight = Number(style.fontWeight) || 400;
  const raw = String(element.text ?? "");
  if (!raw.trim()) warnings.push(`文本元素 ${element.id} 内容为空`);
  const lines = raw.split(/\r?\n/);
  const firstBaseline = Number(element.y) + fontSize * lineHeight * 0.85;
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(firstBaseline)}"`,
    `font-family="${escapeXmlAttr(family)}"`,
    `font-size="${round(fontSize)}"`,
    `font-weight="${round(weight, 0)}"`,
    `fill="${escapeXmlAttr(fill)}"`,
    `text-anchor="${anchor}"`,
    'xml:space="preserve"',
  ];
  if (style.opacity !== undefined) attrs.push(`opacity="${round(style.opacity)}"`);
  const tspans = lines.map((line, index) => {
    const y = round(firstBaseline + index * fontSize * lineHeight);
    return `<tspan x="${round(x)}" y="${y}">${escapeXmlText(line)}</tspan>`;
  }).join("");
  return `<text ${attrs.join(" ")}>${tspans}</text>`;
}

function svgRectElement(element, warnings) {
  const style = element.style || {};
  void warnings;
  const fill = normalizeColor(style.fill, "none");
  const stroke = normalizeColor(style.stroke, "none");
  const strokeWidth = Number(style.strokeWidth ?? (stroke !== "none" ? 1 : 0)) || 0;
  const radius = Number(style.radius) || 0;
  const attrs = [
    `x="${round(element.x)}"`, `y="${round(element.y)}"`,
    `width="${round(element.w)}"`, `height="${round(element.h)}"`,
    `fill="${escapeXmlAttr(fill)}"`,
  ];
  if (stroke !== "none" && strokeWidth > 0) {
    attrs.push(`stroke="${escapeXmlAttr(stroke)}"`, `stroke-width="${round(strokeWidth)}"`);
  }
  if (radius > 0) attrs.push(`rx="${round(radius)}"`, `ry="${round(radius)}"`);
  if (style.opacity !== undefined) attrs.push(`opacity="${round(style.opacity)}"`);
  return `<rect ${attrs.join(" ")}/>`;
}

function svgLineElement(element, warnings) {
  const style = element.style || {};
  void warnings;
  const stroke = normalizeColor(style.stroke, "#141413");
  const strokeWidth = Number(style.strokeWidth) || 2;
  const attrs = [
    `x1="${round(element.x1)}"`, `y1="${round(element.y1)}"`,
    `x2="${round(element.x2)}"`, `y2="${round(element.y2)}"`,
    `stroke="${escapeXmlAttr(stroke)}"`, `stroke-width="${round(strokeWidth)}"`,
    'stroke-linecap="round"',
  ];
  if (style.opacity !== undefined) attrs.push(`opacity="${round(style.opacity)}"`);
  return `<line ${attrs.join(" ")}/>`;
}

function svgImageElement(element, projectDir, baseDir, warnings) {
  const asset = resolveProjectAsset(projectDir, element.src, { baseDir });
  if (!asset) {
    warnings.push(`图片素材缺失或不在 project 内：${element.src || "(空 src)"}`);
    return "";
  }
  const fit = element.fit === "cover" ? "xMidYMid slice" : element.fit === "fill" ? "none" : "xMidYMid meet";
  return `<image x="${round(element.x)}" y="${round(element.y)}" width="${round(element.w)}" height="${round(element.h)}"`
    + ` preserveAspectRatio="${fit}" xlink:href="data:${asset.mime};base64,${asset.base64}"/>`;
}

function svgBlockElement(element, projectDir, baseDir, warnings) {
  const fit = element.fit === "cover" ? "xMidYMid slice" : element.fit === "fill" ? "none" : "xMidYMid meet";
  const wrap = (inner, viewBox) => `<svg x="${round(element.x)}" y="${round(element.y)}"`
    + ` width="${round(element.w)}" height="${round(element.h)}" viewBox="${escapeXmlAttr(viewBox)}"`
    + ` preserveAspectRatio="${fit}">${inner}</svg>`;
  if (element.src) {
    const asset = resolveProjectAsset(projectDir, element.src, { baseDir });
    if (!asset || asset.mime !== "image/svg+xml") {
      warnings.push(`SVG 块素材缺失或不是 SVG：${element.src || "(空 src)"}`);
      return "";
    }
    const view = svgViewBoxOf(asset, element.w, element.h);
    return wrap(sanitizeSvgMarkup(view.inner), view.viewBox);
  }
  const markup = sanitizeSvgMarkup(element.markup || "");
  if (!markup) {
    warnings.push(`SVG 块 ${element.id} 没有可用的 src/markup`);
    return "";
  }
  const view = svgViewBoxOf({ text: markup }, element.w, element.h);
  return wrap(view.inner, view.viewBox);
}

/**
 * 对象板 → 独立 SVG 文档。
 * @param {{board: object, projectDir: string, baseDir?: string, title?: string}} options
 *   baseDir = 板文件所在目录（src 相对它解析；解析结果仍须在 projectDir 内）
 * @returns {{svg: string, width: number, height: number, warnings: string[]}}
 */
export function serializeBoardToSvg({ board, projectDir, baseDir = "", title = "" } = {}) {
  const warnings = [];
  const width = Number(board?.w) || 1280;
  const height = Number(board?.h) || 720;
  const assetBase = baseDir || projectDir;
  const background = normalizeColor(board?.background, "#ffffff");
  const parts = [`<rect x="0" y="0" width="${round(width)}" height="${round(height)}" fill="${escapeXmlAttr(background)}"/>`];
  const elements = Array.isArray(board?.elements) ? board.elements : [];
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    if (element.type === "text") parts.push(svgTextElement(element, warnings));
    else if (element.type === "rect") parts.push(svgRectElement(element, warnings));
    else if (element.type === "line") parts.push(svgLineElement(element, warnings));
    else if (element.type === "image") parts.push(svgImageElement(element, projectDir, assetBase, warnings));
    else if (element.type === "svg") parts.push(svgBlockElement(element, projectDir, assetBase, warnings));
  }
  const label = escapeXmlAttr(String(title || board?.title || ""));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
    + ` width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}"`
    + ` role="img"${label ? ` aria-label="${label}"` : ""}>`
    + `${parts.filter(Boolean).join("")}</svg>`;
  return { svg, width, height, warnings };
}

// ---------- 导出视图 URL ----------

/**
 * 构造导出视图 URL —— 唯一构造点（客户端 `?export=canvas` 视图按此契约实现）。
 *
 * 参数契约：
 *   export=canvas            导出视图模式
 *   workspace=<绝对路径>      画布所在工作区（客户端 decode 后原样回传服务端）
 *   slug=<画布 slug>
 *   board=<project 内相对路径> 单板模式
 *   boards=a,b               多板模式（PDF 分页、PPTX 整本；单板时不使用）
 *   format=png|pdf           目标格式（视图据此决定 @page 尺寸/透明背景）
 *   render=svg&element=<id>  PPTX 的 SVG 块栅格化（可选，见 §5.5）
 *
 * 就绪握手：视图渲染完成后设置 `window.__OAW_EXPORT_READY = true`，
 * 失败时设置 `window.__OAW_EXPORT_ERROR = "<原因>"`。
 */
export function buildCanvasExportUrl({ workspace, slug, boards, format = "png", render = "", element = "", baseUrl = "" } = {}) {
  const list = (Array.isArray(boards) ? boards : boards ? [boards] : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const origin = String(baseUrl || process.env.OAW_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3002}`).replace(/\/+$/, "");
  const qs = new URLSearchParams({
    export: "canvas",
    workspace: String(workspace || ""),
    slug: String(slug || ""),
  });
  if (list.length === 1) qs.set("board", list[0]);
  else if (list.length > 1) qs.set("boards", list.join(","));
  if (format) qs.set("format", String(format));
  if (render) qs.set("render", String(render));
  if (element) qs.set("element", String(element));
  return `${origin}/?${qs.toString()}`;
}

/** 为 SVG 块栅格化构造单元素渲染视图（PPTX 优先用；浏览器不可用时降级内嵌 SVG）。 */
export function buildCanvasElementRenderUrl(options = {}) {
  return buildCanvasExportUrl({ ...options, render: "svg" });
}

// ---------- 导出文件名 ----------

/** 文件名清洗：禁 `\/:*?"<>|`，压缩空白，限长。 */
export function sanitizeExportFileName(value, fallback = "canvas-export") {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function stampOf(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 导出文件名：`<画布标题>-<板标题>-<时间戳>.<ext>`（§3.5）。
 * 未给板标题时省略该段；outputName 若显式给出则以其为基名（仍做清洗）。
 */
export function buildExportFileName({ title = "", boardTitle = "", format = "png", outputName = "", at = new Date() } = {}) {
  const ext = String(format || "png").replace(/^\./, "").toLowerCase();
  const base = outputName
    ? String(outputName).replace(new RegExp(`\\.${ext}$`, "i"), "")
    : [title, boardTitle].map((part) => String(part || "").trim()).filter(Boolean).join("-");
  return `${sanitizeExportFileName(base, "canvas-export")}-${stampOf(at)}.${ext}`;
}

/** 若目标已存在则追加 -2/-3…，返回不冲突的绝对路径（调用方仍需原子写）。 */
export function reserveExportFile(exportsDir, fileName) {
  const dir = path.resolve(String(exportsDir || ""));
  const parsed = path.parse(sanitizeExportFileName(fileName, "canvas-export.png"));
  const ext = parsed.ext && parsed.ext.length > 1 ? parsed.ext : ".bin";
  let candidate = path.join(dir, `${parsed.name}${ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${index}${ext}`);
    index += 1;
    if (index > 999) break;
  }
  return candidate;
}

// ---------- PPTX 生成 ----------

function pxToIn(px) {
  return (Number(px) || 0) / PX_PER_INCH;
}

/**
 * 生成 PPTX buffer。
 *
 * @param {object} options
 * @param {string} options.title 演示文稿标题
 * @param {Array<object>} options.slides
 *   对象板：`{ kind: "object", board, boardPath }`
 *   兼容板：`{ kind: "html", imageBase64, width, height, title, boardPath }`
 *   `kind` 缺省时：含 imageBase64 视为 html，否则 object。
 * @param {string} options.projectDir 板所在 project 目录（解析 image/svg src）
 * @param {(ctx: {boardPath: string, element: object}) => Promise<string>} [options.rasterizeSvg]
 *   SVG 块栅格化回调（返回 PNG base64）；缺省时内嵌 SVG（PowerPoint 2016+ 可显示）。
 * @returns {Promise<{buffer: Buffer, slideCount: number, imagePages: Array, warnings: string[]}>}
 */
export async function buildCanvasPptx({ title = "", slides = [], projectDir = "", rasterizeSvg = null } = {}) {
  const warnings = [];
  const list = Array.isArray(slides) ? slides : [];
  if (!list.length) throw Object.assign(new Error("PPTX 导出至少需要一块画板"), { code: "CANVAS_INVALID" });

  const mod = await import("pptxgenjs");
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.author = "Open Plan";
  pptx.company = "Open Plan";
  pptx.title = String(title || "创作画布");

  // 演示尺寸取第一块板的物理尺寸；其余板按等比缩放 + 居中铺进同一页面。
  const first = list[0];
  const presW = Math.max(1, pxToIn(first.width || first.board?.w || 1280));
  const presH = Math.max(1, pxToIn(first.height || first.board?.h || 720));
  const layoutName = `CANVAS_${Math.round(presW * 100)}x${Math.round(presH * 100)}`;
  pptx.defineLayout({ name: layoutName, width: presW, height: presH });
  pptx.layout = layoutName;

  const imagePages = [];
  let slideIndex = 0;

  for (const item of list) {
    slideIndex += 1;
    const slide = pptx.addSlide();
    const isHtml = item.kind === "html" || (item.kind !== "object" && Boolean(item.imageBase64));
    if (isHtml) {
      const base64 = String(item.imageBase64 || "");
      if (!base64) throw Object.assign(new Error(`兼容板缺少整页图片：${item.boardPath || item.title || ""}`), { code: "CANVAS_INVALID" });
      slide.addImage({
        data: `image/png;base64,${base64}`,
        x: 0, y: 0, w: presW, h: presH,
        sizing: { type: "contain", w: presW, h: presH },
      });
      imagePages.push({ index: slideIndex, boardPath: item.boardPath || "", title: item.title || "", reason: "compat-board" });
      continue;
    }
    const board = item.board || {};
    const boardW = Number(board.w) || Number(item.width) || 1280;
    const boardH = Number(board.h) || Number(item.height) || 720;
    // src 相对板文件目录解析（§3.3 的 ../assets/... 写法），仍必须在 project 内。
    const assetBase = item.assetBase ? path.resolve(item.assetBase) : path.resolve(projectDir || ".");
    const scale = Math.min(presW / pxToIn(boardW), presH / pxToIn(boardH));
    const offsetX = (presW - pxToIn(boardW) * scale) / 2;
    const offsetY = (presH - pxToIn(boardH) * scale) / 2;
    const tx = (px) => offsetX + pxToIn(px) * scale;
    const ty = (px) => offsetY + pxToIn(px) * scale;
    const len = (px) => pxToIn(px) * scale;
    const fontPt = (px) => Math.max(1, Math.round((Number(px) || 0) * PT_PER_PX * scale * 10) / 10);

    const background = toPptxColor(board.background, "FFFFFF");
    if (background) slide.background = { color: background };

    const elements = Array.isArray(board.elements) ? board.elements : [];
    for (const element of elements) {
      if (!element || typeof element !== "object") continue;
      const style = element.style || {};
      try {
        if (element.type === "text") {
          const text = String(element.text ?? "");
          if (!text.trim()) continue;
          slide.addText(text, {
            x: tx(element.x), y: ty(element.y), w: len(element.w), h: len(element.h),
            fontSize: fontPt(style.fontSize ?? 24),
            bold: (Number(style.fontWeight) || 400) >= 600,
            color: toPptxColor(style.color, "141413"),
            fontFace: normalizeFontFamily(style.fontFamily),
            align: style.textAlign === "center" ? "center" : style.textAlign === "right" ? "right" : "left",
            valign: style.valign === "middle" ? "middle" : style.valign === "bottom" ? "bottom" : "top",
            margin: 0,
            lineSpacingMultiple: Math.max(0.5, Number(style.lineHeight) || 1.2),
            wrap: true,
          });
          continue;
        }
        if (element.type === "rect") {
          const radius = Number(style.radius) || 0;
          const hasFill = Boolean(normalizeColor(style.fill, ""));
          const stroke = normalizeColor(style.stroke, "");
          slide.addShape(radius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
            x: tx(element.x), y: ty(element.y), w: len(element.w), h: len(element.h),
            fill: hasFill
              ? { color: toPptxColor(style.fill, "FFFFFF") }
              : { color: toPptxColor(style.stroke, "FFFFFF"), transparency: 100 },
            line: stroke
              ? { color: toPptxColor(stroke, "000000"), width: Math.max(0.25, Number(style.strokeWidth) || 1) }
              : { color: "FFFFFF", transparency: 100, width: 0 },
            ...(radius > 0 ? { rectRadius: Math.max(0.01, len(radius)) } : {}),
          });
          continue;
        }
        if (element.type === "line") {
          const x1 = Number(element.x1) || 0;
          const y1 = Number(element.y1) || 0;
          const x2 = Number(element.x2) || 0;
          const y2 = Number(element.y2) || 0;
          slide.addShape(pptx.ShapeType.line, {
            x: tx(Math.min(x1, x2)), y: ty(Math.min(y1, y2)),
            w: Math.max(len(Math.abs(x2 - x1)), 0.01),
            h: Math.max(len(Math.abs(y2 - y1)), 0.01),
            line: { color: toPptxColor(style.stroke, "141413"), width: Math.max(0.25, Number(style.strokeWidth) || 2) },
            flipH: x2 < x1,
            flipV: y2 < y1,
          });
          continue;
        }
        if (element.type === "image" || element.type === "svg") {
          const box = { x: tx(element.x), y: ty(element.y), w: len(element.w), h: len(element.h) };
          if (element.type === "image") {
            const asset = resolveProjectAsset(projectDir, element.src, { baseDir: assetBase });
            if (!asset) {
              warnings.push(`图片素材缺失：${element.src || "(空 src)"}`);
              continue;
            }
            slide.addImage({
              path: asset.file,
              ...box,
              ...(element.fit === "cover" ? { sizing: { type: "cover", w: box.w, h: box.h } }
                : element.fit === "contain" ? { sizing: { type: "contain", w: box.w, h: box.h } } : {}),
            });
            continue;
          }
          // SVG 块：优先栅格化为 PNG（§5.5），缺省时内嵌 SVG。
          let pngBase64 = "";
          if (typeof rasterizeSvg === "function") {
            try {
              pngBase64 = String(await rasterizeSvg({ boardPath: item.boardPath || "", element }) || "");
            } catch (error) {
              warnings.push(`SVG 块 ${element.id} 栅格化失败，已内嵌 SVG：${error?.message || error}`);
            }
          }
          if (pngBase64) {
            slide.addImage({ data: `image/png;base64,${pngBase64}`, ...box });
            continue;
          }
          let svgText = "";
          let source = "";
          if (element.src) {
            const asset = resolveProjectAsset(projectDir, element.src, { baseDir: assetBase });
            if (asset?.text) { svgText = sanitizeSvgMarkup(asset.text); source = asset.relative; }
          } else if (element.markup) {
            svgText = sanitizeSvgMarkup(element.markup);
            source = "(inline)";
          }
          if (!svgText) {
            warnings.push(`SVG 块 ${element.id} 没有可用的 src/markup`);
            continue;
          }
          slide.addImage({
            data: `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`,
            ...box,
          });
          warnings.push(`SVG 块 ${element.id} 以矢量内嵌（${source}），未栅格化为 PNG`);
          continue;
        }
      } catch (error) {
        warnings.push(`元素 ${element.id || "(无 id)"} 映射失败：${error?.message || error}`);
      }
    }
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return {
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    slideCount: slideIndex,
    imagePages,
    warnings,
  };
}
