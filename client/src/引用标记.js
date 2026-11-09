/**
 * 客户端引用标记解析器（2026-11-08 D3，ADR-0029）。
 *
 * 单一事实源：本文件与服务端 `server/context.mjs` 的 `parseReferences` 使用同一组
 * fixture 做 parity（`scripts/引用标记契约测试.mjs`）。两处规则必须同步修改，
 * 不允许各自演进（ADR-0029 §7）；本文件只做纯函数解析，不含浏览器 API，Node 测试可直接 import。
 *
 * 标记语法（与服务端一致）：
 *   @文件[…] / #文件[…]          → file
 *   @知识库[…] / @知识库目录[…]    → knowledge / knowledge_dir
 *   @模板[…] / @模板目录[…]        → template / template_dir
 *   @技能[…] / #技能[…]           → skill（@ 为兼容别名）
 *   #插件[…]                      → plugin
 *   &会话[…]                      → session
 *   裸 @ 路径（含 / \ 或已知扩展名）→ file
 *
 * `@智能体[…]` 是前端提及标记（角色指令注入），服务端不作为 reference 解析，
 * 因此 parity 解析器不产出 agent；展示/删除用 `parseAgentMentions`。
 */

/** 引用类型全集（ADR-0029 §4）。 */
export const REFERENCE_KINDS = Object.freeze([
  "file", "knowledge", "knowledge_dir", "template", "template_dir",
  "skill", "plugin", "session", "agent", "canvas",
]);

/** 类型展示元数据：标签 / 图标（Icon.jsx 已注册名）/ 符号。 */
export const REFERENCE_KIND_META = Object.freeze({
  file: { label: "文件", icon: "file", symbol: "@" },
  knowledge: { label: "知识库", icon: "book", symbol: "@" },
  knowledge_dir: { label: "知识库目录", icon: "folder", symbol: "@" },
  template: { label: "模板", icon: "package", symbol: "@" },
  template_dir: { label: "模板目录", icon: "folder", symbol: "@" },
  skill: { label: "技能", icon: "sparkles", symbol: "#" },
  plugin: { label: "插件", icon: "plug", symbol: "#" },
  session: { label: "会话", icon: "history", symbol: "&" },
  agent: { label: "智能体", icon: "robot", symbol: "@" },
  canvas: { label: "画布", icon: "grid", symbol: "@" },
});

/** 默认标记写法：插入输入框的文本（kind → marker）。 */
const MARKER_BUILDERS = Object.freeze({
  file: (target) => `@文件[${target}]`,
  knowledge: (target) => `@知识库[${target}]`,
  knowledge_dir: (target) => `@知识库目录[${target}]`,
  template: (target) => `@模板[${target}]`,
  template_dir: (target) => `@模板目录[${target}]`,
  skill: (target) => `#技能[${target}]`,
  plugin: (target) => `#插件[${target}]`,
  session: (target) => `&会话[${target}]`,
  agent: (target) => `@智能体[${target}]`,
  canvas: (target) => `@画布[${target}]`,
});

/** 构造某一类型的默认标记文本；未知类型返回空串（不猜）。 */
export function referenceMarker(kind, target) {
  const value = String(target || "").trim();
  const build = MARKER_BUILDERS[kind];
  if (!build || !value) return "";
  return build(value);
}

/** 稳定 id：与 ChatPanel 既有 referenceId 同一算法，保证输入栏/气泡 chip 可对齐。 */
export function referenceId(kind, target) {
  let hash = 0;
  for (const ch of `${kind}:${target}`) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return `ref_${Math.abs(hash).toString(36)}`;
}

/**
 * 文件类型标记的定位后缀归一（与服务端 makeRef 对齐）：
 *   `a.xlsx#Sheet1!A1`   → target=a.xlsx, range={sheet,cell}
 *   `a.docx#page=3`      → target=a.docx, range={page:3}
 */
