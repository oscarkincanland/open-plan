/**
 * 原生文档引擎（P1-A / P1-B / P2-C，方案 §5.4/§5.5）
 *
 * 用 Node 侧 OOXML 能力直接处理 .docx / .xlsx / .pptx，把最高频的
 * 「新建文档 / 读取文本大纲统计 / 全文查找替换」从外部 officecli 二进制分流出来
 * （消除进程冷启动与并发 1 瓶颈）；图表、透视表、修订跟踪、Morph 等长尾仍由 CLI 兜底。
 *
 * 对外契约（对模型透明）：
 *   - 工具名仍是 officecli，参数形状不变；本模块只做"这条命令能否原生执行"的判定与执行。
 *   - 结果与 runOfficecli 同形：{ code, stdout, stderr, text, json, command, engine:"native" }。
 *   - 未命中 / 原生异常一律返回 null（或由调用方回退 officecli），保证不因原生失败而中断。
 *
 * 路由矩阵（officeCapabilityMatrix，P2-C）：
 *   native: create(docx/xlsx/pptx)、view text|outline|stats(docx/pptx/xlsx)、
 *           set / --find --replace（docx，无修订跟踪时）
 *   cli:    get/query/batch/add/remove/move/swap/delete/import/export/open/close/save/
 *           validate/refresh/dump/watch、view 其余模式（html/svg/screenshot/annotated/
 *           issues/forms）、set 的属性/样式操作，以及图表/透视表/修订/Morph 等高级能力
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { resolveFontSize, resolveLineSpacing, resolvePageMargins, PAGE_SIZE } from "./office规范/设计令牌.mjs";
import { calcTitleLayout, calcCoverSpacing } from "./office规范/封面布局.mjs";
import { selectCoverRecipe } from "./office规范/封面配方.mjs";
import { getScene } from "./office规范/场景选择.mjs";
import { postProcessDocx } from "./office规范/后处理.mjs";

const DOCX_EXT = /\.docx$/i;
const XLSX_EXT = /\.(?:xlsx|xls)$/i;
const PPTX_EXT = /\.pptx$/i;

/** 原生 Office 路径总开关；OAW_OFFICE_NATIVE=0 可完全退回 officecli。 */
export function isNativeOfficeEnabled() {
  return String(process.env.OAW_OFFICE_NATIVE || "1") !== "0";
}

/** 原生读取/写入的输出上限（防大文件淹没模型上下文）。 */
const MAX_NATIVE_TEXT_CHARS = 400_000;

// ---------------------------------------------------------------------------
// 能力矩阵（P2-C）：哪个格式、哪类操作原生 / 哪类必须 CLI
// ---------------------------------------------------------------------------

const NATIVE_VIEW_MODES = new Set(["text", "outline", "stats"]);

const CAPABILITY_MATRIX = Object.freeze({
  docx: Object.freeze({
    native: Object.freeze(["create", "create:styled", "view:text", "view:outline", "view:stats", "set:find_replace"]),
    requiresCli: Object.freeze(["get", "query", "batch", "add", "remove", "move", "swap", "delete", "import", "export", "open", "close", "save", "validate", "refresh", "dump", "watch", "view:html", "view:svg", "view:screenshot", "view:annotated", "view:issues", "view:forms", "set:style", "set:prop", "chart", "revision", "comment", "form", "protect", "pdf_export"]),
  }),
  xlsx: Object.freeze({
    native: Object.freeze(["create", "view:text", "view:outline", "view:stats"]),
    requiresCli: Object.freeze(["get", "query", "batch", "add", "remove", "move", "swap", "delete", "import", "export", "open", "close", "save", "validate", "refresh", "dump", "watch", "view:html", "view:svg", "view:screenshot", "view:annotated", "view:issues", "view:forms", "set", "chart", "pivot", "formula", "conditional_format", "sparkline", "pdf_export"]),
  }),
  pptx: Object.freeze({
    native: Object.freeze(["create", "view:text", "view:outline", "view:stats"]),
    requiresCli: Object.freeze(["get", "query", "batch", "add", "remove", "move", "swap", "delete", "import", "export", "open", "close", "save", "validate", "refresh", "dump", "watch", "view:html", "view:svg", "view:screenshot", "view:annotated", "view:issues", "view:forms", "set", "chart", "morph", "smartart", "ole", "media", "pdf_export"]),
  }),
});

/** 能力矩阵快照（诊断/路由说明用，P2-C）。 */
export function officeCapabilityMatrix() {
  return JSON.parse(JSON.stringify(CAPABILITY_MATRIX));
}

/** 只解析简单 --prop key=value（原生文本编辑用；复杂属性仍交 CLI）。 */
function simplePropMap(list = []) {
  const props = {};
  for (let i = 0; i < list.length; i += 1) {
    if (String(list[i]) !== "--prop") continue;
    const pair = String(list[i + 1] ?? "");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    props[key] = value;
  }
  return props;
}

/**
 * 路由判定（P2-C）：这条命令是否必须交给 officecli。
 * @returns {{needsCli: boolean, reason: string}}
 */
