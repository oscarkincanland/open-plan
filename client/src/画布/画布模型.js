/**
 * 创作画布前端模型（纯函数，无 React / 无 DOM / 无网络 / 无文件系统）。
 *
 * 唯一职责：把「canvas.json 索引 + 板级 JSON」变成可判定、可测试的纯数据变换，
 * 让界面层只负责画与收事件，撤销/脏比较/CAS 前置校验都能在 node 里直接回归。
 *
 * 约定（与计划 §3 一致，冲突时以计划为准）：
 *   - canvas.json 的 `boards` 键是相对 `project/` 的路径，值至少含 x/y/w/h；
 *   - `order` 是层级顺序，必须覆盖全部 boards；deck 模式按 order + role=slide 出片；
 *   - 板类型由扩展名/`kind` 推断：`.board.json` → 对象板（可编辑），
 *     `.dc.html`/`.html` → 兼容板（只读、整页导出），`.svg` → 只读矢量板；
 *   - 元素类型白名单：text / rect / line / image / svg；单板 ≤ 500 元素，文本 ≤ 20000 字；
 *   - 颜色/字体族等样式值是**数据**，这里只做注入防护与数值钳制，不写任何色值常量
 *     （界面色值必须走设计令牌，硬编码色值由 scripts/界面一致性守护测试.mjs 守护）。
 */

/* ───────────────────────────── 常量 ───────────────────────────── */

export const 画布限制 = Object.freeze({
  最大板数: 200,
  最大元素数: 500,
  最长文本: 20000,
  最小尺寸: 40,
  最大尺寸: 8000,
  撤销步数: 50,
  保存去抖毫秒: 400,
});

/** 允许的元素类型（V1）。 */
const 元素类型 = new Set(["text", "rect", "line", "image", "svg"]);
const 对齐集 = new Set(["left", "center", "right", "justify"]);
const 适配集 = new Set(["cover", "contain", "fill"]);
const 缩放方向集 = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
/** 元素 id 白名单（服务端同规则，前端提前挡掉）。 */
const id规则 = /^[A-Za-z0-9_-]{1,64}$/;

/** 各类型元素的形状兜底尺寸（px）。 */
const 兜底尺寸 = Object.freeze({
  text: { w: 480, h: 72 },
  rect: { w: 240, h: 120 },
  line: { w: 240, h: 0 },
  image: { w: 320, h: 200 },
  svg: { w: 320, h: 200 },
});

/* ───────────────────────────── 基础工具 ───────────────────────────── */

function 数值(值, 最小, 最大, 兜底) {
  const n = Number(值);
  if (!Number.isFinite(n)) return 兜底;
  return Math.min(最大, Math.max(最小, n));
}

function 整数(值, 最小, 最大, 兜底) {
  return Math.round(数值(值, 最小, 最大, 兜底));
}

function 文本(值, 上限) {
  return String(值 ?? "").slice(0, 上限);
}

function 深拷贝(值) {
  if (值 === null || 值 === undefined) return 值;
  return JSON.parse(JSON.stringify(值));
}

/**
 * 稳定序列化：键排序后输出，用于脏比较与撤销栈基线。
 * 直接 JSON.stringify 依赖键顺序，同一对象换一个键序就会被误判为「有改动」。
 */
export function 稳定序列化(值) {
  if (值 === undefined) return "\u0000undefined";
  if (值 === null || typeof 值 !== "object") return JSON.stringify(值);
  if (Array.isArray(值)) return `[${值.map((项) => 稳定序列化(项)).join(",")}]`;
  const 键 = Object.keys(值).filter((k) => 值[k] !== undefined).sort();
  return `{${键.map((k) => `${JSON.stringify(k)}:${稳定序列化(值[k])}`).join(",")}}`;
}

/** 两个板/画布快照是否有差异（脏比较的唯一实现）。 */
export function isDirty(prev, next) {
  return 稳定序列化(prev) !== 稳定序列化(next);
}

/* ───────────────────────────── 标签身份 ───────────────────────────── */

/**
 * 工作区身份键：用于拼标签 id。
 *
 * 同一工作区必须得到同一个键（刷新后标签才能去重恢复），不同工作区必须不同。
 * 保留盘符之外的可读信息（含中文），只做大小写与分隔符归一。
 */