function normalizeFileRef(kind, target, extra = {}) {
  let cleanTarget = String(target || "").trim();
  const cell = kind === "file" ? cleanTarget.match(/^(.*?)#([^!]+)!([A-Z]+\d+(?::[A-Z]+\d+)?)$/i) : null;
  const locator = kind === "file" ? cleanTarget.match(/^(.*?)#(page|p|slide|paragraph)=(\d+)(?:-(\d+))?$/i) : null;
  // 画布引用：`...board.json#element=el-title` → range.element（单元素）；无后缀表示整板。
  const element = kind === "canvas" ? cleanTarget.match(/^(.*?)#element=([A-Za-z0-9_-]{1,64})$/) : null;
  const range = cell
    ? { ...(extra.range || {}), sheet: cell[2], cell: cell[3] }
    : locator
      ? { ...(extra.range || {}), [locator[2].toLowerCase() === "p" ? "page" : locator[2].toLowerCase()]: Number(locator[3]), ...(locator[4] ? { end: Number(locator[4]) } : {}) }
      : element
        ? { ...(extra.range || {}), element: element[2] }
        : extra.range;
  if (cell) cleanTarget = cell[1];
  if (locator) cleanTarget = locator[1];
  if (element) cleanTarget = element[1];
  const ref = { kind, target: cleanTarget, ...extra };
  if (range) ref.range = range;
  return ref;
}

function dedupeKey(ref) {
  return JSON.stringify({ kind: ref.kind, target: ref.target, range: ref.range || null });
}

const STRUCTURED_MARKERS = [
  ["knowledge_dir", /@知识库目录\[([^\]]+)\]/g],
  ["knowledge", /@知识库\[([^\]]+)\]/g],
  ["template_dir", /@模板目录\[([^\]]+)\]/g],
  ["template", /@模板\[([^\]]+)\]/g],
  ["file", /@文件\[([^\]]+)\]/g],
  ["skill", /[@#]技能\[([^\]]+)\]/g],
  ["plugin", /#插件\[([^\]]+)\]/g],
  ["file", /#文件\[([^\]]+)\]/g],
  ["session", /&会话\[([^\]]+)\]/g],
  ["canvas", /@画布\[([^\]]+)\]/g],
];

/** 已知结构化标记的类型名（用于裸 @ 排除与 lint）。 */
const KNOWN_MARKER_TYPES = ["知识库目录", "模板目录", "知识库", "模板", "文件", "技能", "插件", "会话", "智能体", "画布"];

/**
 * 解析引用标记（与服务端 parseReferences parity）。
 * @param {string} text
 * @param {{cadAgent?: boolean, withSpans?: boolean}} [options]
 * @returns {Array<{id:string, kind:string, target:string, source:string, range?:object, start?:number, end?:number}>}
 */
export function parseReferenceMarkers(text = "", options = {}) {
  const cadAgent = options.cadAgent === true;
  const withSpans = options.withSpans !== false;
  const source = String(text || "");
  const out = [];
  const seen = new Set();
  const add = (ref, span) => {
    if (!ref?.target) return;
    const key = dedupeKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    const item = { ...ref, id: referenceId(ref.kind, ref.target) };
    if (withSpans && span) {
      item.start = span.start;
      item.end = span.end;
    }
    out.push(item);
  };
  for (const [kind, pattern] of STRUCTURED_MARKERS) {
    for (const match of source.matchAll(pattern)) {
      const marker = match[0];
      const start = match.index ?? 0;
      add(normalizeFileRef(kind, match[1], { source: marker }), { start, end: start + marker.length });
    }
  }
  // 裸 @ 文件：含路径分隔符或已知扩展名（与服务端一致；CAD 开启时才多认 dxf/dwg）。
  const ext = new RegExp(`\\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm${cadAgent ? "|dxf|dwg" : ""})$`, "i");
  for (const match of source.matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = match[2].replace(/[),;。！？]+$/, "");
    if (new RegExp(`^(?:${KNOWN_MARKER_TYPES.join("|")})\\[`).test(target)) continue;
    if (target.includes("/") || target.includes("\\") || ext.test(target)) {
      const marker = `@${target}`;
      const markerStart = (match.index ?? 0) + (match[1] || "").length;
      add({ kind: "file", target, source: marker }, { start: markerStart, end: markerStart + marker.length });
    }
  }
  return out;
}

/**
 * 前端展示用：解析 `@智能体[名称]` 提及（`@@` 为转义，与提及逻辑一致）。
 * 只用于 chip 展示与删除同步，不进入发送的 references。
 */
export function parseAgentMentions(text = "") {
  const out = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(/(^|[^@])@智能体\[([^\]]+)\]/g)) {
    const name = String(match[2] || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const marker = `@智能体[${name}]`;
    const start = (match.index ?? 0) + (match[1] || "").length;
    out.push({ id: referenceId("agent", name), kind: "agent", target: name, source: marker, start, end: start + marker.length });
  }
  return out;
}

const STRUCTURED_SOURCE_RE = /^[@#&](知识库目录|模板目录|知识库|模板|文件|技能|插件|会话|智能体|画布)\[/;

/**
 * 去掉文本中的结构化标记（气泡展示用：chip 替代原文）。
 * 裸 @ 文件路径保留（它是正文的一部分，且没有边界可安全剥离）。
 */
export function stripReferenceMarkers(text = "") {
  const source = String(text || "");
  const ranges = [
    ...parseReferenceMarkers(source, { withSpans: true }).filter((ref) => STRUCTURED_SOURCE_RE.test(String(ref.source || ""))),
    ...parseAgentMentions(source),
  ]
    .filter((ref) => typeof ref.start === "number" && ref.source && source.slice(ref.start, ref.end) === ref.source)
    .sort((a, b) => b.start - a.start);
  let out = source;
  for (const ref of ranges) out = out.slice(0, ref.start) + out.slice(ref.end);
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。；：！？、])/g, "$1")
    .trim();
}