export function needsCli(command, args = []) {
  const cmd = String(command || "").trim().toLowerCase();
  const list = Array.isArray(args) ? args.map(String) : [];
  switch (cmd) {
    case "create":
      // create 全格式原生（docx/xlsx/pptx）；--styled 表示带版式参数直写（O-17）
      return { needsCli: false, reason: list.includes("--styled") ? "create --styled 原生直写（含版式）" : "create 原生直写" };
    case "view": {
      const mode = String(list[2] || "").trim().toLowerCase();
      if (NATIVE_VIEW_MODES.has(mode)) return { needsCli: false, reason: `view ${mode} 原生读取` };
      return { needsCli: true, reason: `view ${mode || "(缺省)"} 需要 CLI 渲染/高保真输出` };
    }
    case "set": {
      const target = String(list[2] || "/").trim();
      const hasFind = list.some((t) => t === "--find");
      const hasReplace = list.some((t) => t === "--replace");
      const props = simplePropMap(list);
      if ((target === "/" || target === "") && hasFind && hasReplace && props.text === undefined) {
        return { needsCli: false, reason: "set 全文查找替换走原生（docx）" };
      }
      // 简单文本操作：段落正文/标题样式走原生；批注、修订、复杂格式仍走 CLI。
      if (/^\/body\/p\[\d+\]$/.test(target) && (props.text !== undefined || props.style !== undefined)) {
        return { needsCli: false, reason: "set 段落文本/样式走原生（docx）" };
      }
      return { needsCli: true, reason: "set 属性/样式/定点编辑需要 CLI 精确定位" };
    }
    case "add": {
      const target = String(list[2] || "").trim();
      const typeIndex = list.indexOf("--type");
      const type = typeIndex >= 0 ? String(list[typeIndex + 1] || "").toLowerCase() : "";
      const props = simplePropMap(list);
      if (type === "paragraph" && /^\/body(?:\/p\[\d+\])?$/.test(target) && props.text !== undefined) {
        return { needsCli: false, reason: "add 普通段落走原生（docx）" };
      }
      return { needsCli: true, reason: "add 图片/表格/批注等需要 CLI" };
    }
    default:
      return { needsCli: true, reason: `${cmd || "(未知)"} 由 officecli 兜底` };
  }
}

// ---------------------------------------------------------------------------
// 结果构造：与 runOfficecliOnce 同形
// ---------------------------------------------------------------------------