export function workspaceKey(workspace = "") {
  const 归一 = String(workspace ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!归一) return "";
  return 归一
    .toLowerCase()
    .replace(/[:/]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * design 标签 id：`design:<workspaceKey>:<slug>`（计划 §5.6）。
 * 同一画布只允许一个标签，去重就靠这个稳定 id。
 */
export function designTabId({ workspace = "", slug = "" } = {}) {
  const 画布键 = String(slug ?? "").trim();
  return `design:${workspaceKey(workspace)}:${画布键}`;
}

/* ───────────────────────────── 安全/路径 ───────────────────────────── */

/**
 * 素材相对路径归一：只接受 project/ 内的相对路径。
 *
 * 计划 §3.3 的示例 `../assets/map.png` 是相对**板文件所在目录**的，
 * 所以这里按 `板目录` 解析 `..`，但解析结果不允许逃出 project/ 根。
 * 盘符、UNC、协议（http:/javascript:/data: 等）与绝对路径一律拒绝（返回空串）。
 */
export function 素材路径(值, 板路径 = "") {
  const 原始 = String(值 ?? "").trim().replace(/\\/g, "/");
  if (!原始 || 原始.length > 512) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(原始)) return ""; // 协议或 Windows 盘符
  if (原始.startsWith("//") || 原始.startsWith("/")) return ""; // UNC / 绝对路径
  if (/[\u0000-\u001f<>"]/.test(原始)) return "";

  const 段 = [];
  const 板目录 = String(板路径 ?? "").replace(/\\/g, "/").split("/").slice(0, -1);
  for (const 部 of 板目录) if (部 && 部 !== ".") 段.push(部);
  for (const 部 of 原始.split("/")) {
    if (!部 || 部 === ".") continue;
    if (部 === "..") {
      if (!段.length) return ""; // 逃出 project/ 根
      段.pop();
      continue;
    }
    段.push(部);
  }
  return 段.join("/").slice(0, 512);
}

/** 颜色/填充值白名单校验：挡掉 CSS 注入与脚本协议，其余原样保留（值是数据）。 */function 样式色值(值) {
  const 文本值 = String(值 ?? "").trim();
  if (!文本值 || 文本值.length > 96) return "";
  if (/[;{}<>\\]/.test(文本值)) return "";
  if (/url\s*\(|expression\s*\(|javascript:|@import/i.test(文本值)) return "";
  return 文本值;
}

/** 字体族：只做长度与注入防护，具体白名单由服务端在导出时收口。 */
function 字体族(值) {
  const 文本值 = String(值 ?? "").trim();
  if (!文本值 || 文本值.length > 64) return "";
  if (/[;{}<>\\]/.test(文本值)) return "";
  return 文本值;
}

/**
 * 素材/矢量板的受控读取地址。
 *
 * 契约：`GET /api/canvas/:slug/asset?workspace=<绝对路径>&path=<相对 project/ 的路径>`，
 * 服务端负责路径校验与字节返回；前端只拼参数，不做 IO。
 */
export function 素材地址({ slug = "", workspace = "", path = "" } = {}) {
  const 参数 = new URLSearchParams();
  if (workspace) 参数.set("workspace", String(workspace));
  参数.set("path", String(path ?? ""));
  return `/api/canvas/${encodeURIComponent(String(slug))}/asset?${参数.toString()}`;
}

/**
 * SVG markup 清洗（尽力而为，渲染侧再用 `<img>` 承载，双保险）。
 *
 * 说明：这里不是完整 sanitizer——真正的安全边界是「不把 markup 注入文档 DOM」，
 * 只用 `data:image/svg+xml` 的 `<img>` 渲染（脚本不执行）。清洗只减少危险内容外泄。
 */
export function 清洗SVG(markup = "") {
  let 结果 = String(markup ?? "");
  if (!结果) return "";
  结果 = 结果.replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  结果 = 结果.replace(/<\s*(script|foreignObject|iframe|object|embed)[^>]*\/?\s*>/gi, "");
  结果 = 结果.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  结果 = 结果.replace(/(?:xlink:)?href\s*=\s*("|')\s*(?!#|data:image\/)[^"']*\1/gi, "");
  结果 = 结果.replace(/javascript:/gi, "");
  return 结果.slice(0, 4 * 1024 * 1024);
}

/* ───────────────────────────── 元素归一化 ───────────────────────────── */

/** 样式对象归一：数值钳制 + 色值/字体族注入防护；未知键丢弃（不写坏数据）。 */
export function normalizeStyle(style) {
  const 源 = style && typeof style === "object" ? style : {};
  const 结果 = {};
  if (源.fontSize !== undefined) 结果.fontSize = 数值(源.fontSize, 6, 400, 16);
  if (源.fontWeight !== undefined) 结果.fontWeight = 整数(源.fontWeight, 100, 900, 400);
  if (源.lineHeight !== undefined) 结果.lineHeight = 数值(源.lineHeight, 0.6, 4, 1.3);
  if (源.opacity !== undefined) 结果.opacity = 数值(源.opacity, 0, 1, 1);
  if (源.radius !== undefined) 结果.radius = 数值(源.radius, 0, 400, 0);
  if (源.strokeWidth !== undefined) 结果.strokeWidth = 数值(源.strokeWidth, 0, 64, 0);
  const 字体 = 字体族(源.fontFamily);
  if (字体) 结果.fontFamily = 字体;
  if (对齐集.has(源.textAlign)) 结果.textAlign = 源.textAlign;
  const 文字色 = 样式色值(源.color);
  if (文字色) 结果.color = 文字色;
  const 填充 = 样式色值(源.fill);
  if (填充) 结果.fill = 填充;
  const 描边 = 样式色值(源.stroke);
  if (描边) 结果.stroke = 描边;
  return 结果;
}

/**
 * 单个元素归一化；类型不认识返回 null（调用方过滤）。
 *
 * @param {object} raw 原始元素
 * @param {number} 序号 位置（用于生成缺省 id）
 * @param {string} 板路径 板相对路径（解析 image/svg 的 src）
 */
export function normalizeElement(raw, 序号 = 0, 板路径 = "") {
  if (!raw || typeof raw !== "object") return null;
  const 类型值 = String(raw.type ?? "");
  if (!元素类型.has(类型值)) return null;

  const 兜底 = 兜底尺寸[类型值];
  const id候选 = String(raw.id ?? "").trim();
  const 元素 = {
    id: id规则.test(id候选) ? id候选 : `el-${类型值}-${序号 + 1}`,
    type: 类型值,
    x: Math.round(数值(raw.x, -1000000, 1000000, 0)),
    y: Math.round(数值(raw.y, -1000000, 1000000, 0)),
    w: Math.round(数值(raw.w, 0, 100000, 兜底.w)),
    h: Math.round(数值(raw.h, 0, 100000, 兜底.h)),
  };

  if (类型值 === "line") {
    元素.x1 = Math.round(数值(raw.x1, -1000000, 1000000, 元素.x));
    元素.y1 = Math.round(数值(raw.y1, -1000000, 1000000, 元素.y));
    元素.x2 = Math.round(数值(raw.x2, -1000000, 1000000, 元素.x + 元素.w));
    元素.y2 = Math.round(数值(raw.y2, -1000000, 1000000, 元素.y + 元素.h));
    const 线样式 = normalizeStyle(raw.style);
    if (!线样式.stroke) 线样式.stroke = "";
    元素.style = 线样式;
    return 元素;
  }

  if (类型值 === "text") {
    元素.text = 文本(raw.text, 画布限制.最长文本);
    元素.style = normalizeStyle(raw.style);
    return 元素;
  }

  if (类型值 === "rect") {
    元素.style = normalizeStyle(raw.style);
    return 元素;
  }

  // image / svg
  元素.src = 素材路径(raw.src, 板路径);
  if (类型值 === "image") {
    元素.fit = 适配集.has(raw.fit) ? raw.fit : "cover";
    return 元素;
  }
  if (raw.markup) 元素.markup = 清洗SVG(raw.markup);
  if (!元素.src && !元素.markup) 元素.markup = 元素.markup || "";
  return 元素;
}

/* ───────────────────────────── 板/画布归一化 ───────────────────────────── */

/** 单板归一化（对象板 `.board.json` 的形状）。 */
export function normalizeBoard(board, 板路径 = "") {
  const 源 = board && typeof board === "object" ? board : {};
  const 原始元素 = Array.isArray(源.elements) ? 源.elements.slice(0, 画布限制.最大元素数) : [];
  const 已用id = new Set();
  const 元素 = [];
  for (const [序号, 项] of 原始元素.entries()) {
    const 归一 = normalizeElement(项, 序号, 板路径);
    if (!归一) continue;
    // id 去重：重复时补后缀而不是丢弃元素，避免用户看到的东西凭空消失。
    if (已用id.has(归一.id)) {
      let 后缀 = 2;
      while (已用id.has(`${归一.id}-${后缀}`)) 后缀 += 1;
      归一.id = `${归一.id}-${后缀}`.slice(0, 64);
    }
    已用id.add(归一.id);
    元素.push(归一);
  }
  return {
    v: 整数(源.v, 0, 99, 1),
    w: 整数(源.w, 画布限制.最小尺寸, 画布限制.最大尺寸, 1280),
    h: 整数(源.h, 画布限制.最小尺寸, 画布限制.最大尺寸, 720),
    background: 样式色值(源.background),
    rev: 整数(源.rev, 0, 1e9, 0),
    elements: 元素,
  };
}

/** 板类型：`object`（可编辑对象板）/ `html`（兼容板）/ `svg`（只读矢量板）。 */
export function 板类型(布局 = {}, 路径 = "") {
  const kind值 = String(布局?.kind ?? "").toLowerCase();
  if (kind值 === "html") return "html";
  if (kind值 === "svg") return "svg";
  if (kind值 === "object") return "object";
  const 路径值 = String(路径 || 布局?.path || "").toLowerCase();
  if (路径值.endsWith(".dc.html") || 路径值.endsWith(".html") || 路径值.endsWith(".htm")) return "html";
  if (路径值.endsWith(".svg")) return "svg";
  return "object";
}

/** 板默认标题：去掉目录与扩展名，兼容板保留可读名。 */
export function 默认板标题(路径 = "") {
  const 名 = String(路径 || "").split("/").pop() || "画板";
  return 名.replace(/\.dc\.html$/i, "").replace(/\.board\.json$/i, "").replace(/\.(html?|svg|json)$/i, "") || "画板";
}

/** canvas.json 索引归一化（v3 兼容超集）。 */
export function normalizeCanvas(canvas) {
  const 源 = canvas && typeof canvas === "object" ? canvas : {};
  const 板 = {};
  const 原始板 = 源.boards && typeof 源.boards === "object" && !Array.isArray(源.boards) ? 源.boards : {};
  const 板项 = Object.entries(原始板).slice(0, 画布限制.最大板数);
  for (const [路径, 布局] of 板项) {
    const 值 = 布局 && typeof 布局 === "object" ? 布局 : {};
    const 键 = 文本(路径, 512);
    if (!键) continue;
    板[键] = {
      x: Math.round(数值(值.x, -1000000, 1000000, 0)),
      y: Math.round(数值(值.y, -1000000, 1000000, 0)),
      w: Math.round(数值(值.w, 画布限制.最小尺寸, 画布限制.最大尺寸, 1280)),
      h: Math.round(数值(值.h, 画布限制.最小尺寸, 画布限制.最大尺寸, 720)),
      title: 文本(值.title || 默认板标题(键), 120),
      role: 值.role === "slide" ? "slide" : "board",
      page: 文本(值.page, 32),
      kind: 文本(值.kind, 16),
    };
  }
  const 顺序 = [];
  if (Array.isArray(源.order)) {
    for (const 路径 of 源.order) {
      const 键 = 文本(路径, 512);
      if (键 && Object.prototype.hasOwnProperty.call(板, 键) && !顺序.includes(键)) 顺序.push(键);
    }
  }
  // order 必须覆盖全部 boards：缺失的按 boards 键序补在后面（否则 deck 会漏页）。
  for (const 键 of Object.keys(板)) if (!顺序.includes(键)) 顺序.push(键);

  const 页 = Array.isArray(源.pages)
    ? 源.pages.slice(0, 40).map((项, 序号) => ({
        id: 文本(项?.id || `p${序号 + 1}`, 32),
        name: 文本(项?.name || `第 ${序号 + 1} 页`, 64),
      }))
    : [];

  return {
    v: 整数(源.v, 0, 99, 3),
    format: 文本(源.format, 32),
    title: 文本(源.title || "未命名画布", 120),
    kind: 源.kind === "deck" ? "deck" : "board",
    rev: 整数(源.rev, 0, 1e9, 0),
    pages: 页,
    boards: 板,
    order: 顺序,
    notes: 源.notes && typeof 源.notes === "object" ? 源.notes : {},
    readOnly: Boolean(源.readOnly),
    readOnlyReason: 文本(源.readOnlyReason, 200),
  };
}

/** 按 order 展开的板条目：`{ path, x, y, w, h, title, role, kind, type }`。 */
export function 板条目(canvas) {
  const 归一 = normalizeCanvas(canvas);
  return 归一.order.map((路径) => {
    const 布局 = 归一.boards[路径];
    return { path: 路径, ...布局, type: 板类型(布局, 路径) };
  });
}

/** deck 出片序列：`kind=deck` 时按 order 取 role=slide，否则回退为全部板。 */
export function deck序列(canvas) {
  const 条目 = 板条目(canvas);
  if (normalizeCanvas(canvas).kind !== "deck") return 条目;
  const 幻灯片 = 条目.filter((项) => 项.role === "slide");
  return 幻灯片.length ? 幻灯片 : 条目;
}

/* ───────────────────────────── 元素操作 ───────────────────────────── */

function 复制板(board) {
  const 归一 = normalizeBoard(board);
  return { ...归一, elements: 归一.elements.map((项) => ({ ...项, style: 项.style ? { ...项.style } : undefined })) };
}

function 新id(board, 前缀) {
  const 已用 = new Set((board?.elements || []).map((项) => 项.id));
  let 序号 = 已用.size + 1;
  let id = `el-${前缀}-${序号}`;
  while (已用.has(id)) {
    序号 += 1;
    id = `el-${前缀}-${序号}`;
  }
  return id;
}

/** 追加任意元素（通用入口；加文本请用 addTextElement）。 */
export function addElement(board, element) {
  const 板 = 复制板(board);
  if (板.elements.length >= 画布限制.最大元素数) return 板;
  const id候选 = String(element?.id ?? "");
  const 候选 = id规则.test(id候选) && !板.elements.some((项) => 项.id === id候选) ? id候选 : 新id(板, String(element?.type || "el"));
  const 归一 = normalizeElement({ ...element, id: 候选 }, 板.elements.length, "");
  if (!归一) return 板;
  板.elements = [...板.elements, 归一];
  return 板;
}

/** 新增文本元素（新建文本板的最低粒度操作）。 */
export function addTextElement(board, options = {}) {
  const x = 数值(options.x, -1000000, 1000000, 40);
  const y = 数值(options.y, -1000000, 1000000, 40);
  return addElement(board, {
    id: options.id,
    type: "text",
    x,
    y,
    w: 数值(options.w, 8, 100000, 480),
    h: 数值(options.h, 8, 100000, 72),
    text: 文本(options.text ?? "双击编辑文本", 画布限制.最长文本),
    style: { fontSize: 32, fontWeight: 400, lineHeight: 1.3, textAlign: "left", ...(options.style || {}) },
  });
}

/** 平移元素（dx/dy 为画布单位位移）。 */
export function moveElement(board, id, dx = 0, dy = 0) {
  const 板 = 复制板(board);
  const 位移x = 数值(dx, -100000, 100000, 0);
  const 位移y = 数值(dy, -100000, 100000, 0);
  板.elements = 板.elements.map((项) => {
    if (项.id !== id) return 项;
    const 新项 = { ...项, x: Math.round(项.x + 位移x), y: Math.round(项.y + 位移y) };
    if (项.type === "line") {
      const 起x = 项.x1 ?? 项.x;
      const 起y = 项.y1 ?? 项.y;
      新项.x1 = Math.round(起x + 位移x);
      新项.y1 = Math.round(起y + 位移y);
      新项.x2 = Math.round((项.x2 ?? 项.x + 项.w) + 位移x);
      新项.y2 = Math.round((项.y2 ?? 项.y + 项.h) + 位移y);
    }
    return 新项;
  });
  return 板;
}

/** 直接设置元素矩形（八向缩放的结果回写；位移计算由 调整矩形 负责）。 */
export function resizeElement(board, id, rect = {}) {
  const 板 = 复制板(board);
  const 宽 = Math.max(1, 数值(rect.w, 1, 100000, 8));
  const 高 = Math.max(0, 数值(rect.h, 0, 100000, 8));
  板.elements = 板.elements.map((项) => {
    if (项.id !== id) return 项;
    return {
      ...项,
      x: Math.round(数值(rect.x, -1000000, 1000000, 项.x)),
      y: Math.round(数值(rect.y, -1000000, 1000000, 项.y)),
      w: Math.round(宽),
      h: Math.round(高),
    };
  });
  return 板;
}

/** 局部更新元素（style 深合并一层，其余字段浅合并）。 */
export function updateElement(board, id, patch = {}) {
  const 板 = 复制板(board);
  const 补丁 = patch && typeof patch === "object" ? patch : {};
  板.elements = 板.elements.map((项) => {
    if (项.id !== id) return 项;
    const 新项 = { ...项, ...补丁 };
    if (补丁.style) 新项.style = { ...(项.style || {}), ...补丁.style };
    if (typeof 新项.text === "string") 新项.text = 新项.text.slice(0, 画布限制.最长文本);
    return 新项;
  });
  return 板;
}

/** 改名（标题/文案）不属于元素内容编辑，单独收敛文本写入。 */
export function setElementText(board, id, text) {
  return updateElement(board, id, { text: 文本(text, 画布限制.最长文本) });
}

/** 删除元素。 */
export function deleteElement(board, id) {
  const 板 = 复制板(board);
  板.elements = 板.elements.filter((项) => 项.id !== id);
  return 板;
}

/** 命中测试：从最上层（数组末尾）往下找，返回元素 id；空串表示没命中。 */
export function 命中元素(board, 点 = {}) {
  const 元素 = Array.isArray(board?.elements) ? board.elements : [];
  const 点x = Number(点.x);
  const 点y = Number(点.y);
  if (!Number.isFinite(点x) || !Number.isFinite(点y)) return "";
  for (let i = 元素.length - 1; i >= 0; i -= 1) {
    const 项 = 元素[i];
    const x = Number(项.x) || 0;
    const y = Number(项.y) || 0;
    const w = Math.max(Number(项.w) || 0, 0);
    const h = Math.max(Number(项.h) || 0, 0);
    if (点x >= x && 点x <= x + w && 点y >= y && 点y <= y + h) return 项.id;
  }
  return "";
}

/**
 * 八向缩放矩形计算（纯几何）。
 *
 * 返回新的 `{x, y, w, h}`；`最小` 约束宽高下限，避免拖成 0 宽导致后续除零。
 */
export function 调整矩形(起点 = {}, 方向 = "se", dx = 0, dy = 0, 最小 = 8) {
  const 向 = 缩放方向集.has(String(方向)) ? String(方向) : "se";
  let x = 数值(起点.x, -1000000, 1000000, 0);
  let y = 数值(起点.y, -1000000, 1000000, 0);
  let w = Math.max(1, 数值(起点.w, 1, 100000, 8));
  let h = Math.max(0, 数值(起点.h, 0, 100000, 8));
  const 位移x = 数值(dx, -100000, 100000, 0);
  const 位移y = 数值(dy, -100000, 100000, 0);
  const 下限 = Math.max(1, Number(最小) || 1);

  if (向.includes("e")) w = Math.max(下限, w + 位移x);
  if (向.includes("s")) h = Math.max(下限, h + 位移y);
  if (向.includes("w")) {
    const 新宽 = Math.max(下限, w - 位移x);
    x += w - 新宽;
    w = 新宽;
  }
  if (向.includes("n")) {
    const 新高 = Math.max(下限, h - 位移y);
    y += h - 新高;
    h = 新高;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/* ───────────────────────────── 画布布局操作 ───────────────────────────── */

/** 重排 order（deck 拖拽排序写回；只改顺序，不改板文件）。 */
export function 重排板(canvas, 起点 = "", 终点 = "") {
  const 归一 = normalizeCanvas(canvas);
  const 顺序 = [...归一.order];
  const 起 = 顺序.indexOf(String(起点));
  const 止 = 顺序.indexOf(String(终点));
  if (起 < 0 || 止 < 0 || 起 === 止) return 归一;
  const [移] = 顺序.splice(起, 1);
  顺序.splice(止, 0, 移);
  return { ...归一, order: 顺序 };
}

/** 更新单个板的画布坐标/标题/角色（兼容板也允许移动缩放，只写 canvas.json）。 */
export function 更新板布局(canvas, 路径 = "", patch = {}) {
  const 归一 = normalizeCanvas(canvas);
  const 键 = String(路径);
  if (!Object.prototype.hasOwnProperty.call(归一.boards, 键)) return 归一;
  const 旧 = 归一.boards[键];
  const 补丁 = patch && typeof patch === "object" ? patch : {};
  const 新板 = {
    ...旧,
    x: Math.round(数值(补丁.x, -1000000, 1000000, 旧.x)),
    y: Math.round(数值(补丁.y, -1000000, 1000000, 旧.y)),
    w: Math.round(数值(补丁.w, 画布限制.最小尺寸, 画布限制.最大尺寸, 旧.w)),
    h: Math.round(数值(补丁.h, 画布限制.最小尺寸, 画布限制.最大尺寸, 旧.h)),
    title: 补丁.title === undefined ? 旧.title : 文本(补丁.title, 120),
    role: 补丁.role === undefined ? 旧.role : (补丁.role === "slide" ? "slide" : "board"),
  };
  return { ...归一, boards: { ...归一.boards, [键]: 新板 } };
}

/* ───────────────────────────── 视口 ───────────────────────────── */

/**
 * 适配窗口：把全部板放进视口，返回 `{ scale, tx, ty }`（缺失/非法输入返回 null）。
 * 板上坐标 → 屏幕坐标的换算是 `屏幕 = 世界 * scale + t`。
 */
export function boardsFitViewport(boards = [], viewport = {}, 边距 = 32) {
  const 列表 = Array.isArray(boards) ? boards : [];
  const 宽 = Number(viewport?.w);
  const 高 = Number(viewport?.h);
  if (!列表.length || !(宽 > 0) || !(高 > 0)) return null;

  let 左 = Infinity;
  let 上 = Infinity;
  let 右 = -Infinity;
  let 下 = -Infinity;
  for (const 项 of 列表) {
    const x = Number(项?.x) || 0;
    const y = Number(项?.y) || 0;
    const w = Math.max(Number(项?.w) || 0, 1);
    const h = Math.max(Number(项?.h) || 0, 1);
    左 = Math.min(左, x);
    上 = Math.min(上, y);
    右 = Math.max(右, x + w);
    下 = Math.max(下, y + h);
  }
  const 内容宽 = Math.max(右 - 左, 1);
  const 内容高 = Math.max(下 - 上, 1);
  const 边 = Math.max(8, Number(边距) || 32);
  const 缩放 = 数值(Math.min((宽 - 边 * 2) / 内容宽, (高 - 边 * 2) / 内容高), 0.05, 4, 1);
  return {
    scale: 缩放,
    tx: (宽 - 内容宽 * 缩放) / 2 - 左 * 缩放,
    ty: (高 - 内容高 * 缩放) / 2 - 上 * 缩放,
  };
}

/** 视口裁剪：只返回与视口相交（含余量）的板，用于「仅渲染视口内板」。 */
export function 视野内板(boards = [], view = {}, viewport = {}, 余量 = 160) {
  const 列表 = Array.isArray(boards) ? boards : [];
  const 宽 = Number(viewport?.w);
  const 高 = Number(viewport?.h);
  const 缩放 = Number(view?.scale) > 0 ? Number(view.scale) : 1;
  const tx = Number(view?.tx) || 0;
  const ty = Number(view?.ty) || 0;
  if (!(宽 > 0) || !(高 > 0)) return 列表.slice();
  const 余 = Math.max(0, Number(余量) || 0);
  return 列表.filter((项) => {
    const x = (Number(项?.x) || 0) * 缩放 + tx;
    const y = (Number(项?.y) || 0) * 缩放 + ty;
    const w = Math.max((Number(项?.w) || 0) * 缩放, 1);
    const h = Math.max((Number(项?.h) || 0) * 缩放, 1);
    return x + w >= -余 && y + h >= -余 && x <= 宽 + 余 && y <= 高 + 余;
  });
}

/* ───────────────────────────── 撤销栈 ───────────────────────────── */

/** 新撤销栈：栈里存已提交的板快照，指针指向当前状态。 */
export function createHistory(board, 上限 = 画布限制.撤销步数) {
  return { 栈: [深拷贝(normalizeBoard(board))], 指针: 0, 上限: Math.max(2, Number(上限) || 画布限制.撤销步数) };
}

/** 提交一步（合并粒度由调用方决定：拖拽结束、文本失焦各算一步）。 */
export function snapshot(history, board) {
  const 旧 = history && Array.isArray(history.栈) && history.栈.length
    ? history
    : createHistory(board);
  const 副本 = 深拷贝(normalizeBoard(board));
  // 与当前状态相同则不产生新步，避免一次操作压两层。
  if (稳定序列化(旧.栈[旧.指针]) === 稳定序列化(副本)) return 旧;
  let 栈 = 旧.栈.slice(0, 旧.指针 + 1);
  栈.push(副本);
  let 指针 = 栈.length - 1;
  while (栈.length > 旧.上限) {
    栈 = 栈.slice(1);
    指针 -= 1;
  }
  return { 栈, 指针: Math.max(0, 指针), 上限: 旧.上限 };
}

/**
 * 撤销/重做：`delta = -1` 撤销，`+1` 重做。
 * 返回 `{ board, history, moved }`，`moved=false` 表示已到栈底/栈顶。
 */
export function restore(history, delta = -1) {
  const 旧 = history && Array.isArray(history.栈) && history.栈.length
    ? history
    : createHistory({});
  const 目标 = 旧.指针 + (Number(delta) < 0 ? -1 : 1);
  if (目标 < 0 || 目标 >= 旧.栈.length) {
    return { board: 深拷贝(旧.栈[旧.指针]), history: 旧, moved: false };
  }
  return { board: 深拷贝(旧.栈[目标]), history: { ...旧, 指针: 目标 }, moved: true };
}

export function canUndo(history) {
  return Boolean(history && Array.isArray(history.栈) && history.指针 > 0);
}

export function canRedo(history) {
  return Boolean(history && Array.isArray(history.栈) && history.指针 < history.栈.length - 1);
}

/* ───────────────────────────── 导出计划 ───────────────────────────── */

const 内置浏览器尺寸上限 = Object.freeze({ w: 2400, h: 1600 });

/**
 * 导出计划：界面导出对话框与测试共用同一份判定。
 *
 * 只描述「能不能导、会变成什么」，不做 IO；真正的 PNG/PDF/PPTX 由服务端执行。
 */
export function exportPlanForCanvas(canvas) {
  const 归一 = normalizeCanvas(canvas);
  const 板 = 板条目(归一).map((项, 序号) => {
    const 类型 = 项.type;
    const 图片页 = 类型 !== "object";
    return {
      path: 项.path,
      order: 序号 + 1,
      title: 项.title,
      role: 项.role,
      w: 项.w,
      h: 项.h,
      type: 类型,
      editable: !图片页,
      imageOnly: 图片页,
      reason: 类型 === "html" ? "兼容板（.dc.html）只读，导出为整页图片" : 类型 === "svg" ? "只读矢量板，导出为整页图片" : "",
    };
  });
  const 总数 = 板.length;
  const 含图片页 = 板.some((项) => 项.imageOnly);
  const 同尺寸 = 总数 > 0 && 板.every((项) => 项.w === 板[0].w && 项.h === 板[0].h);
  const 超限 = 板.some((项) => 项.w > 内置浏览器尺寸上限.w || 项.h > 内置浏览器尺寸上限.h);
  const 空 = 总数 === 0;

  return {
    title: 归一.title,
    kind: 归一.kind,
    total: 总数,
    boards: 板,
    sameSize: 同尺寸,
    hasImagePage: 含图片页,
    overBrowserLimit: 超限,
    formats: {
      svg: {
        enabled: !空 && !含图片页,
        reason: 空 ? "画布没有可导出的板" : 含图片页 ? "兼容板/矢量板不支持 SVG 导出，请改用 PNG、PDF 或 PPTX" : "按对象板序列化为 SVG（文本保留为 text）",
      },
      png: {
        enabled: !空,
        reason: 空 ? "画布没有可导出的板" : 超限 ? "尺寸超过内置浏览器上限，导出时自动等比缩放到 2400×1600 以内" : "按板 CSS 像素截图",
      },
      pdf: {
        enabled: !空 && 同尺寸,
        reason: 空 ? "画布没有可导出的板" : 同尺寸 ? "按板尺寸逐板分页" : "板尺寸不一致，PDF 要求同尺寸，请逐板导出 PNG",
      },
      pptx: {
        enabled: !空,
        reason: 空 ? "画布没有可导出的板" : 含图片页 ? "兼容板作为整页图片进入 PPTX（文字不可编辑）" : "对象板文本映射为可编辑文本框",
      },
    },
    note: 含图片页 ? "含兼容板：兼容板为图片页，文字不可编辑；对象板文本可在 PowerPoint 中直接修改。" : "",
  };
}

/** 导出视图的受控 URL（服务端内置浏览器打开；前端只负责拼参数）。 */
export function 导出视图地址({ slug = "", workspace = "", board = "", scale = 1 } = {}) {
  const 参数 = new URLSearchParams({ export: "canvas" });
  if (slug) 参数.set("slug", String(slug));
  if (workspace) 参数.set("workspace", String(workspace));
  if (board) 参数.set("board", String(board));
  const 缩放 = Number(scale);
  if (Number.isFinite(缩放) && 缩放 > 0) 参数.set("scale", String(缩放));
  // 与地图导出视图同口径：服务端打开同源根路径 + 查询参数（main.jsx 按 export 分派）。
  return `/?${参数.toString()}`;
}