/** 某条引用可能的标记文本候选（删除 chip 时同步删文本用）。 */
export function referenceMarkerCandidates(ref = {}) {
  const kind = ref.kind || "file";
  const target = String(ref.target || "").trim();
  const candidates = [];
  if (ref.source) candidates.push(ref.source);
  if (ref.range?.cell && ref.range?.sheet) {
    candidates.push(`@文件[${target}#${ref.range.sheet}!${ref.range.cell}]`, `#文件[${target}#${ref.range.sheet}!${ref.range.cell}]`);
  }
  if (ref.range?.page) {
    candidates.push(`@文件[${target}#page=${ref.range.page}]`, `#文件[${target}#page=${ref.range.page}]`);
  }
  if (kind === "file") candidates.push(`@文件[${target}]`, `#文件[${target}]`, `@${target}`);
  else if (kind === "skill") candidates.push(`#技能[${target}]`, `@技能[${target}]`);
  else if (kind === "plugin") candidates.push(`#插件[${target}]`);
  else if (kind === "session") candidates.push(`&会话[${target}]`);
  else if (kind === "agent") candidates.push(`@智能体[${target}]`);
  else if (kind === "knowledge") candidates.push(`@知识库[${target}]`);
  else if (kind === "knowledge_dir") candidates.push(`@知识库目录[${target}]`);
  else if (kind === "template") candidates.push(`@模板[${target}]`);
  else if (kind === "template_dir") candidates.push(`@模板目录[${target}]`);
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * 删除 chip 时同步删除 textarea 里的标记文本（双向同步：至少删 chip → 删文本）。
 * 返回新文本；找不到标记时原样返回。
 */
export function removeReferenceMarker(text = "", ref = {}) {
  const source = String(text || "");
  for (const marker of referenceMarkerCandidates(ref)) {
    const index = source.indexOf(marker);
    if (index < 0) continue;
    const joined = source.slice(0, index) + source.slice(index + marker.length);
    return joined.replace(/[ \t]{2,}/g, " ").trim();
  }
  return source;
}

/**
 * 发送前兜底：找出无法识别的标记（空目标 / 未知类型 / 未闭合）。
 * 服务端会静默忽略这些标记，这里必须明示，不静默降级为普通文字。
 * @returns {{ok:boolean, issues:Array<{marker:string, reason:string, message:string}>}}
 */
export function lintReferenceMarkers(text = "") {
  const source = String(text || "");
  const issues = [];
  const push = (marker, reason, message) => {
    if (!issues.some((item) => item.marker === marker && item.reason === reason)) issues.push({ marker, reason, message });
  };
  const known = new Set(KNOWN_MARKER_TYPES);
  for (const match of source.matchAll(/([@#&])([\u4e00-\u9fa5A-Za-z]{1,12})\[([^\]]*)\]/g)) {
    const [marker, symbol, type, target] = match;
    if (!known.has(type)) {
      push(marker, "unknown-type", `未知引用类型「${symbol}${type}」`);
      continue;
    }
    if (!String(target || "").trim()) push(marker, "empty-target", `引用「${type}」没有目标`);
  }
  // 未闭合：`@文件[abc` 这类残缺标记不会被上面的正则匹配到，单独扫描一次。
  const opener = /([@#&])(知识库目录|模板目录|知识库|模板|文件|技能|插件|会话|智能体|画布)\[/g;
  for (const match of source.matchAll(opener)) {
    const start = match.index ?? 0;
    const close = source.indexOf("]", start);
    if (close < 0) push(match[0], "unclosed", `引用「${match[2]}」缺少右括号`);
  }
  return { ok: issues.length === 0, issues };
}

/** 三态映射：已解析 / 待解析 / 缺失（服务端 status → chip 状态）。 */
export function referenceStatusTone(ref = {}) {
  const status = String(ref.status || "").toLowerCase();
  if (status === "missing" || status === "unsupported" || status === "error") return "missing";
  if (status === "resolved" || status === "ok") return "resolved";
  return "pending";
}

/** chip 展示标签：文件显示文件名，其余显示目标名。 */
export function referenceChipLabel(ref = {}) {
  const metadata = ref.metadata || {};
  if (ref.kind === "file") {
    if (metadata.name) return metadata.name;
    if (metadata.relativePath) return metadata.relativePath;
    return String(ref.target || "").split(/[\\/]/).filter(Boolean).pop() || String(ref.target || "");
  }
  if (ref.kind === "canvas") {
    if (metadata.name) return ref.range?.element ? `${metadata.name} · ${ref.range.element}` : metadata.name;
    const target = String(ref.target || "");
    const base = target.split(/[\\/]/).filter(Boolean).pop() || target;
    const label = /^canvas\.json$/i.test(base) ? "整画布" : base.replace(/\.board\.json$/i, "");
    return ref.range?.element ? `${label} · ${ref.range.element}` : label;
  }
  return String(metadata.name || metadata.relativePath || ref.target || "");
}