function nativeResult(command, { text = "", json = null, code = 0 } = {}) {
  return {
    code,
    stdout: text,
    stderr: "",
    text,
    json,
    command: command.map(String),
    engine: "native",
  };
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlUnescape(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 工作区内相对路径解析；越界返回 null（交回上层 CLI 校验报错）。 */
function resolveInWorkspace(file, cwd) {
  const root = path.resolve(cwd);
  const target = path.resolve(root, String(file || ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function capText(text) {
  const value = String(text || "");
  if (value.length <= MAX_NATIVE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_NATIVE_TEXT_CHARS)}\n…（原生读取截断：全文 ${value.length} 字符，仅显示前 ${MAX_NATIVE_TEXT_CHARS}）`;
}

// ---------------------------------------------------------------------------
// docx：段落抽取 / 大纲 / 统计 / 全文替换
// ---------------------------------------------------------------------------

/** 解析 word/document.xml 的段落序列：文本 + 段落样式（大纲级别判定用）。 */
function docxParagraphs(documentXml) {
  const paragraphs = [];
  const pattern = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  for (const match of String(documentXml || "").matchAll(pattern)) {
    const block = match[0];
    const texts = [...block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => xmlUnescape(m[1]));
    const style = block.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] || "";
    const hasRevision = /<w:(?:ins|del)\s/.test(block);
    paragraphs.push({ text: texts.join(""), style, hasRevision });
  }
  return paragraphs;
}

function headingLevel(style) {
  const match = String(style || "").match(/^(?:heading|Heading|标题)\s*([1-9])$/i) || String(style || "").match(/^Heading([1-9])$/i);
  return match ? Number(match[1]) : 0;
}

function countWords(text) {
  const cjk = (String(text).match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

function docxViewText(documentXml) {
  const paragraphs = docxParagraphs(documentXml);
  return capText(paragraphs.map((p) => p.text).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
}

function docxViewOutline(documentXml) {
  const lines = [];
  for (const p of docxParagraphs(documentXml)) {
    const level = headingLevel(p.style);
    if (level && p.text.trim()) lines.push(`${"#".repeat(Math.min(level, 6))} ${p.text.trim()}`);
  }
  return capText(lines.join("\n"));
}

function docxViewStats(documentXml) {
  const paragraphs = docxParagraphs(documentXml);
  const fullText = paragraphs.map((p) => p.text).join("\n");
  const stats = {
    format: "docx",
    paragraphs: paragraphs.length,
    nonEmptyParagraphs: paragraphs.filter((p) => p.text.trim()).length,
    words: countWords(fullText),
    characters: fullText.length,
    headings: paragraphs.filter((p) => headingLevel(p.style)).length,
    tables: (String(documentXml).match(/<w:tbl>/g) || []).length,
    images: (String(documentXml).match(/<w:drawing[ >]/g) || []).length,
    comments: (String(documentXml).match(/<w:commentReference\s/g) || []).length,
    revisions: /<w:(?:ins|del)\s/.test(String(documentXml)) ? true : false,
  };
  return { text: JSON.stringify(stats, null, 2), json: stats };
}

/**
 * docx 全文查找替换（run 感知）：
 *  - 查找词落在单个 w:t 内 → 原位替换（最常见，零格式损耗）；
 *  - 跨 run（被拼写检查/输入法切散）→ 段落合并为单 run（保留首个 run 的 rPr）；
 *    段内含图片/OLE/修订标记时放弃原生（返回 null，交 CLI），避免破坏内容。
 * @returns {Promise<null|{code,text,json,command,engine}>} null = 原生不支持，交回 CLI
 */
async function docxReplaceText(file, findText, replaceText) {
  const buffer = await fs.promises.readFile(file);
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) return null;
  const xml = await entry.async("string");
  if (/<w:(?:ins|del)\s/.test(xml)) return null; // 修订跟踪文档交 CLI（能力矩阵：revision→cli）

  let replaced = 0;
  const findEscaped = xmlEscape(findText);
  const replaceEscaped = xmlEscape(replaceText);

  const rewritten = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const texts = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const fullText = xmlUnescape(texts.join(""));
    if (!fullText || !fullText.includes(findText)) return paragraph;

    // 情形 1：单个 w:t 原位替换
    if (texts.some((t) => xmlUnescape(t).includes(findText))) {
      replaced += 1;
      return paragraph.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, content, close) => {
        const plain = xmlUnescape(content);
        if (!plain.includes(findText)) return whole;
        return `${open}${xmlEscape(plain.split(findText).join(replaceText))}${close}`;
      });
    }

    // 情形 2：跨 run 替换 —— 段内有图片/OLE 等非文本内容时放弃，避免合并丢内容
    if (/<w:(?:drawing|pict|object|hyperlink)[ >/]/.test(paragraph)) return paragraph;

    // 合并段落 runs 为单 run（保留首个带 rPr 的 run 属性与段落属性 pPr）
    replaced += 1;
    const pPr = paragraph.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || "";
    const rPr = paragraph.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || "";
    const preserve = /\s/.test(fullText) ? ' xml:space="preserve"' : "";
    const openTag = paragraph.match(/^<w:p\b[^>]*>/)?.[0] || "<w:p>";
    return `${openTag}${pPr}<w:r>${rPr}<w:t${preserve}>${xmlEscape(fullText.split(findText).join(replaceText))}</w:t></w:r></w:p>`;
  });

  if (!replaced) {
    return nativeResult(["set", path.basename(file), "/", "--find", findText, "--replace", replaceText], {
      text: `未找到需要替换的文本：${findText}`,
      json: { engine: "native", file: path.basename(file), replaced: 0 },
    });
  }
  // 把改写后的 document.xml 写回 ZIP（关键步骤：只在内存里替换不会落盘）
  zip.file("word/document.xml", rewritten);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.promises.writeFile(file, output);
  return nativeResult(["set", path.basename(file), "/", "--find", findText, "--replace", replaceText], {
    text: `已完成原生替换：${replaced} 个段落（find=${findText} → replace=${replaceText}）`,
    json: { engine: "native", file: path.basename(file), replaced, find: findText, replace: replaceText },
  });
}

// ---------------------------------------------------------------------------
// docx：简单段落文本/样式编辑（原生；批注/修订/复杂格式仍走 CLI）
// ---------------------------------------------------------------------------

function docxParagraphBlocks(xml) {
  const blocks = [];
  const pattern = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  for (const match of String(xml || "").matchAll(pattern)) {
    blocks.push({ start: match.index, end: match.index + match[0].length, xml: match[0] });
  }
  return blocks;
}

function docxParagraphParts(blockXml) {
  return {
    pPr: blockXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/)?.[0] || "",
    rPr: blockXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>/)?.[0] || "",
  };
}

function applyParagraphStyle(pPr, style) {
  const value = xmlEscape(style);
  if (!pPr) return `<w:pPr><w:pStyle w:val="${value}"/></w:pPr>`;
  if (/<w:pStyle\b[^>]*\/>/.test(pPr)) return pPr.replace(/<w:pStyle\b[^>]*\/>/, `<w:pStyle w:val="${value}"/>`);
  if (/<w:pPr\b[^>]*>/.test(pPr)) return pPr.replace(/(<w:pPr\b[^>]*>)/, `$1<w:pStyle w:val="${value}"/>`);
  return `<w:pPr><w:pStyle w:val="${value}"/></w:pPr>`;
}

function buildDocxParagraph(text, { style = "", template = null } = {}) {
  const parts = template ? docxParagraphParts(template) : { pPr: "", rPr: "" };
  const pPr = style ? applyParagraphStyle(parts.pPr, style) : parts.pPr;
  const preserve = /\s/.test(String(text)) ? ' xml:space="preserve"' : "";
  return `<w:p>${pPr}<w:r>${parts.rPr}<w:t${preserve}>${xmlEscape(text)}</w:t></w:r></w:p>`;
}

async function writeDocxXml(file, zip, xml) {
  zip.file("word/document.xml", xml);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.promises.writeFile(file, output);
}

async function docxEditParagraph(file, pathLink, props) {
  const index = Number(String(pathLink).match(/\[(\d+)\]/)?.[1] || 0);
  if (!index) return null;
  const buffer = await fs.promises.readFile(file);
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) return null;
  let xml = await entry.async("string");
  if (/<w:(?:ins|del)\s/.test(xml)) return null; // 修订跟踪交 CLI
  const blocks = docxParagraphBlocks(xml);
  const block = blocks[index - 1];
  if (!block) {
    return nativeResult(["set", path.basename(file), pathLink, "--prop", `text=${props.text ?? ""}`], {
      code: 1,
      text: `段落不存在：${pathLink}（文档共 ${blocks.length} 个段落）`,
      json: { engine: "native", file: path.basename(file), error: "paragraph_not_found", paragraphs: blocks.length },
    });
  }
  let nextParagraph = block.xml;
  if (props.text !== undefined) {
    const style = props.style !== undefined ? String(props.style) : "";
    nextParagraph = buildDocxParagraph(String(props.text), { style, template: block.xml });
  } else if (props.style !== undefined) {
    const pPr = applyParagraphStyle(docxParagraphParts(block.xml).pPr, String(props.style));
    if (/<w:pPr\b[\s\S]*?<\/w:pPr>/.test(block.xml)) {
      nextParagraph = block.xml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, pPr);
    } else {
      nextParagraph = block.xml.replace(/(<w:p\b[^>]*>)/, `$1${pPr}`);
    }
  }
  xml = `${xml.slice(0, block.start)}${nextParagraph}${xml.slice(block.end)}`;
  await writeDocxXml(file, zip, xml);
  return nativeResult(["set", path.basename(file), pathLink, "--prop", `text=${props.text ?? ""}`], {
    text: `已原生更新段落 ${pathLink}`,
    json: { engine: "native", file: path.basename(file), paragraph: index, text: props.text ?? null, style: props.style ?? null },
  });
}

async function docxAddParagraph(file, targetLink, props) {
  const buffer = await fs.promises.readFile(file);
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) return null;
  let xml = await entry.async("string");
  if (/<w:(?:ins|del)\s/.test(xml)) return null;
  const blocks = docxParagraphBlocks(xml);
  const indexMatch = String(targetLink).match(/\[(\d+)\]/);
  const index = indexMatch ? Number(indexMatch[1]) : 0;
  if (indexMatch && (!index || index > blocks.length)) {
    return nativeResult(["add", path.basename(file), targetLink, "--type", "paragraph"], {
      code: 1,
      text: `段落不存在：${targetLink}（文档共 ${blocks.length} 个段落）`,
      json: { engine: "native", file: path.basename(file), error: "paragraph_not_found", paragraphs: blocks.length },
    });
  }
  const template = index ? blocks[index - 1]?.xml : blocks[blocks.length - 1]?.xml || "";
  const paragraph = buildDocxParagraph(String(props.text ?? ""), { style: props.style !== undefined ? String(props.style) : "", template });
  if (index) {
    const block = blocks[index - 1];
    xml = `${xml.slice(0, block.end)}${paragraph}${xml.slice(block.end)}`;
  } else {
    const sect = xml.search(/<w:sectPr\b/);
    if (sect >= 0) xml = `${xml.slice(0, sect)}${paragraph}${xml.slice(sect)}`;
    else xml = xml.replace("</w:body>", `${paragraph}</w:body>`);
  }
  await writeDocxXml(file, zip, xml);
  return nativeResult(["add", path.basename(file), targetLink, "--type", "paragraph"], {
    text: `已原生插入段落：${targetLink}`,
    json: { engine: "native", file: path.basename(file), after: index || null, text: props.text ?? null, style: props.style ?? null },
  });
}

// ---------------------------------------------------------------------------
// pptx：幻灯片文本抽取
// ---------------------------------------------------------------------------

async function pptxSlides(file) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slides = [];
  for (const name of names) {
    const xml = await zip.file(name).async("string");
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => [...m[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => xmlUnescape(t[1])).join(""));
    // 表格文本（a:tbl 内的 a:t 不在 p:sp 里，读取时一并抽出）
    const tableTexts = [...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)].map((m) =>
      [...m[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => xmlUnescape(t[1])).join(" ").trim());
    const texts = [...shapes, ...tableTexts].filter((t) => t.trim());
    const tables = (xml.match(/<a:tbl>/g) || []).length;
    const images = (xml.match(/<p:pic\b/g) || []).length;
    slides.push({ index: Number(name.match(/slide(\d+)/)?.[1] || 0), texts, tables, images });
  }
  return slides;
}

async function pptxViewText(file) {
  const slides = await pptxSlides(file);
  const lines = [];
  for (const slide of slides) {
    lines.push(`--- 幻灯片 ${slide.index} ---`);
    lines.push(...slide.texts);
  }
  return capText(lines.join("\n"));
}

async function pptxViewOutline(file) {
  const slides = await pptxSlides(file);
  const lines = slides.map((slide) => `- 幻灯片 ${slide.index}：${(slide.texts[0] || "（无标题）").trim().slice(0, 80)}`);
  return capText(lines.join("\n"));
}

async function pptxViewStats(file) {
  const slides = await pptxSlides(file);
  const stats = {
    format: "pptx",
    slides: slides.length,
    shapes: slides.reduce((sum, s) => sum + s.texts.length + s.images, 0),
    textItems: slides.reduce((sum, s) => sum + s.texts.length, 0),
    tables: slides.reduce((sum, s) => sum + s.tables, 0),
    images: slides.reduce((sum, s) => sum + s.images, 0),
  };
  return { text: JSON.stringify(stats, null, 2), json: stats };
}

// ---------------------------------------------------------------------------
// xlsx：工作表读取
// ---------------------------------------------------------------------------

async function loadWorkbook(file) {
  const mod = await import("xlsx");
  const XLSX = mod.default || mod;
  return { XLSX, workbook: XLSX.readFile(file, { cellText: true, cellDates: true }) };
}

async function xlsxViewText(file) {
  const { XLSX, workbook } = await loadWorkbook(file);
  const sections = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return `## ${name}\n${XLSX.utils.sheet_to_csv(sheet, { FS: "\t" })}`;
  });
  return capText(sections.join("\n\n").trimEnd());
}

async function xlsxViewOutline(file) {
  const { workbook } = await loadWorkbook(file);
  const lines = workbook.SheetNames.map((name) => {
    const ref = workbook.Sheets[name]?.["!ref"] || "空表";
    return `- ${name}（${ref}）`;
  });
  return capText(lines.join("\n"));
}

async function xlsxViewStats(file) {
  const { XLSX, workbook } = await loadWorkbook(file);
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name] || {};
    const ref = String(sheet["!ref"] || "");
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    return {
      name,
      range: ref || null,
      rows: rows.length,
      cols: rows.reduce((max, row) => Math.max(max, row.length), 0),
      cells: rows.reduce((sum, row) => sum + row.filter((cell) => String(cell ?? "").trim()).length, 0),
    };
  });
  const stats = { format: "xlsx", sheets: sheets.length, detail: sheets };
  return { text: JSON.stringify(stats, null, 2), json: stats };
}

// ---------------------------------------------------------------------------
// create：docx（docx@9）/ xlsx（xlsx@0.18）/ pptx（pptxgenjs，P1-B）
// ---------------------------------------------------------------------------

/** 仅拦截"新建文档/表格/演示文稿"纯创建命令；其它命令返回 null 交给 officecli。 */
export function canCreateNatively(args) {
  if (!Array.isArray(args) || !args.length) return null;
  if (String(args[0] || "").trim().toLowerCase() !== "create") return null;
  const file = String(args[1] || "").trim();
  if (!file) return null;
  if (DOCX_EXT.test(file)) return { file, format: "docx" };
  if (XLSX_EXT.test(file)) return { file, format: "xlsx" };
  if (PPTX_EXT.test(file)) return { file, format: "pptx" };
  return null;
}

/**
 * 标准样式集（计划 2026-10-31-003 / N-04）。
 *
 * 背景：docx@9 默认只生成 Title/Heading1-6 等 16 个样式，**没有 Normal**。
 * 实测 run_05198175 里模型先 `create` 文档、再用 `set --prop style=Normal` 正文，
 * 于是报 "Style 'Normal' not found"；随后改用 `raw-set` 手写 styles.xml XPath，
 * 连环失败 7 次并最终把 OOXML 写坏（Malformed XML）。
 *
 * 这里在建档时预置一套交通规划常用样式（正文/标题 1-4/标题/目录/页眉页脚），
 * 让模型可以直接引用样式 id，不必手写 styles.xml。
 */
export const STANDARD_DOCX_STYLE_IDS = Object.freeze([
  "Normal", "Heading1", "Heading2", "Heading3", "Heading4",
  "Title", "TOC1", "TOC2", "Header", "Footer",
]);

/**
 * docx@9 默认生成的样式 id（探针实测）。
 *
 * 关键：Heading1-6 / Title 等**已经存在**于默认样式集里。若把它们再写进
 * `paragraphStyles`，styles.xml 会出现重复的 styleId，OfficeCLI 读文档时
 * 直接抛 "An item with the same key has already been added. Key: Heading1"，
 * 整份文档的 view issues / validate 全废（实测踩过）。
 *
 * 因此：内置样式走 `default.*` 覆盖（改的是同一份定义，不会重复），
 * 只有默认集里没有的（Normal / TOC1 / TOC2 / Header / Footer）才用 paragraphStyles 新增。
 */
export const DOCX_BUILTIN_STYLE_IDS = Object.freeze([
  "Title", "Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6",
  "Strong", "ListParagraph", "Hyperlink", "FootnoteReference", "FootnoteText",
  "FootnoteTextChar", "EndnoteReference", "EndnoteText", "EndnoteTextChar",
]);

/**
 * 构建 docx 的 styles 配置。
 *
 * @param {object} [opts] { scene } 场景参数，决定字号/字体/行距
 */
export function buildStandardDocxStyles(opts = {}) {
  const scene = typeof opts.scene === "string" ? getScene(opts.scene) : opts.scene || getScene("report");
  const bodyPt = resolveFontSize(opts.bodyPt ?? scene?.font?.bodyPt, 12);
  const h1Pt = resolveFontSize(opts.h1Pt ?? scene?.font?.h1Pt, 16);
  const h2Pt = resolveFontSize(opts.h2Pt ?? scene?.font?.h2Pt, 14);
  const h3Pt = resolveFontSize(opts.h3Pt ?? scene?.font?.h3Pt, 14);
  const line = resolveLineSpacing(opts.line ?? scene?.spacing?.line, "normal");
  const bodyFont = opts.bodyFont || scene?.font?.body || "SimSun";
  const headingFont = opts.headingFont || scene?.font?.heading || "SimHei";
  const firstLine = Number(opts.firstLine ?? scene?.spacing?.firstLine ?? 480) || 0;

  const run = (font, pt, bold = false) => ({
    font: { ascii: font, eastAsia: font, hAnsi: font },
    size: pt.halfPoints,
    bold,
  });
  const spacing = { line: line.line, lineRule: line.rule };
  const smallRun = { font: { ascii: bodyFont, eastAsia: bodyFont, hAnsi: bodyFont }, size: bodyPt.halfPoints - 2 };

  return {
    // ---- 内置样式：覆盖 docx 的默认定义（不会产生重复 styleId）----
    default: {
      document: { run: run(bodyFont, bodyPt), paragraph: { spacing } },
      title: {
        run: run(headingFont, h1Pt, true),
        paragraph: { alignment: "center", spacing: { before: 240, after: 240 } },
      },
      heading1: {
        run: run(headingFont, h1Pt, true),
        paragraph: { spacing: { ...spacing, before: 240, after: 120 }, outlineLevel: 0 },
      },
      heading2: {
        run: run(headingFont, h2Pt, true),
        paragraph: { spacing: { ...spacing, before: 200, after: 100 }, outlineLevel: 1 },
      },
      heading3: {
        run: run(headingFont, h3Pt, true),
        paragraph: { spacing: { ...spacing, before: 160, after: 80 }, outlineLevel: 2 },
      },
      heading4: {
        run: run(headingFont, h3Pt, true),
        paragraph: { spacing: { ...spacing, before: 140, after: 70 }, outlineLevel: 3 },
      },
    },
    // ---- 默认集里没有的样式：新增 ----
    paragraphStyles: [
      {
        id: "Normal", name: "Normal", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: run(bodyFont, bodyPt),
        paragraph: { spacing, indent: firstLine ? { firstLine } : undefined },
      },
      {
        id: "TOC1", name: "toc 1", basedOn: "Normal", next: "Normal",
        run: run(bodyFont, bodyPt, true),
        paragraph: { spacing, indent: {} },
      },
      {
        id: "TOC2", name: "toc 2", basedOn: "Normal", next: "Normal",
        run: run(bodyFont, bodyPt),
        paragraph: { spacing, indent: { left: 420 } },
      },
      {
        id: "Header", name: "header", basedOn: "Normal", next: "Normal",
        run: smallRun,
        paragraph: { alignment: "center", spacing, indent: {} },
      },
      {
        id: "Footer", name: "footer", basedOn: "Normal", next: "Normal",
        run: smallRun,
        paragraph: { alignment: "center", spacing, indent: {} },
      },
    ],
  };
}

async function createNativeDocx(target, opts = {}) {
  const { Document, Packer, Paragraph } = await import("docx");
  const styles = opts.noStyles ? undefined : buildStandardDocxStyles(opts);
  const doc = new Document({
    ...(styles ? { styles } : {}),
    sections: [{ children: [new Paragraph("")] }],
  });
  const buffer = await Packer.toBuffer(doc);
  await fs.promises.writeFile(target, buffer);
}

async function createNativeXlsx(target) {
  const mod = await import("xlsx");
  const XLSX = mod.default || mod;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
  XLSX.writeFile(workbook, target);
}

async function createNativePptx(target) {
  // P1-B：pptxgenjs 生成有效的基础 .pptx（零幻灯片的空演示文稿）。
  const mod = await import("pptxgenjs");
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.author = "Open Plan";
  pptx.company = "Open Plan";
  pptx.title = path.basename(target).replace(/\.pptx$/i, "");
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  await fs.promises.writeFile(target, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

/**
 * P2-A Formatter：按结构化大纲（每页 { title, bullets[], table?{headers,rows} }）原生生成 .pptx。
 * 这是"生成 PPT 初稿"高频场景的原生直写路径——每步产物可检查，Evaluator 复用 view stats 校验。
 * @returns {{file:string, slides:number, engine:"native"}}
 */
export async function buildPptxFromSlides(target, slides = []) {
  const mod = await import("pptxgenjs");
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.author = "Open Plan";
  pptx.company = "Open Plan";
  pptx.title = path.basename(target).replace(/\.pptx$/i, "");
  for (const slide of slides) {
    const page = pptx.addSlide();
    const title = String(slide?.title || "").trim();
    if (title) page.addText(title, { x: 0.6, y: 0.4, w: 8.8, h: 0.9, fontSize: 28, bold: true });
    const bullets = (Array.isArray(slide?.bullets) ? slide.bullets : []).map((item) => String(item || "").trim()).filter(Boolean);
    if (bullets.length) {
      page.addText(bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })), {
        x: 0.9, y: 1.5, w: 8.2, h: 3.6, fontSize: 16, lineSpacingMultiple: 1.2,
      });
    }
    const table = slide?.table;
    if (table && Array.isArray(table.headers) && Array.isArray(table.rows)) {
      page.addTable(
        [table.headers.map((cell) => ({ text: String(cell ?? ""), options: { bold: true } })),
         ...table.rows.map((row) => (Array.isArray(row) ? row : [row]).map((cell) => ({ text: String(cell ?? "") })))],
        { x: 0.9, y: bullets.length ? 4.2 : 1.6, w: 8.2, fontSize: 12, border: { type: "solid", color: "D9D9D9" } },
      );
    }
    if (!title && !bullets.length && !table) page.addText("", { x: 0.6, y: 0.4 });
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  await fs.promises.writeFile(target, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  return { file: target, slides: slides.length, engine: "native" };
}

/**
 * Markdown → blocks v2（计划 008 / P1-2）。
 * 支持标题、段落、管道表格；代码块跳过；图片按段落文本保留。
 */
export function markdownToBlocks(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let table = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  };
  const flushTable = () => {
    if (table.length >= 2) {
      const rows = table.map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
      const data = rows.filter((row) => !row.every((cell) => !cell || /^:?-{2,}:?$/.test(cell)));
      if (data.length) blocks.push({ type: "table", rows: data });
    }
    table = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); flushTable(); continue; }
    if (/^```/.test(trimmed)) { flushParagraph(); flushTable(); continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushTable();
      blocks.push({ type: "heading", text: heading[2].trim(), level: Math.min(3, heading[1].length) });
      continue;
    }
    if (/^\|/.test(trimmed)) {
      flushParagraph();
      table.push(trimmed);
      continue;
    }
    flushTable();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushTable();
  return blocks;
}

/**
 * P2-A Formatter：按结构化大纲生成 .docx（标题/段落/表格）。
 *
 * v2（O-17）：新增 style / scene / cover / toc / header / footer / pageNumbers 选项。
 * 不传任何选项时行为与旧版逐字一致（旧 blocks 兼容）。
 * @returns {{file:string, blocks:number, engine:"native", styled?:boolean, postProcess?:string[]}}
 */
export async function buildDocxFromBlocks(target, blocks = [], options = {}) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
    AlignmentType, Header, Footer, PageNumber, TableOfContents, PageBreak,
  } = await import("docx");

  const styled = Boolean(options.style || options.scene || options.cover || options.toc || options.header || options.footer || options.pageNumbers || options.margins);
  const scene = typeof options.scene === "string" ? getScene(options.scene) : options.scene || null;
  const bodyPt = resolveFontSize(options.style?.bodyPt ?? scene?.font?.bodyPt, 12);
  const headingPt = resolveFontSize(options.style?.headingPt ?? scene?.font?.h1Pt, 16);
  const line = resolveLineSpacing(options.style?.line ?? scene?.spacing?.line, "normal");
  const firstLine = Number(options.style?.firstLine ?? scene?.spacing?.firstLine ?? 480) || 0;
  const bodyFont = options.style?.font || scene?.font?.body || "SimSun";
  const headingFont = scene?.font?.heading || "SimHei";
  const margins = resolvePageMargins(options.margins || scene?.page?.margins, "normal");
  const recipe = options.cover ? selectCoverRecipe(options.cover.docType || scene?.cover?.recipe || "report") : null;

  const bodyParagraph = (text, extra = {}) => new Paragraph({
    children: [new TextRun({ text: String(text), font: bodyFont, size: bodyPt.halfPoints })],
    spacing: { line: line.line, lineRule: line.rule },
    indent: firstLine ? { firstLine } : undefined,
    alignment: AlignmentType.JUSTIFIED,
    ...extra,
  });

  const headingParagraph = (text, level) => new Paragraph({
    children: [new TextRun({ text: String(text), font: headingFont, size: headingPt.halfPoints, bold: true })],
    heading: level,
    spacing: { line: line.line, lineRule: line.rule, before: 240, after: 120 },
  });

  const children = [];

  // ---- 封面（O-07/O-08）：只走配方，不自由布局 ----
  if (options.cover) {
    const title = String(options.cover.title || "").trim();
    const layout = calcTitleLayout({ title, maxWidthTwips: PAGE_SIZE.width - margins.left - margins.right });
    const spacing = calcCoverSpacing({ contentHeightTwips: layout.totalHeightTwips + 2400 });
    const titleColor = recipe?.titleColor || "#1F2933";
    if (spacing.top > 0) children.push(new Paragraph({ spacing: { before: spacing.top } }));
    for (const lineText of layout.lines) {
      children.push(new Paragraph({
        children: [new TextRun({ text: lineText, font: headingFont, size: layout.halfPoints, bold: true, color: titleColor.replace("#", "") })],
        alignment: recipe?.titleAlign === "left" ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { line: 360, lineRule: "auto", after: 160 },
      }));
    }
    const subtitle = String(options.cover.subtitle || "").trim();
    if (subtitle) {
      children.push(new Paragraph({
        children: [new TextRun({ text: subtitle, font: bodyFont, size: 28, color: (recipe?.subtitleColor || "#333333").replace("#", "") })],
        alignment: recipe?.titleAlign === "left" ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { line: 312, lineRule: "auto", after: 120 },
      }));
    }
    const metaLines = Array.isArray(options.cover.metaLines) ? options.cover.metaLines : [];
    if (spacing.gap > 0) children.push(new Paragraph({ spacing: { before: spacing.gap } }));
    for (const meta of metaLines) {
      children.push(new Paragraph({
        children: [new TextRun({ text: String(meta), font: bodyFont, size: 24, color: "444444" })],
        alignment: recipe?.titleAlign === "left" ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { line: 312, lineRule: "auto", after: 80 },
      }));
    }
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // ---- 目录（O-18）：TableOfContents + updateFields 后处理 ----
  if (options.toc) {
    children.push(new Paragraph({
      children: [new TextRun({ text: "目录", font: headingFont, size: headingPt.halfPoints, bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }));
    children.push(new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" }));
    children.push(new Paragraph({
      children: [new TextRun({ text: "（右键目录 → 更新域，可刷新页码）", italics: true, size: 21, color: "888888" })],
      spacing: { before: 120, after: 120 },
    }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  for (const block of blocks) {
    const kind = String(block?.type || "paragraph").toLowerCase();
    const text = String(block?.text ?? "").trim();
    if (!text && kind !== "image" && kind !== "table" && kind !== "pagebreak" && kind !== "toc") continue;
    if (kind === "heading" || kind === "h1" || kind === "h2" || kind === "h3") {
      const level = kind === "h1" || block?.level === 1 ? HeadingLevel.HEADING_1
        : kind === "h3" || block?.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2;
      children.push(styled ? headingParagraph(text, level) : new Paragraph({ text, heading: level }));
    } else if (kind === "table" && Array.isArray(block?.rows)) {
      const rows = block.rows.map((row) => new TableRow({
        children: (Array.isArray(row) ? row : [row]).map((cell) => new TableCell({
          children: [new Paragraph(String(cell ?? ""))],
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
        })),
      }));
      children.push(new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
      }));
    } else if (kind === "image" && block?.path) {
      // G8：图集嵌入——读取本地图片（相对/绝对路径均可，调用方负责路径安全），
      // 尺寸由调用方以 transformation 传入（等比缩放由 probeImageSize 提供）。
      const { ImageRun } = await import("docx");
      const data = await fs.promises.readFile(block.path);
      children.push(new Paragraph({
        children: [new ImageRun({
          type: block.format === "png" ? "png" : "jpg",
          data,
          transformation: { width: Number(block.width) || 480, height: Number(block.height) || 320 },
        })],
      }));
    } else if (kind === "pagebreak") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    } else {
      children.push(styled ? bodyParagraph(text) : new Paragraph(text));
    }
  }
  if (!children.length) children.push(new Paragraph(""));

  const sectionProperties = {
    page: {
      size: { width: PAGE_SIZE.width, height: PAGE_SIZE.height },
      margin: { top: margins.top, bottom: margins.bottom, left: margins.left, right: margins.right },
      ...(options.pageNumbers ? { pageNumbers: { start: 1 } } : {}),
    },
  };
  const headers = options.header ? { default: new Header({ children: [new Paragraph(String(options.header))] }) } : undefined;
  const footers = options.footer
    ? {
        default: new Footer({
          children: [new Paragraph({
            children: [
              new TextRun({ text: `${String(options.footer)} `, size: 18 }),
              new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
            ],
            alignment: AlignmentType.CENTER,
          })],
        }),
      }
    : undefined;

  // N-04：同样预置标准样式集——流水线产物也要能被 `set --prop style=Normal` 之类引用，
  // 否则用户拿到成品后再让 Agent 精修时会重演"Style not found"。
  const docStyles = options.noStyles ? undefined : buildStandardDocxStyles({
    scene: scene || "report",
    bodyPt: options.style?.bodyPt,
    h1Pt: options.style?.headingPt,
    h2Pt: scene?.font?.h2Pt,
    h3Pt: scene?.font?.h3Pt,
    line: options.style?.line,
    firstLine: options.style?.firstLine,
    bodyFont: options.style?.font,
    headingFont: scene?.font?.heading,
  });
  const doc = new Document({
    ...(docStyles ? { styles: docStyles } : {}),
    sections: [{ properties: sectionProperties, headers, footers, children }],
  });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, await Packer.toBuffer(doc));

  let postProcess = [];
  if (options.toc || options.pageNumbers) {
    const result = await postProcessDocx(target, { toc: Boolean(options.toc), pageNumbers: Boolean(options.pageNumbers) });
    postProcess = result.changes;
  }
  return { file: target, blocks: blocks.length, engine: "native", styled, postProcess };
}

function nativeCreateResult(command, file, format) {
  const label = { docx: "Word 文档", xlsx: "Excel 表格", pptx: "PPT 演示文稿" }[format] || format;
  const text = `已创建 ${file}（${label}，原生引擎直写，无需 Office CLI 冷启动）`;
  return { code: 0, stdout: text, stderr: "", text, json: { engine: "native", file, format }, command, engine: "native" };
}

/**
 * 原生创建：命中并成功时返回与 officecli 同形的结果，
 * 未命中（含已存在文件、越界路径）返回 null（由调用方走 officecli）。
 */
export async function createNativeOffice(args, { cwd = process.cwd() } = {}) {
  if (!isNativeOfficeEnabled()) return null;
  const spec = canCreateNatively(args);
  if (!spec) return null;
  const root = path.resolve(cwd);
  const target = resolveInWorkspace(spec.file, root);
  // 越界路径不做原生处理，交回 officecli（那里有工作区边界校验与报错语义）。
  if (!target) return null;
  const flags = (Array.isArray(args) ? args : []).map((item) => String(item).trim().toLowerCase());
  // --force = 覆盖已存在文件。必须走原生，否则 CLI 建的文档没有预置样式集，
  // 模型随后 set --prop style=Normal 会报 "Style 'Normal' not found"
  // （实测 L3：pipeline 先建了同名产物，模型再 create --force 就回退到了 CLI）。
  const force = flags.includes("--force") || flags.includes("-f");
  // 已存在文件语义归 officecli（原生只负责新建空文件），除非显式 --force。
  if (!force && fs.existsSync(target)) return null;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (spec.format === "docx") {
    // N-04：默认预置标准样式集；--no-styles 显式退出（保留"空文档"语义）。
    const noStyles = flags.includes("--no-styles");
    const sceneArg = flags.find((item) => item.startsWith("--scene="));
    await createNativeDocx(target, {
      noStyles,
      scene: sceneArg ? String(sceneArg).slice("--scene=".length) : "report",
    });
  } else if (spec.format === "xlsx") await createNativeXlsx(target);
  else await createNativePptx(target);
  return nativeCreateResult(args.map(String), spec.file, spec.format);
}

// ---------------------------------------------------------------------------
// 统一路由入口：runNativeOfficeCommand
// ---------------------------------------------------------------------------

/**
 * 尝试用原生引擎执行一条 officecli 形状的命令（P1-A/P1-B/P2-C）。
 *
 * @returns {Promise<null|object>} null = 原生不支持（或总开关关闭），调用方回退 officecli；
 *          否则返回与 runOfficecli 同形结果（engine:"native"）。
 */
export async function runNativeOfficeCommand(args, { cwd = process.cwd() } = {}) {
  if (!isNativeOfficeEnabled()) return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  const command = String(list[0] || "").trim().toLowerCase();
  const file = String(list[1] || "").trim();
  // 文件参数是工作区相对路径：一律先解析到 cwd 内，避免误读进程工作目录。
  const target = file ? resolveInWorkspace(file, cwd) : null;
  try {
    // ---- create（docx/xlsx/pptx）----
    if (command === "create") {
      return await createNativeOffice(list, { cwd });
    }

    // ---- view text|outline|stats ----
    if (command === "view" && target) {
      const mode = String(list[2] || "").trim().toLowerCase();
      if (!NATIVE_VIEW_MODES.has(mode)) return null;
      if (!fs.existsSync(target)) return null; // 让 CLI 报标准错误语义
      let result = null;
      if (DOCX_EXT.test(target)) {
        const zip = await JSZip.loadAsync(await fs.promises.readFile(target));
        const xml = await zip.file("word/document.xml")?.async("string");
        if (!xml) return null;
        if (mode === "text") result = { text: docxViewText(xml), json: null };
        else if (mode === "outline") result = { text: docxViewOutline(xml), json: null };
        else result = docxViewStats(xml);
      } else if (PPTX_EXT.test(target)) {
        if (mode === "text") result = { text: await pptxViewText(target), json: null };
        else if (mode === "outline") result = { text: await pptxViewOutline(target), json: null };
        else result = await pptxViewStats(target);
      } else if (XLSX_EXT.test(target)) {
        if (mode === "text") result = { text: await xlsxViewText(target), json: null };
        else if (mode === "outline") result = { text: await xlsxViewOutline(target), json: null };
        else result = await xlsxViewStats(target);
      } else {
        return null;
      }
      return nativeResult(list, result);
    }

    // ---- set / --find --replace（docx 全文替换）----
    if (command === "set" && target) {
      const gate = needsCli(command, list);
      if (gate.needsCli) return null;
      const findIndex = list.indexOf("--find");
      const replaceIndex = list.indexOf("--replace");
      const findText = findIndex >= 0 ? String(list[findIndex + 1] ?? "") : "";
      const replaceText = replaceIndex >= 0 ? String(list[replaceIndex + 1] ?? "") : "";
      const pathLink = String(list[2] || "").trim();
      const props = simplePropMap(list);
      if (/^\/body\/p\[\d+\]$/.test(pathLink) && (props.text !== undefined || props.style !== undefined)) {
        if (!DOCX_EXT.test(target) || !fs.existsSync(target)) return null;
        return await docxEditParagraph(target, pathLink, props);
      }
      if (!findText) return null;
      if (!DOCX_EXT.test(target)) return null; // xlsx/pptx 替换仍走 CLI
      if (!fs.existsSync(target)) return null;
      return await docxReplaceText(target, findText, replaceText);
    }
    if (command === "add" && target) {
      const gate = needsCli(command, list);
      if (gate.needsCli) return null;
      const typeIndex = list.indexOf("--type");
      const type = typeIndex >= 0 ? String(list[typeIndex + 1] || "").toLowerCase() : "";
      const pathLink = String(list[2] || "").trim();
      const props = simplePropMap(list);
      if (type === "paragraph" && /^\/body(?:\/p\[\d+\])?$/.test(pathLink) && props.text !== undefined) {
        if (!DOCX_EXT.test(target) || !fs.existsSync(target)) return null;
        return await docxAddParagraph(target, pathLink, props);
      }
      return null;
    }
    return null;
  } catch (error) {
    // 原生路径任何异常都交回 CLI 兜底（§5.5 降级策略），不向上抛错；
    // OAW_DOC_ENGINE_DEBUG=1 时输出原因，便于排查"为什么这条走了 CLI"。
    if (String(process.env.OAW_DOC_ENGINE_DEBUG || "") === "1") {
      console.warn(`[文档引擎] 原生执行失败（${command} ${file}）：${error?.stack || error}`);
    }
    return null;
  }
}
