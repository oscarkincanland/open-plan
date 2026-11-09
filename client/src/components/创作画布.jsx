import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { askConfirm, askText, notifyError, notifySuccess, notifyWarn } from "./Feedback.jsx";
import * as 接口 from "../api.js";
import {
  板条目,
  板类型,
  画布限制,
  exportPlanForCanvas,
  稳定序列化,
  默认板标题,
  addTextElement,
  boardsFitViewport,
  canRedo,
  canUndo,
  createHistory,
  deck序列,
  deleteElement,
  designTabId,
  moveElement,
  normalizeBoard,
  normalizeCanvas,
  resizeElement,
  restore,
  setElementText,
  snapshot,
  updateElement,
  命中元素,
  视野内板,
  更新板布局,
  素材地址,
  调整矩形,
  重排板,
  清洗SVG,
  页分组,
  板所属页,
} from "../画布/画布模型.js";

/**
 * 创作画布（右侧工作区画布的 design 标签内容）。
 *
 * 职责边界：
 *   - 只做「画布视图 + 直接编辑 + 保存/撤销/导出对话框」；画板创建由 Agent 工具
 *     （canvas_write）或服务端模板负责，导出执行在服务端。
 *   - 取数全部走 api.js 的统一出口（见下方 接口别名 表），组件内不拼业务 URL
 *     （只有素材受控地址 /api/canvas/:slug/asset 是渲染必需的约定）。
 *   - 兼容板（.dc.html / .svg）用 sandbox iframe / img 渲染：iframe 只开 allow-same-origin，
 *     不开脚本权限，文档内脚本一律不执行；正文优先取板接口返回的 srcDoc，其次取服务端给的受控地址 rawUrl。
 *
 * 三态与降级：加载 / 失败（可重试）/ 空画布（说明与入口）/ 只读（说明原因）。
 *
 * 保存：本地乐观更新 + 400ms 去抖 + `expectedRev` CAS；冲突保留本地脏状态，
 * 让用户显式选「刷新（丢弃本地）」或「覆盖（用本地覆盖服务端）」。
 */

/* ─────────────────── api.js 函数名兼容层 ─────────────────── */

/**
 * 服务端接口在 api.js 的导出函数名（契约名优先，其余为兼容别名）。
 * api.js 若用了别的名字，只需在这里补别名，组件代码不动。
 */
const 接口别名 = Object.freeze({
  listCanvases: ["listCanvases", "canvasList", "listCreativeCanvases"],
  getCanvas: ["getCanvas", "canvasGet", "readCanvas"],
  getCanvasBoard: ["getCanvasBoard", "canvasBoard", "readCanvasBoard"],
  saveCanvasBoard: ["saveCanvasBoard", "canvasSaveBoard", "putCanvasBoard", "writeCanvasBoard"],
  createCanvasBoard: ["createCanvasBoard", "canvasCreateBoard"],
  duplicateCanvasBoard: ["duplicateCanvasBoard", "canvasDuplicateBoard"],
  deleteCanvasBoard: ["deleteCanvasBoard", "canvasDeleteBoard"],
  updateCanvasPages: ["updateCanvasPages", "canvasUpdatePages", "patchCanvasPages"],
  patchCanvas: ["patchCanvas", "canvasPatch", "updateCanvas"],
  createCanvas: ["createCanvas", "canvasCreate"],
  deleteCanvas: ["deleteCanvas", "canvasDelete"],
  importCanvas: ["importCanvas", "canvasImport"],
  exportCanvas: ["exportCanvas", "canvasExport"],
  getCanvasExport: ["getCanvasExport", "canvasExportStatus", "getCanvasExportStatus"],
  listCanvasHistory: ["listCanvasHistory", "canvasHistory", "listCanvasVersions"],
  restoreCanvasHistory: ["restoreCanvasHistory", "canvasRestore", "restoreCanvasVersion"],
  listCanvasVersions: ["listCanvasVersions", "canvasVersions"],
  getCanvasVersion: ["getCanvasVersion", "canvasVersion"],
  diffCanvasVersions: ["diffCanvasVersions", "canvasVersionDiff"],
  restoreCanvasVersion: ["restoreCanvasVersion", "canvasRestoreVersion"],
  listCanvasOperations: ["listCanvasOperations", "canvasOperations"],
});

function 取接口(名) {
  for (const 候选 of 接口别名[名] || [名]) {
    const 函数 = 接口[候选];
    if (typeof 函数 === "function") return 函数;
  }
  const 错误 = new Error(`前端接口缺失：api.js 未导出 ${名}（创作画布无法取数，请检查 api.js 接线）`);
  错误.code = "CANVAS_API_MISSING";
  throw 错误;
}

function 调用(名, ...参数) {
  return 取接口(名)(...参数);
}

/** 响应字段兼容：服务端可能包一层（`{ canvas }` / `{ board }`），也可能裸返回。 */
function 取字段(应答, 键们 = []) {
  if (!应答 || typeof 应答 !== "object") return 应答;
  for (const 键 of 键们) {
    if (应答[键] !== undefined && 应答[键] !== null) return 应答[键];
  }
  return 应答;
}

function 错误文本(错误, 兜底 = "操作失败") {
  const 消息 = String(错误?.message || "").trim();
  return 消息 || 兜底;
}

/** 冲突判定：api() 会把服务端 code 透传出来，没有 code 时兜底看 409 文案。 */
function 是冲突(错误) {
  const 码 = String(错误?.code || "");
  if (码 === "CANVAS_CONFLICT" || 码 === "REVISION_CONFLICT" || 码 === "CONFLICT" || 码 === "CANVAS_REV_CONFLICT") return true;
  return /409|冲突|revision|expectedRev/i.test(String(错误?.message || ""));
}

function 是只读错误(错误) {
  const 码 = String(错误?.code || "");
  if (/READONLY|READ_ONLY|EACCES|EPERM|LOCKED/.test(码)) return true;
  return /只读|无权限|权限不足|locked|read-only/i.test(String(错误?.message || ""));
}

/* ─────────────────── 常量 ─────────────────── */

const 缩放下限 = 0.05;
const 缩放上限 = 4;
const 八向 = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const 方向标签 = Object.freeze({ nw: "左上", n: "上", ne: "右上", e: "右", se: "右下", s: "下", sw: "左下", w: "左" });
const 导出格式 = Object.freeze([
  { 值: "svg", 名称: "SVG", 说明: "矢量，文本可再编辑" },
  { 值: "png", 名称: "PNG", 说明: "位图，按板尺寸截图" },
  { 值: "pdf", 名称: "PDF", 说明: "逐板分页，要求同尺寸" },
  { 值: "pptx", 名称: "PPTX", 说明: "对象板文本可编辑" },
]);
const 字体候选 = Object.freeze(["Microsoft YaHei", "PingFang SC", "SimSun", "SimHei", "OPPO Sans", "system-ui"]);

function 限制缩放(值) {
  const n = Number(值);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(缩放上限, Math.max(缩放下限, n));
}

/* ─────────────────── 元素渲染 ─────────────────── */

function 元素样式表(元素) {
  const 样式 = 元素.style || {};
  const 基 = { position: "absolute", left: 元素.x, top: 元素.y, width: Math.max(元素.w, 1), height: Math.max(元素.h, 0) };
  if (元素.type === "text") {
    return {
      ...基,
      fontFamily: 样式.fontFamily || "inherit",
      fontSize: 样式.fontSize || 16,
      fontWeight: 样式.fontWeight || 400,
      lineHeight: 样式.lineHeight || 1.3,
      color: 样式.color || "var(--oaw-canvas-ink)",
      textAlign: 样式.textAlign || "left",
      opacity: 样式.opacity ?? 1,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      outline: "none",
    };
  }
  if (元素.type === "rect") {
    return {
      ...基,
      background: 样式.fill || "transparent",
      border: 样式.stroke ? `${样式.strokeWidth || 1}px solid ${样式.stroke}` : "none",
      borderRadius: 样式.radius || 0,
      opacity: 样式.opacity ?? 1,
    };
  }
  return { ...基, opacity: 样式.opacity ?? 1 };
}

/** 只读元素视图：选中/拖动由板纸统一接管（元素本身 pointer-events: none）。 */
function 元素视图({ 元素, 素材前缀 }) {
  const 样式 = 元素样式表(元素);
  if (元素.type === "text") {
    return (
      <div className="oaw-canvas-el oaw-canvas-el-text" style={样式} data-el={元素.id}>
        {元素.text || ""}
      </div>
    );
  }
  if (元素.type === "rect") {
    return <div className="oaw-canvas-el oaw-canvas-el-rect" style={样式} data-el={元素.id} />;
  }
  if (元素.type === "line") {
    const x1 = 元素.x1 ?? 元素.x;
    const y1 = 元素.y1 ?? 元素.y;
    const x2 = 元素.x2 ?? 元素.x + 元素.w;
    const y2 = 元素.y2 ?? 元素.y + 元素.h;
    const 左 = Math.min(x1, x2);
    const 上 = Math.min(y1, y2);
    const 宽 = Math.max(Math.abs(x2 - x1), 1);
    const 高 = Math.max(Math.abs(y2 - y1), 1);
    const 位置 = { ...元素样式表(元素), left: 左, top: 上, width: 宽, height: 高 };
    return (
      <svg className="oaw-canvas-el oaw-canvas-el-line" style={位置} viewBox={`${左} ${上} ${宽} ${高}`} preserveAspectRatio="none" aria-hidden="true">
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={元素.style?.stroke || "var(--border)"}
          strokeWidth={元素.style?.strokeWidth || 1}
        />
      </svg>
    );
  }
  if (元素.type === "image") {
    const 地址 = 元素.src ? `${素材前缀}${encodeURIComponent(元素.src)}` : "";
    if (!地址) return <div className="oaw-canvas-el oaw-canvas-el-empty" style={样式}>图片缺失</div>;
    return (
      <img
        className="oaw-canvas-el oaw-canvas-el-image"
        style={{ ...样式, objectFit: 元素.fit === "contain" || 元素.fit === "fill" ? 元素.fit : "cover" }}
        src={地址}
        alt=""
        draggable={false}
        loading="lazy"
      />
    );
  }
  // svg 块：markup 走 data URL + img 渲染（脚本不执行）；src 走受控本地素材地址
  const 图源 = 元素.markup
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(清洗SVG(元素.markup))}`
    : 元素.src
      ? `${素材前缀}${encodeURIComponent(元素.src)}`
      : "";
  if (!图源) return <div className="oaw-canvas-el oaw-canvas-el-empty" style={样式}>矢量块缺失</div>;
  return (
    <img
      className="oaw-canvas-el oaw-canvas-el-svg"
      style={{ ...样式, objectFit: "contain" }}
      src={图源}
      alt=""
      draggable={false}
      loading="lazy"
    />
  );
}

/* ─────────────────── 行内文本编辑 ─────────────────── */

/**
 * 文本行内编辑框。
 *
 * 只在进入编辑时写一次 textContent（之后由用户输入维护），避免 React 重渲染把光标打回开头；
 * 粘贴统一转纯文本（V1 不做富文本）；Esc 取消、失焦提交。
 */
function 文本编辑框({ 元素, on提交, on取消 }) {
  const ref = useRef(null);
  const 已取消 = useRef(false);

  useEffect(() => {
    const 节点 = ref.current;
    if (!节点) return;
    节点.textContent = 元素.text || "";
    节点.focus();
    const 范围 = document.createRange();
    范围.selectNodeContents(节点);
    const 选区 = window.getSelection();
    选区?.removeAllRanges();
    选区?.addRange(范围);
  }, [元素.id]);

  return (
    <div
      ref={ref}
      className="oaw-canvas-el oaw-canvas-el-text oaw-canvas-el-text-editing"
      style={元素样式表(元素)}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="编辑文本"
      data-el={元素.id}
      onPointerDown={(事件) => 事件.stopPropagation()}
      onDoubleClick={(事件) => 事件.stopPropagation()}
      onPaste={(事件) => {
        事件.preventDefault();
        const 纯文本 = 事件.clipboardData?.getData("text/plain") || "";
        if (纯文本) document.execCommand("insertText", false, 纯文本);
      }}
      onKeyDown={(事件) => {
        if (事件.key === "Escape") {
          事件.preventDefault();
          已取消.current = true;
          on取消();
        }
      }}
      onBlur={() => {
        if (已取消.current) return;
        on提交(ref.current?.textContent ?? "");
      }}
    />
  );
}

/* ─────────────────── 主组件 ─────────────────── */

export default function 创作画布({
  slug = "",
  workspace = "",
  onDirtyChange,
  onTitleChange,
  onClose,
  // 可选：slug 为空（`+` 菜单新建的占位标签）时，成功新建/导入后通知 App 换成真实 slug 标签
  onCreated,
  // 可选：在「最近画布」列表里切换画布（App 可直接复用 openCanvasView）
  onOpenCanvas,
  // 可选：Agent 写入画布后由 App 递增；本组件据此刷新（有脏时只提示，不丢弃本地改动）
  refreshToken = 0,
  // 可选：Agent 正在调用 canvas_* 工具时的活动指示
  agentBusy = false,
  // 可选：把画布引用插入对话输入框（App 传入 insertChatText）
  onAddToChat = null,
}) {
  const 画布键 = String(slug || "").trim();
  const 工作区 = String(workspace || "").trim();

  // ── 取数与数据 ──
  const [加载态, set加载态] = useState("加载中"); // 加载中 | 失败 | 就绪 | 列表
  const [加载错误, set加载错误] = useState("");
  const [画布, set画布] = useState(null);
  const [列表, set列表] = useState([]);
  const [板数据, set板数据] = useState({});
  const [板载入, set板载入] = useState({}); // path -> 加载中 | 就绪 | "失败：原因"
  const [基线, set基线] = useState({ 板: {}, 画布: "" });

  // ── 视图与编辑 ──
  const [视图, set视图] = useState({ scale: 1, tx: 0, ty: 0 });
  const [视口, set视口] = useState({ w: 0, h: 0 });
  const [当前板路径, set当前板路径] = useState("");
  const [选中元素, set选中元素] = useState("");
  const [编辑元素, set编辑元素] = useState("");
  const [空格按下, set空格按下] = useState(false);
  const [网格显示, set网格显示] = useState(true);
  const [历史版本, set历史版本] = useState(0); // 触发撤销按钮可用态刷新

  // ── 保存与冲突 ──
  const [保存中, set保存中] = useState(false);
  const [保存错误, set保存错误] = useState("");
  const [冲突, set冲突] = useState(null); // { 类型: "板"|"画布", 路径?, 消息 }
  const [只读原因, set只读原因] = useState("");
  // Agent 更新画布时，若本地有未保存修改：只提示，不自动刷新（避免丢改动）。
  const [远端更新, set远端更新] = useState(false);

  // ── 导出 ──
  const [导出面板, set导出面板] = useState(false);
  const [导出格式值, set导出格式值] = useState("png");
  const [导出范围, set导出范围] = useState("全部板");
  const [导出进行, set导出进行] = useState(false);
  const [导出结果, set导出结果] = useState("");

  // ── 验收反馈：抓手 / 播放 / 页面主题与间距 / 版本历史 ──
  const [手形工具, set手形工具] = useState(false);
  const [播放中, set播放中] = useState(false);
  const [播放序号, set播放序号] = useState(0);
  const [播放尺寸, set播放尺寸] = useState({ w: 1200, h: 800 });
  const [设置面板, set设置面板] = useState(false);
  const [页面设置, set页面设置] = useState({ 网格: 16, 板距: 160, 安全边距: 0 });
  const [历史面板, set历史面板] = useState(false);
  const [历史列表, set历史列表] = useState([]);
  const [历史载入中, set历史载入中] = useState(false);
  const [历史错误, set历史错误] = useState("");
  const [历史恢复中, set历史恢复中] = useState("");
  const [版本恢复范围, set版本恢复范围] = useState("canvas"); // canvas | board
  const [版本差异, set版本差异] = useState(null);
  const [版本差异中, set版本差异中] = useState("");
  const [刷新时间, set刷新时间] = useState("");
  // 画板/页（2026-11-09-004）：页分组与新建板。
  const [当前页, set当前页] = useState("");
  const [页面面板, set页面面板] = useState(false);
  const [新建板中, set新建板中] = useState(false);

  // ── 无 slug 时的入口表单 ──
  const [新建标题, set新建标题] = useState("");
  const [新建类型, set新建类型] = useState("board");

  // ── refs（供定时器/事件回调读取最新值，避免闭包旧值） ──
  const 外壳引用 = useRef(null);
  const 视口引用 = useRef(null);
  const 板数据引用 = useRef({});
  板数据引用.current = 板数据;
  const 画布引用 = useRef(null);
  画布引用.current = 画布;
  const 视口尺寸引用 = useRef({ w: 0, h: 0 });
  const 视图引用 = useRef({ scale: 1, tx: 0, ty: 0 });
  视图引用.current = 视图;
  const 当前板引用 = useRef("");
  当前板引用.current = 当前板路径;
  const 选中引用 = useRef("");
  选中引用.current = 选中元素;
  const 编辑引用 = useRef("");
  编辑引用.current = 编辑元素;
  const 只读引用 = useRef("");
  只读引用.current = 只读原因;
  const 拖拽引用 = useRef(null);
  const 在途引用 = useRef(new Set());
  const 板定时器 = useRef(new Map());
  const 画布定时器 = useRef(null);
  const 待补画布 = useRef({});
  const 历史引用 = useRef(new Map());
  const 导出轮询 = useRef({ 取消: false });
  const 已适配 = useRef("");
  const 卸载 = useRef(false);

  const 只读 = Boolean(只读原因) || Boolean(画布?.readOnly);
  const agent活动 = agentBusy && typeof agentBusy === "object" ? agentBusy : { active: Boolean(agentBusy) };
  const agent编辑板 = String(agent活动?.boardPath || "");

  /** 素材受控地址前缀：`/api/canvas/:slug/asset?workspace=<abs>&path=`。 */
  const 素材前缀 = useMemo(() => {
    const 参数 = new URLSearchParams();
    if (工作区) 参数.set("workspace", 工作区);
    const 查询 = 参数.toString();
    return `/api/canvas/${encodeURIComponent(画布键)}/asset?${查询 ? `${查询}&` : ""}path=`;
  }, [画布键, 工作区]);

  const 板列表 = useMemo(() => (画布 ? 板条目(画布) : []), [画布]);
  const 幻灯列表 = useMemo(() => (画布 ? deck序列(画布) : []), [画布]);
  const 页列表 = useMemo(() => (画布 ? 页分组(画布) : []), [画布]);
  const 显示板列表 = useMemo(() => {
    if (!画布 || !当前页) return 板列表;
    return 板列表.filter((项) => 板所属页(画布, 项.path) === 当前页);
  }, [画布, 板列表, 当前页]);
  const deck模式 = 画布?.kind === "deck";
  // refreshToken 兼容两种形态：数字（旧）或 { rev, scope, boardPath, changedPaths, slug, at }（新）。
  const 刷新数据 = typeof refreshToken === "object" && refreshToken ? refreshToken : null;
  const 刷新键 = 刷新数据
    ? `${刷新数据.slug || ""}:${Number(刷新数据.rev) || 0}:${(刷新数据.changedPaths || []).join(",")}:${刷新数据.at || ""}`
    : String(refreshToken ?? "");

  /* ── 脏状态（唯一来源：板内容与基线序列化比较） ── */

  const 脏板路径 = useMemo(() => {
    const 结果 = [];
    for (const [路径, 板] of Object.entries(板数据)) {
      const 存过 = 基线.板[路径];
      if (存过 === undefined) continue;
      if (稳定序列化(板) !== 存过) 结果.push(路径);
    }
    return 结果;
  }, [板数据, 基线]);

  const 画布脏 = Boolean(画布 && 基线.画布) && 稳定序列化(画布) !== 基线.画布;
  const 有脏 = 脏板路径.length > 0 || 画布脏;

  useEffect(() => {
    onDirtyChange?.(有脏);
  }, [有脏, onDirtyChange]);

  useEffect(() => {
    onTitleChange?.(画布?.title || "");
  }, [画布?.title, onTitleChange]);

  /* ── 取数 ── */

  const 载入画布列表 = useCallback(async () => {
    set加载态("加载中");
    set加载错误("");
    try {
      const 应答 = await 调用("listCanvases", 工作区);
      const 原始 = 取字段(应答, ["canvases", "list", "items"]) || [];
      set列表(Array.isArray(原始) ? 原始 : []);
      set加载态("列表");
    } catch (错误) {
      set加载错误(错误文本(错误, "读取画布列表失败"));
      set加载态("失败");
    }
  }, [工作区]);

  const 载入画布 = useCallback(async () => {
    if (!画布键) {
      载入画布列表();
      return;
    }
    set加载态("加载中");
    set加载错误("");
    try {
      const 应答 = await 调用("getCanvas", 工作区, 画布键);
      const 归一 = normalizeCanvas(取字段(应答, ["canvas", "data", "index"]));
      set画布(归一);
      set只读原因(归一.readOnly ? (归一.readOnlyReason || "画布为只读（服务端标记）") : "");
      set基线({ 板: {}, 画布: 稳定序列化(归一) });
      set板数据({});
      set板载入({});
      在途引用.current.clear();
      历史引用.current.clear();
      set选中元素("");
      set编辑元素("");
      set当前板路径(归一.order[0] || "");
      set当前页(归一.pages[0]?.id || "");
      set刷新时间(new Date().toLocaleTimeString());
      set加载态("就绪");
      载入画布列表();
    } catch (错误) {
      set加载错误(错误文本(错误, "读取画布失败"));
      set加载态("失败");
    }
  }, [画布键, 工作区, 载入画布列表]);

  useEffect(() => {
    if (卸载.current) return;
    载入画布();
  }, [载入画布]);

  // Agent/其他标签页写入后的增量刷新在 载入板 之后接线（需要按 changedPaths 只拉变化的板）。

  /* ── 板按需取数（仅视口内板 + 当前板） ── */

  const 载入板 = useCallback(
    async (路径, { 强制 = false } = {}) => {
      if (!路径 || !画布键) return;
      if (!强制 && (板载入[路径] === "加载中" || 板载入[路径] === "就绪")) return;
      if (在途引用.current.has(路径)) return;
      在途引用.current.add(路径);
      set板载入((prev) => ({ ...prev, [路径]: "加载中" }));
      try {
        const 应答 = await 调用("getCanvasBoard", 工作区, 画布键, 路径);
        const 内容 = 取字段(应答, ["board", "data"]);
        if (板类型(画布引用.current?.boards?.[路径] || {}, 路径) !== "object") {
          // 兼容板 / 矢量板：没有板 JSON，只有正文或受控地址
          const 载体 = typeof 内容 === "string"
            ? { srcDoc: 内容, rawUrl: "", rev: 0 }
            : {
                srcDoc: String(取字段(内容, ["srcDoc", "content", "html", "text", "body"]) || ""),
                rawUrl: String(取字段(内容, ["rawUrl", "url"]) || ""),
                rev: Number(取字段(内容, ["rev"]) ?? 0) || 0,
              };
          set板数据((prev) => ({ ...prev, [路径]: 载体 }));
          set板载入((prev) => ({ ...prev, [路径]: "就绪" }));
        } else {
          const 归一 = normalizeBoard(内容, 路径);
          set板数据((prev) => ({ ...prev, [路径]: 归一 }));
          set板载入((prev) => ({ ...prev, [路径]: "就绪" }));
          set基线((prev) => ({ ...prev, 板: { ...prev.板, [路径]: 稳定序列化(归一) } }));
          if (!历史引用.current.has(路径)) 历史引用.current.set(路径, createHistory(归一));
        }
      } catch (错误) {
        set板载入((prev) => ({ ...prev, [路径]: `失败：${错误文本(错误, "读取板失败")}` }));
      } finally {
        在途引用.current.delete(路径);
      }
    },
    [板载入, 画布键, 工作区],
  );

  /* ── 增量刷新（Agent / 其他标签页写入） ── */

  const 软刷新画布 = useCallback(async (信息 = {}) => {
    if (!画布键) { 载入画布列表(); return; }
    try {
      const 应答 = await 调用("getCanvas", 工作区, 画布键);
      const 归一 = normalizeCanvas(取字段(应答, ["canvas", "data", "index"]));
      const 现存 = new Set(归一.order);
      set画布(归一);
      set基线((prev) => ({ ...prev, 画布: 稳定序列化(归一) }));
      set板数据((prev) => {
        const 下一 = { ...prev };
        for (const 路径 of Object.keys(下一)) if (!现存.has(路径)) delete 下一[路径];
        return 下一;
      });
      set板载入((prev) => {
        const 下一 = { ...prev };
        for (const 路径 of Object.keys(下一)) if (!现存.has(路径)) delete 下一[路径];
        return 下一;
      });
      set当前板路径((prev) => (现存.has(prev) ? prev : (归一.order[0] || "")));
      set当前页((prev) => (归一.pages.some((项) => 项.id === prev) ? prev : (归一.pages[0]?.id || "")));
      const 变化 = (Array.isArray(信息?.changedPaths) && 信息.changedPaths.length ? 信息.changedPaths : 归一.order)
        .map(String)
        .filter((路径) => 路径.endsWith(".board.json") && 现存.has(路径));
      for (const 路径 of 变化) {
        const 本地rev = Number(板数据引用.current[路径]?.rev) || 0;
        const 事件rev = Number(信息?.revision) || 0;
        // 自己的保存也会回环到全局事件：本地 rev 已追上时跳过，避免清空撤销栈。
        if (信息?.scope === "board" && 信息?.boardPath === 路径 && 本地rev > 0 && 本地rev >= 事件rev) continue;
        在途引用.current.delete(路径);
        历史引用.current.delete(路径);
        await 载入板(路径, { 强制: true });
      }
      set远端更新(false);
      set刷新时间(new Date().toLocaleTimeString());
    } catch (错误) {
      set保存错误(`刷新画布失败：${错误文本(错误)}`);
    }
  }, [画布键, 工作区, 载入板, 载入画布列表]);

  const 手动刷新 = useCallback(() => {
    set远端更新(false);
    软刷新画布({ changedPaths: [] });
    载入画布列表();
  }, [软刷新画布, 载入画布列表]);

  const 上次刷新令牌 = useRef(刷新键);
  useEffect(() => {
    if (刷新键 === 上次刷新令牌.current) return;
    上次刷新令牌.current = 刷新键;
    if (卸载.current) return;
    if (!画布键) {
      载入画布列表();
      return;
    }
    if (刷新数据?.slug && 刷新数据.slug !== 画布键) return;
    if (有脏) {
      set远端更新(true);
      return;
    }
    软刷新画布(刷新数据 || {});
    载入画布列表();
  }, [刷新键, 画布键, 有脏, 刷新数据, 软刷新画布, 载入画布列表]);

  /* ── 视口尺寸与适配 ── */

  useEffect(() => {
    const 节点 = 视口引用.current;
    if (!节点) return undefined;
    const 更新 = () => {
      const 矩形 = 节点.getBoundingClientRect();
      const 尺寸 = { w: Math.max(1, Math.round(矩形.width)), h: Math.max(1, Math.round(矩形.height)) };
      视口尺寸引用.current = 尺寸;
      set视口(尺寸);
    };
    更新();
    if (typeof ResizeObserver !== "function") return undefined;
    const 观察 = new ResizeObserver(更新);
    观察.observe(节点);
    return () => 观察.disconnect();
  }, [加载态]);

  const 适配窗口 = useCallback(() => {
    const 结果 = boardsFitViewport(板列表, 视口尺寸引用.current, 36);
    if (结果) set视图(结果);
  }, [板列表]);

  // 首次拿到板清单（或切画布）时自动适配一次；之后用户缩放/平移不被窗口变化打断
  useEffect(() => {
    const 键 = `${画布键}:${板列表.length}`;
    if (!板列表.length || !视口.w || 已适配.current === 键) return;
    已适配.current = 键;
    适配窗口();
  }, [板列表.length, 视口.w, 适配窗口, 画布键]);

  const 可见板 = useMemo(() => 视野内板(板列表, 视图, 视口, 200), [板列表, 视图, 视口]);

  useEffect(() => {
    for (const 项 of 可见板) 载入板(项.path);
    if (当前板路径) 载入板(当前板路径);
  }, [可见板, 当前板路径, 载入板]);

  /* ── 缩放 ── */

  const 以点缩放 = useCallback((倍率, 屏幕点) => {
    const 当前 = 视图引用.current;
    const 缩放 = 限制缩放(当前.scale * 倍率);
    const 比例 = 缩放 / (当前.scale || 1);
    const 锚点 = 屏幕点 || { x: 视口尺寸引用.current.w / 2, y: 视口尺寸引用.current.h / 2 };
    set视图({
      scale: 缩放,
      tx: 锚点.x - (锚点.x - 当前.tx) * 比例,
      ty: 锚点.y - (锚点.y - 当前.ty) * 比例,
    });
  }, []);

  // wheel 必须非 passive 才能 preventDefault（React 合成 wheel 监听是 passive）
  useEffect(() => {
    const 节点 = 视口引用.current;
    if (!节点) return undefined;
    const 处理 = (事件) => {
      事件.preventDefault();
      const 矩形 = 节点.getBoundingClientRect();
      以点缩放(事件.deltaY > 0 ? 1 / 1.12 : 1.12, { x: 事件.clientX - 矩形.left, y: 事件.clientY - 矩形.top });
    };
    节点.addEventListener("wheel", 处理, { passive: false });
    return () => 节点.removeEventListener("wheel", 处理);
  }, [以点缩放, 加载态]);

  /* ── 保存（去抖 400ms + CAS） ── */

  const 保存板 = useCallback(
    async (路径) => {
      const 当前板 = 板数据引用.current[路径];
      if (!当前板 || !画布键 || 只读引用.current) return;
      const 发送板 = normalizeBoard(当前板, 路径);
      set保存中(true);
      set保存错误("");
      try {
        const 应答 = await 调用("saveCanvasBoard", 工作区, 画布键, 路径, 发送板, 发送板.rev);
        const 回写 = 取字段(应答, ["board"]);
        const 原始rev = Number(取字段(回写 || 应答, ["rev"]));
        const 已存 = { ...发送板, rev: Number.isFinite(原始rev) ? 原始rev : 发送板.rev + 1 };
        set板数据((prev) => (prev[路径] ? { ...prev, [路径]: { ...prev[路径], rev: 已存.rev } } : prev));
        set基线((prev) => ({ ...prev, 板: { ...prev.板, [路径]: 稳定序列化(已存) } }));
        set冲突((prev) => (prev?.路径 === 路径 ? null : prev));
      } catch (错误) {
        if (是冲突(错误)) {
          set冲突({ 类型: "板", 路径, 消息: 错误文本(错误, "画布已被其他操作修改") });
        } else if (是只读错误(错误)) {
          set只读原因(`保存被拒绝：${错误文本(错误, "无写入权限")}`);
        } else {
          set保存错误(`「${默认板标题(路径)}」保存失败：${错误文本(错误)}`);
        }
      } finally {
        set保存中(false);
      }
    },
    [画布键, 工作区],
  );

  const 调度板保存 = useCallback(
    (路径) => {
      if (!画布键 || !路径 || 只读引用.current) return;
      const 旧定时 = 板定时器.current.get(路径);
      if (旧定时) clearTimeout(旧定时);
      const 定时 = setTimeout(() => {
        板定时器.current.delete(路径);
        保存板(路径);
      }, 画布限制.保存去抖毫秒);
      板定时器.current.set(路径, 定时);
    },
    [画布键, 保存板],
  );

  const 提交画布补丁 = useCallback(
    async (补丁) => {
      if (!画布键 || !补丁 || 只读引用.current) return;
      set保存中(true);
      set保存错误("");
      try {
        const 发送补丁 = { ...补丁 };
        if (发送补丁.expectedRev === undefined && 画布引用.current?.rev !== undefined) {
          发送补丁.expectedRev = Number(画布引用.current.rev) || 0;
        }
        const 应答 = await 调用("patchCanvas", 工作区, 画布键, 发送补丁);
        const 回写 = 取字段(应答, ["canvas"]);
        const 合并 = 回写 && typeof 回写 === "object" && 回写 !== 应答
          ? normalizeCanvas({ ...画布引用.current, ...回写 })
          : normalizeCanvas(画布引用.current);
        set画布(合并);
        set基线((prev) => ({ ...prev, 画布: 稳定序列化(合并) }));
        set冲突((prev) => (prev?.类型 === "画布" ? null : prev));
      } catch (错误) {
        if (是冲突(错误)) set冲突({ 类型: "画布", 消息: 错误文本(错误, "画布索引已被其他操作修改") });
        else if (是只读错误(错误)) set只读原因(`保存被拒绝：${错误文本(错误, "无写入权限")}`);
        else set保存错误(`画布索引保存失败：${错误文本(错误)}`);
      } finally {
        set保存中(false);
      }
    },
    [画布键, 工作区],
  );

  const 调度画布补丁 = useCallback(
    (补丁) => {
      if (!画布键 || 只读引用.current) return;
      待补画布.current = { ...待补画布.current, ...补丁 };
      if (画布定时器.current) clearTimeout(画布定时器.current);
      画布定时器.current = setTimeout(() => {
        const 发送 = 待补画布.current;
        待补画布.current = {};
        画布定时器.current = null;
        提交画布补丁(发送);
      }, 画布限制.保存去抖毫秒);
    },
    [画布键, 提交画布补丁],
  );

  // 卸载时清掉未触发的定时器与轮询，避免对已关闭标签继续写盘/请求
  useEffect(
    () => () => {
      卸载.current = true;
      for (const 定时 of 板定时器.current.values()) clearTimeout(定时);
      板定时器.current.clear();
      if (画布定时器.current) clearTimeout(画布定时器.current);
      导出轮询.current.取消 = true;
    },
    [],
  );

  /* ── 板编辑原语 ── */

  const 应用板变更 = useCallback(
    (路径, 变换, { 立即保存 = true } = {}) => {
      if (只读引用.current) return;
      set板数据((prev) => {
        const 当前 = prev[路径];
        if (!当前 || typeof 当前 !== "object" || !Array.isArray(当前.elements)) return prev;
        const 下一个 = 变换(当前);
        if (!下一个 || 下一个 === 当前) return prev;
        return { ...prev, [路径]: 下一个 };
      });
      if (立即保存) 调度板保存(路径);
    },
    [调度板保存],
  );

  const 记快照 = useCallback((路径, 板) => {
    const 历史 = 历史引用.current.get(路径) || createHistory(板);
    历史引用.current.set(路径, snapshot(历史, 板));
    set历史版本((值) => 值 + 1);
  }, []);

  const 当前板快照 = useCallback(() => {
    const 路径 = 当前板引用.current;
    const 板 = 路径 ? 板数据引用.current[路径] : null;
    if (路径 && 板) 记快照(路径, 板);
  }, [记快照]);

  const 撤销或重做 = useCallback(
    (方向) => {
      const 路径 = 当前板引用.current || 当前板路径;
      if (!路径 || 只读引用.current) return;
      const 板 = 板数据引用.current[路径];
      if (!板 || !Array.isArray(板.elements)) return;
      const 历史 = 历史引用.current.get(路径) || createHistory(板);
      const 结果 = restore(历史, 方向);
      if (!结果.moved) return;
      历史引用.current.set(路径, 结果.history);
      set板数据((prev) => ({ ...prev, [路径]: 结果.board }));
      set选中元素((prev) => (结果.board.elements.some((项) => 项.id === prev) ? prev : ""));
      set历史版本((值) => 值 + 1);
      调度板保存(路径);
    },
    [当前板路径, 调度板保存],
  );

  const 删除选中 = useCallback(() => {
    const 路径 = 当前板引用.current;
    const id = 选中引用.current;
    if (!路径 || !id || 只读引用.current) return;
    const 板 = 板数据引用.current[路径];
    if (!板 || !Array.isArray(板.elements)) return;
    const 下一个 = deleteElement(板, id);
    应用板变更(路径, () => 下一个, { 立即保存: false });
    记快照(路径, 下一个);
    set选中元素("");
    调度板保存(路径);
  }, [应用板变更, 记快照, 调度板保存]);

  const 更新选中元素 = useCallback(
    (补丁, { 存快照 = false } = {}) => {
      const 路径 = 当前板引用.current;
      const id = 选中引用.current;
      if (!路径 || !id || 只读引用.current) return;
      const 板 = 板数据引用.current[路径];
      if (!板 || !Array.isArray(板.elements)) return;
      const 下一个 = updateElement(板, id, 补丁);
      应用板变更(路径, () => 下一个, { 立即保存: false });
      if (存快照) 记快照(路径, 下一个);
      调度板保存(路径);
    },
    [应用板变更, 记快照, 调度板保存],
  );

  const 添加文本 = useCallback(() => {
    const 路径 = 当前板引用.current || 板列表[0]?.path;
    if (!路径 || 只读引用.current) return;
    const 板 = 板数据引用.current[路径];
    if (!板 || !Array.isArray(板.elements)) {
      notifyWarn("这份画板还没加载完成，稍后再试，或让 Agent 先写入该板");
      return;
    }
    const 下一个 = addTextElement(板, {
      x: Math.round(板.w * 0.1),
      y: Math.round(板.h * 0.4),
      w: Math.round(板.w * 0.5),
      h: 96,
      text: "双击编辑文本",
    });
    const 新元素 = 下一个.elements[下一个.elements.length - 1];
    应用板变更(路径, () => 下一个, { 立即保存: false });
    记快照(路径, 下一个);
    set当前板路径(路径);
    set选中元素(新元素?.id || "");
    调度板保存(路径);
  }, [板列表, 应用板变更, 记快照, 调度板保存]);

  /* ── 画板 / 页（2026-11-09-004） ── */

  const 新建画板 = useCallback(async () => {
    if (!画布键 || 只读引用.current || 新建板中) return;
    const 标题 = await askText("新画板标题", "画板");
    if (标题 === null) return;
    set新建板中(true);
    try {
      const 应答 = await 调用("createCanvasBoard", 工作区, 画布键, {
        title: String(标题 || "").trim() || "画板",
        page: 当前页 || undefined,
      });
      const 新路径 = String(取字段(应答, ["boardPath", "path"]) || "");
      await 软刷新画布({ changedPaths: 新路径 ? [新路径] : [] });
      if (新路径) {
        set当前板路径(新路径);
        set选中元素("");
        set编辑元素("");
      }
      notifySuccess("已新建画板");
    } catch (错误) {
      notifyError(`新建画板失败：${错误文本(错误)}`);
    } finally {
      set新建板中(false);
    }
  }, [画布键, 工作区, 当前页, 新建板中, 软刷新画布]);

  const 复制当前板 = useCallback(async () => {
    const 路径 = 当前板引用.current;
    if (!画布键 || !路径 || 只读引用.current) return;
    try {
      const 应答 = await 调用("duplicateCanvasBoard", 工作区, 画布键, { path: 路径 });
      const 新路径 = String(取字段(应答, ["boardPath", "path"]) || "");
      await 软刷新画布({ changedPaths: 新路径 ? [新路径] : [] });
      if (新路径) set当前板路径(新路径);
      notifySuccess("已复制画板");
    } catch (错误) {
      notifyError(`复制画板失败：${错误文本(错误)}`);
    }
  }, [画布键, 工作区, 软刷新画布]);

  const 删除当前板 = useCallback(async () => {
    const 路径 = 当前板引用.current;
    if (!画布键 || !路径 || 只读引用.current) return;
    const 确认 = await askConfirm(`删除画板「${默认板标题(路径)}」？文件会移入 .trash，可从版本历史恢复。`);
    if (!确认) return;
    try {
      await 调用("deleteCanvasBoard", 工作区, 画布键, 路径, { confirmed: true });
      await 软刷新画布({ changedPaths: [路径] });
      notifySuccess("已删除画板（软删到 .trash）");
    } catch (错误) {
      notifyError(`删除画板失败：${错误文本(错误)}`);
    }
  }, [画布键, 工作区, 软刷新画布]);

  const 更新页列表 = useCallback(async (pages, moveTo = "") => {
    if (!画布键 || 只读引用.current) return false;
    try {
      await 调用("updateCanvasPages", 工作区, 画布键, { pages, moveTo: moveTo || undefined, expectedRev: 画布引用.current?.rev });
      await 软刷新画布({ changedPaths: [] });
      notifySuccess("页面已更新");
      return true;
    } catch (错误) {
      notifyError(`更新页面失败：${错误文本(错误)}`);
      return false;
    }
  }, [画布键, 工作区, 软刷新画布]);

  const 新建页 = useCallback(async () => {
    const 名称 = await askText("新页名称", `第 ${(画布引用.current?.pages?.length || 0) + 1} 页`);
    if (名称 === null) return;
    const 现有 = Array.isArray(画布引用.current?.pages) ? 画布引用.current.pages : [];
    const 已用 = new Set(现有.map((项) => String(项?.id || "")));
    let 序号 = 现有.length + 1;
    let id = `p${序号}`;
    while (已用.has(id)) { 序号 += 1; id = `p${序号}`; }
    await 更新页列表([...现有, { id, name: String(名称 || "").trim() || `第 ${序号} 页` }]);
    set当前页(id);
  }, [更新页列表]);

  const 重命名页 = useCallback(async (页) => {
    const 名称 = await askText("页名称", 页?.name || "");
    if (名称 === null) return;
    const 现有 = Array.isArray(画布引用.current?.pages) ? 画布引用.current.pages : [];
    await 更新页列表(现有.map((项) => (项.id === 页.id ? { ...项, name: String(名称 || "").trim() || 项.name } : 项)));
  }, [更新页列表]);

  const 删除页 = useCallback(async (页) => {
    const 现有 = Array.isArray(画布引用.current?.pages) ? 画布引用.current.pages : [];
    if (现有.length <= 1) { notifyWarn("至少保留一页"); return; }
    const 确认 = await askConfirm(`删除页「${页?.name || 页?.id}」？该页画板会移动到第一页，不会删除。`);
    if (!确认) return;
    const 剩余 = 现有.filter((项) => 项.id !== 页.id);
    await 更新页列表(剩余, 剩余[0]?.id || "");
    set当前页(剩余[0]?.id || "");
  }, [更新页列表]);

  const 切换画布 = useCallback((slug) => {
    const 目标 = String(slug || "");
    if (!目标 || 目标 === 画布键) return;
    if (typeof onOpenCanvas === "function") onOpenCanvas(目标, "");
    else notifyWarn("请从画布标签栏打开目标画布");
  }, [画布键, onOpenCanvas]);

  /* ── 验收反馈补齐：页面主题与间距 / 播放 / 添加到对话 / 版本历史 ── */

  // 页面设置（本机偏好）：网格/板距/安全边距；画板背景（主题）写入画板本身。
  useEffect(() => {
    if (!画布键) return undefined;
    try {
      const 原始 = JSON.parse(window.localStorage.getItem(`oaw_canvas_prefs:${工作区}:${画布键}`) || "null");
      if (原始 && typeof 原始 === "object") set页面设置((旧) => ({ ...旧, ...原始 }));
    } catch { /* 本地偏好损坏时使用默认值 */ }
    return undefined;
  }, [画布键, 工作区]);

  const 更新页面设置 = useCallback((补丁) => {
    set页面设置((旧) => {
      const 下一 = { ...旧, ...补丁 };
      try { window.localStorage.setItem(`oaw_canvas_prefs:${工作区}:${画布键}`, JSON.stringify(下一)); } catch { /* 隐私模式忽略 */ }
      return 下一;
    });
  }, [画布键, 工作区]);

  const 应用画板背景 = useCallback((值) => {
    const 路径 = 当前板引用.current;
    if (!路径 || 只读引用.current) return;
    const 板 = 板数据引用.current[路径];
    if (!板 || !Array.isArray(板.elements)) return;
    const 下一 = { ...板, background: String(值 || "") };
    set板数据((prev) => ({ ...prev, [路径]: 下一 }));
    调度板保存(路径);
  }, [调度板保存]);

  const 背景应用到全部 = useCallback(() => {
    const 路径 = 当前板引用.current;
    const 值 = String(板数据引用.current[路径]?.background || "");
    if (!路径 || 只读引用.current) return;
    let 数量 = 0;
    for (const [板路径, 板] of Object.entries(板数据引用.current)) {
      if (!板 || !Array.isArray(板.elements) || 板.background === 值) continue;
      const 下一 = { ...板, background: 值 };
      set板数据((prev) => ({ ...prev, [板路径]: 下一 }));
      记快照(板路径, 下一);
      调度板保存(板路径);
      数量 += 1;
    }
    if (数量) notifySuccess(`已应用到 ${数量} 块对象板`);
    else notifyWarn("没有可应用的对象板（兼容板只读）");
  }, [记快照, 调度板保存]);

  const 整理画板 = useCallback(() => {
    if (!画布 || 只读引用.current) return;
    const 条目 = 板列表;
    if (!条目.length) return;
    const 间距 = Math.max(20, Number(页面设置.板距) || 160);
    const 每行 = deck模式 ? 1 : 3;
    const 映射 = {};
    let 当前x = 0;
    let 当前y = 0;
    let 行高 = 0;
    条目.forEach((项, 序号) => {
      if (序号 > 0 && 序号 % 每行 === 0) {
        当前x = 0;
        当前y += 行高 + 间距;
        行高 = 0;
      }
      映射[项.path] = { x: Math.round(当前x), y: Math.round(当前y) };
      当前x += Number(项.w || 0) + 间距;
      行高 = Math.max(行高, Number(项.h || 0));
    });
    const 下一 = { ...画布, boards: { ...画布.boards } };
    for (const [路径, 坐标] of Object.entries(映射)) {
      if (下一.boards[路径]) 下一.boards[路径] = { ...下一.boards[路径], ...坐标 };
    }
    set画布(下一);
    提交画布补丁({ boards: 映射 });
    notifySuccess(`已按 ${间距}px 板间距整理 ${条目.length} 块板`);
    适配窗口();
  }, [画布, 板列表, deck模式, 页面设置.板距, 提交画布补丁, 适配窗口]);

  // 播放（deck 放映）：按 order 逐页；Esc 退出，←/→ 或空格翻页。
  const 播放列表 = useMemo(() => (deck模式 ? 幻灯列表 : 板列表), [deck模式, 幻灯列表, 板列表]);
  const 播放项 = 播放中 && 播放列表.length ? 播放列表[Math.min(播放序号, 播放列表.length - 1)] : null;
  const 打开播放 = useCallback(() => {
    if (!播放列表.length) { notifyWarn("画布还没有画板"); return; }
    const 索引 = 播放列表.findIndex((项) => 项.path === 当前板引用.current);
    set播放序号(索引 >= 0 ? 索引 : 0);
    set播放尺寸({ w: window.innerWidth, h: window.innerHeight });
    set播放中(true);
  }, [播放列表]);
  const 关闭播放 = useCallback(() => set播放中(false), []);
  const 播放步进 = useCallback((方向) => {
    set播放序号((旧) => Math.max(0, Math.min(播放列表.length - 1, 旧 + 方向)));
  }, [播放列表.length]);

  useEffect(() => {
    if (!播放中) return undefined;
    const 更新尺寸 = () => set播放尺寸({ w: window.innerWidth, h: window.innerHeight });
    const 按键 = (事件) => {
      if (事件.key === "Escape") { 事件.preventDefault(); 关闭播放(); return; }
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(事件.key)) { 事件.preventDefault(); 播放步进(1); return; }
      if (["ArrowLeft", "PageUp"].includes(事件.key)) { 事件.preventDefault(); 播放步进(-1); }
    };
    更新尺寸();
    window.addEventListener("resize", 更新尺寸);
    window.addEventListener("keydown", 按键);
    return () => {
      window.removeEventListener("resize", 更新尺寸);
      window.removeEventListener("keydown", 按键);
    };
  }, [播放中, 关闭播放, 播放步进]);

  useEffect(() => {
    const 路径 = 播放项?.path;
    if (播放中 && 路径) 载入板(路径);
  }, [播放中, 播放项?.path, 载入板]);

  // 添加到对话：优先当前选中元素，其次当前画板，最后退回整画布索引。
  const 添加到对话 = useCallback(() => {
    if (!画布键) return;
    const 引用 = 当前板路径
      ? `@画布[designs/${画布键}/project/${当前板路径}${选中元素 ? `#element=${选中元素}` : ""}]`
      : `@designs/${画布键}/project/canvas.json`;
    if (typeof onAddToChat === "function") {
      onAddToChat(引用);
      notifySuccess(选中元素 ? "选中元素已加入对话" : 当前板路径 ? "当前画板已加入对话" : "画布引用已加入对话输入框");
      return;
    }
    notifyWarn(`请在对话中手动引用 ${引用}`);
  }, [画布键, 当前板路径, 选中元素, onAddToChat]);

  // 版本历史：画布级时间线（.history/index.json + objects/），支持整画布或当前板恢复。
  const 载入历史 = useCallback(async () => {
    if (!画布键) { set历史列表([]); return; }
    set历史载入中(true);
    set历史错误("");
    try {
      const 应答 = await 调用("listCanvasVersions", 工作区, 画布键, { limit: 100 });
      const 原始 = 取字段(应答, ["items", "history", "versions"]) || [];
      set历史列表(Array.isArray(原始) ? 原始 : []);
    } catch (错误) {
      set历史列表([]);
      set历史错误(错误文本(错误, "读取版本历史失败（服务端可能未启用该功能）"));
    } finally {
      set历史载入中(false);
    }
  }, [画布键, 工作区]);

  const 打开历史 = useCallback(() => {
    set历史面板(true);
    set版本差异(null);
    载入历史();
  }, [载入历史]);

  useEffect(() => {
    if (历史面板) 载入历史();
  }, [历史面板, 画布键, 载入历史]);

  const 查看版本差异 = useCallback(async (项) => {
    if (!画布键 || !项?.n) return;
    set版本差异中(`diff-${项.n}`);
    try {
      const 应答 = await 调用("diffCanvasVersions", 工作区, 画布键, 项.n, "");
      set版本差异({ ...取字段(应答, ["diff"]), n: 项.n });
    } catch (错误) {
      notifyError(`读取差异失败：${错误文本(错误)}`);
    } finally {
      set版本差异中("");
    }
  }, [画布键, 工作区]);

  const 恢复历史 = useCallback(async (项) => {
    if (!画布键 || !项?.n || 只读引用.current) return;
    const 仅当前板 = 版本恢复范围 === "board" && Boolean(当前板路径);
    const 范围 = 仅当前板 ? `当前板「${默认板标题(当前板路径)}」` : "整张画布";
    const 确认 = await askConfirm(`恢复到版本 #${项.n}（${项.at ? new Date(项.at).toLocaleString() : "未知时间"}）的${范围}？当前内容会先被留存为新版本。`);
    if (!确认) return;
    set历史恢复中(`v-${项.n}`);
    set历史错误("");
    try {
      await 调用("restoreCanvasVersion", 工作区, 画布键, 项.n, 仅当前板 ? [当前板路径] : null);
      await 软刷新画布({ changedPaths: 仅当前板 ? [当前板路径] : [] });
      await 载入历史();
      notifySuccess("已恢复该版本");
    } catch (错误) {
      set历史错误(错误文本(错误, "恢复失败"));
    } finally {
      set历史恢复中("");
    }
  }, [画布键, 当前板路径, 版本恢复范围, 工作区, 软刷新画布, 载入历史]);

  /* ── 冲突处理 ── */

  const 冲突刷新 = useCallback(async () => {
    const 当 = 冲突;
    if (!当) return;
    set冲突(null);
    if (当.类型 === "板" && 当.路径) {
      在途引用.current.delete(当.路径);
      // 刷新后本地撤销栈已失效（服务端内容成了新基线），重建历史
      历史引用.current.delete(当.路径);
      set板载入((prev) => ({ ...prev, [当.路径]: undefined }));
      await 载入板(当.路径, { 强制: true });
      return;
    }
    await 载入画布();
  }, [冲突, 载入板, 载入画布]);

  const 冲突覆盖 = useCallback(async () => {
    const 当 = 冲突;
    if (!当) return;
    set冲突(null);
    if (当.类型 === "板" && 当.路径) {
      try {
        const 应答 = await 调用("getCanvasBoard", 工作区, 画布键, 当.路径);
        const 远端 = normalizeBoard(取字段(应答, ["board", "data"]), 当.路径);
        const 本地板 = 板数据引用.current[当.路径];
        const 覆盖板 = { ...(本地板 && Array.isArray(本地板.elements) ? 本地板 : 远端), rev: 远端.rev };
        const 回写 = 取字段(await 调用("saveCanvasBoard", 工作区, 画布键, 当.路径, 覆盖板, 远端.rev), ["board"]);
        const 新rev = Number(取字段(回写, ["rev"]));
        const 已存 = { ...覆盖板, rev: Number.isFinite(新rev) ? 新rev : 远端.rev + 1 };
        set板数据((prev) => ({ ...prev, [当.路径]: 已存 }));
        set基线((prev) => ({ ...prev, 板: { ...prev.板, [当.路径]: 稳定序列化(已存) } }));
      } catch (错误) {
        set保存错误(`覆盖失败：${错误文本(错误)}`);
      }
      return;
    }
    try {
      const 应答 = await 调用("getCanvas", 工作区, 画布键);
      const 远端 = normalizeCanvas(取字段(应答, ["canvas"]));
      const 本地 = 画布引用.current;
      const 合并 = 本地 ? { ...本地, rev: 远端.rev } : 远端;
      await 提交画布补丁({ title: 合并.title, boards: 合并.boards, order: 合并.order, expectedRev: 远端.rev });
    } catch (错误) {
      set保存错误(`覆盖失败：${错误文本(错误)}`);
    }
  }, [冲突, 工作区, 画布键, 提交画布补丁]);

  /* ── 画布级操作 ── */

  const 改名 = useCallback(async () => {
    if (!画布 || 只读) return;
    const 新标题 = await askText("画布标题", 画布.title || "");
    if (新标题 === null) return;
    const 标题 = String(新标题).trim().slice(0, 120);
    if (!标题 || 标题 === 画布.title) return;
    set画布({ ...画布引用.current, title: 标题 });
    调度画布补丁({ title: 标题 });
  }, [画布, 只读, 调度画布补丁]);

  const 改板标题 = useCallback(
    async (路径) => {
      if (!画布 || 只读) return;
      const 旧 = 画布.boards[路径]?.title || 默认板标题(路径);
      const 新标题 = await askText("画板标题", 旧);
      if (新标题 === null) return;
      const 标题 = String(新标题).trim().slice(0, 120);
      if (!标题 || 标题 === 旧) return;
      const 下一个 = 更新板布局(画布引用.current, 路径, { title: 标题 });
      set画布(下一个);
      调度画布补丁({ boards: 下一个.boards });
    },
    [画布, 只读, 调度画布补丁],
  );

  const 移动板 = useCallback(
    (路径, dx, dy) => {
      if (!画布 || 只读) return;
      const 布局 = 画布.boards[路径];
      if (!布局) return;
      const 下一个 = 更新板布局(画布引用.current, 路径, { x: 布局.x + dx, y: 布局.y + dy });
      set画布(下一个);
      调度画布补丁({ boards: 下一个.boards });
    },
    [画布, 只读, 调度画布补丁],
  );

  const 缩放板 = useCallback(
    (路径, 宽, 高) => {
      if (!画布 || 只读) return;
      const 下一个 = 更新板布局(画布引用.current, 路径, { w: 宽, h: 高 });
      set画布(下一个);
      调度画布补丁({ boards: 下一个.boards });
    },
    [画布, 只读, 调度画布补丁],
  );

  const 拖拽排序 = useCallback(
    (起点路径, 终点路径) => {
      if (!画布 || 只读) return;
      const 下一个 = 重排板(画布引用.current, 起点路径, 终点路径);
      set画布(下一个);
      调度画布补丁({ order: 下一个.order });
    },
    [画布, 只读, 调度画布补丁],
  );

  const 新建画布 = useCallback(async () => {
    const 标题 = String(新建标题 || "").trim();
    if (!标题) {
      notifyWarn("请先填写画布标题");
      return;
    }
    try {
      const 应答 = await 调用("createCanvas", 工作区, { title: 标题, kind: 新建类型 });
      const 新画布 = 取字段(应答, ["canvas"]);
      const 标识 = String(新画布?.slug || 新画布?.id || "").trim();
      set新建标题("");
      if (标识) {
        // 占位标签（slug 为空）由 App 换成真实标签；已带 slug 的场景不重复开标签
        if (typeof onCreated === "function") onCreated(标识, String(新画布?.title || 标题));
        else if (typeof onOpenCanvas === "function") onOpenCanvas(标识);
        else notifyWarn("画布已创建；若标签未自动打开，请从画布面板的「+」菜单打开它");
      } else {
        notifyWarn("画布已创建；若标签未自动打开，请从画布面板的「+」菜单打开它");
      }
      载入画布列表();
    } catch (错误) {
      notifyError(`新建画布失败：${错误文本(错误)}`);
    }
  }, [新建标题, 新建类型, 工作区, onCreated, onOpenCanvas, 载入画布列表]);

  /** 导入兼容画布：只复制到当前工作区，原目录字节不变（由服务端完成复制）。 */
  const 导入画布 = useCallback(async () => {
    const 来源 = await askText("要导入的兼容画布目录（含 project/canvas.json 的绝对路径）", "");
    if (来源 === null) return;
    const 目录 = String(来源).trim();
    if (!目录) return;
    try {
      const 应答 = await 调用("importCanvas", 工作区, { sourcePath: 目录 });
      const 新画布 = 取字段(应答, ["canvas"]);
      const 标识 = String(新画布?.slug || 新画布?.id || "").trim();
      const 标题 = String(新画布?.title || "").trim();
      if (标识 && typeof onCreated === "function") onCreated(标识, 标题 || 目录);
      else if (标识 && typeof onOpenCanvas === "function") onOpenCanvas(标识);
      else notifySuccess("兼容画布已导入；请从画布面板的「+」菜单打开它");
      载入画布列表();
    } catch (错误) {
      notifyError(`导入画布失败：${错误文本(错误)}`);
    }
  }, [工作区, onCreated, onOpenCanvas, 载入画布列表]);

  /* ── 导出 ── */

  const 导出范围画布 = useMemo(() => {
    if (!画布) return null;
    if (导出范围 === "当前板" && 当前板路径 && 画布.boards[当前板路径]) {
      return { ...画布, boards: { [当前板路径]: 画布.boards[当前板路径] }, order: [当前板路径] };
    }
    return 画布;
  }, [画布, 导出范围, 当前板路径]);

  const 计划 = useMemo(() => (导出范围画布 ? exportPlanForCanvas(导出范围画布) : null), [导出范围画布]);
  const 当前格式 = 计划?.formats?.[导出格式值] || { enabled: false, reason: "" };

  const 执行导出 = useCallback(async () => {
    if (!画布 || !计划 || !当前格式.enabled || 导出进行) return;
    set导出进行(true);
    set导出结果("");
    try {
      const 目标板 = 导出范围 === "当前板" && 当前板路径 ? [当前板路径] : 计划.boards.map((项) => 项.path);
      const 应答 = await 调用("exportCanvas", 工作区, 画布键, {
        format: 导出格式值,
        boards: 目标板,
        outputName: 画布.title,
      });
      const jobId = String(取字段(应答, ["jobId", "id", "exportId"]) || "");
      if (!jobId) {
        set导出结果("导出任务已提交（服务端未返回任务号，无法显示进度）");
        return;
      }
      导出轮询.current.取消 = false;
      const 起始 = Date.now();
      // 服务端串行执行导出，同一画布同一时间只允许一个任务；这里按任务号轮询进度。
      while (!导出轮询.current.取消 && !卸载.current && Date.now() - 起始 < 5 * 60 * 1000) {
        let 状态 = null;
        try {
          状态 = await 调用("getCanvasExport", 工作区, jobId);
        } catch (错误) {
          set导出结果(`查询导出进度失败：${错误文本(错误)}`);
          return;
        }
        const 值 = String(取字段(状态, ["status", "state"]) || "").toLowerCase();
        if (["done", "success", "finished", "completed", "完成", "已完成"].includes(值)) {
          const 文件 = 取字段(状态, ["files", "outputs"]);
          const 名 = Array.isArray(文件) && 文件.length
            ? 文件.map((项) => String(项?.path || 项?.name || "")).filter(Boolean).join("、")
            : "导出文件";
          set导出结果(`导出完成：${名}`);
          return;
        }
        if (["failed", "error", "失败"].includes(值)) {
          set导出结果(`导出失败：${String(取字段(状态, ["error", "message"]) || "未知原因")}`);
          return;
        }
        await new Promise((完成) => setTimeout(完成, 900));
      }
      set导出结果("导出超时：可在产物面板查看是否已生成文件");
    } catch (错误) {
      set导出结果(`导出失败：${错误文本(错误)}`);
    } finally {
      set导出进行(false);
    }
  }, [画布, 计划, 当前格式.enabled, 导出进行, 导出范围, 当前板路径, 工作区, 画布键, 导出格式值]);

  /* ── 关闭（脏确认） ── */

  const 请求关闭 = useCallback(async () => {
    if (有脏) {
      const 确认 = await askConfirm("创作画布有未保存修改，仍要关闭吗？关闭后未保存的编辑会丢失。");
      if (!确认) return;
    }
    onClose?.();
  }, [有脏, onClose]);

  /* ── 指针交互 ── */

  const 视口坐标 = useCallback((事件) => {
    const 矩形 = 视口引用.current?.getBoundingClientRect();
    if (!矩形) return { x: 0, y: 0 };
    return { x: 事件.clientX - 矩形.left, y: 事件.clientY - 矩形.top };
  }, []);

  const 开始平移 = (事件) => {
    if (事件.button !== 0 && 事件.button !== 1) return;
    事件.preventDefault();
    拖拽引用.current = {
      类型: "平移",
      起点: { x: 事件.clientX, y: 事件.clientY },
      起始视图: { ...视图引用.current },
    };
  };

  const 结束拖拽 = (事件) => {
    const 拖拽 = 拖拽引用.current;
    拖拽引用.current = null;
    if (!拖拽) return;
    const 路径 = 拖拽.板路径 || 当前板引用.current;
    if (拖拽.脏 && 路径 && 板数据引用.current[路径]?.elements) 记快照(路径, 板数据引用.current[路径]);
    const 捕获 = 拖拽.捕获元素;
    if (捕获?.releasePointerCapture && 事件) {
      try {
        捕获.releasePointerCapture(事件.pointerId);
      } catch {
        /* 指针已释放，忽略 */
      }
    }
  };

  const 处理指针移动 = (事件) => {
    const 拖拽 = 拖拽引用.current;
    if (!拖拽) return;
    const 缩放 = 视图引用.current.scale || 1;
    if (拖拽.类型 === "平移") {
      set视图({
        scale: 拖拽.起始视图.scale,
        tx: 拖拽.起始视图.tx + (事件.clientX - 拖拽.起点.x),
        ty: 拖拽.起始视图.ty + (事件.clientY - 拖拽.起点.y),
      });
      return;
    }
    const 位移x = (事件.clientX - 拖拽.起点.x) / 缩放;
    const 位移y = (事件.clientY - 拖拽.起点.y) / 缩放;
    if (拖拽.类型 === "板移动") {
      拖拽.脏 = true;
      const x = Math.round(拖拽.起点板.x + 位移x);
      const y = Math.round(拖拽.起点板.y + 位移y);
      移动板(拖拽.板路径, x - 拖拽.当前板.x, y - 拖拽.当前板.y);
      拖拽.当前板 = { x, y };
      return;
    }
    if (拖拽.类型 === "板缩放") {
      拖拽.脏 = true;
      const 宽 = Math.round(拖拽.起点板.w + 位移x);
      const 高 = Math.round(拖拽.起点板.h + 位移y);
      缩放板(拖拽.板路径, 宽, 高);
      return;
    }
    if (拖拽.类型 === "元素移动") {
      拖拽.脏 = true;
      const 下一个 = moveElement(拖拽.起始板, 拖拽.元素id, Math.round(位移x), Math.round(位移y));
      应用板变更(拖拽.板路径, () => 下一个, { 立即保存: false });
      return;
    }
    if (拖拽.类型 === "元素缩放") {
      拖拽.脏 = true;
      const 矩形 = 调整矩形(拖拽.起始矩形, 拖拽.方向, 位移x, 位移y, 8);
      应用板变更(拖拽.板路径, () => resizeElement(拖拽.起始板, 拖拽.元素id, 矩形), { 立即保存: false });
    }
  };

  const 板纸指针按下 = (事件, 路径) => {
    if (事件.button === 1 || 空格按下 || 手形工具) {
      开始平移(事件);
      return;
    }
    if (事件.button !== 0) return;
    // 正在行内编辑文本时，板纸不再抢指针（否则双击第二下会被当成拖动）
    if (编辑引用.current) return;
    const 板 = 板数据引用.current[路径];
    if (!板 || !Array.isArray(板.elements)) return;
    const 纸 = 事件.currentTarget.getBoundingClientRect();
    const 缩放 = 视图引用.current.scale || 1;
    const 点 = { x: (事件.clientX - 纸.left) / 缩放, y: (事件.clientY - 纸.top) / 缩放 };
    const 命中 = 命中元素(板, 点);
    set当前板路径(路径);
    set选中元素(命中);
    if (!命中 || 只读) return;
    事件.currentTarget.setPointerCapture?.(事件.pointerId);
    拖拽引用.current = {
      类型: "元素移动",
      起点: { x: 事件.clientX, y: 事件.clientY },
      起始板: 板,
      元素id: 命中,
      板路径: 路径,
      捕获元素: 事件.currentTarget,
      脏: false,
    };
  };

  const 缩放柄指针按下 = (事件, 方向) => {
    事件.stopPropagation();
    if (只读) return;
    const 路径 = 当前板引用.current;
    const id = 选中引用.current;
    const 板 = 板数据引用.current[路径];
    const 元素 = 板?.elements?.find((项) => 项.id === id);
    if (!板 || !元素) return;
    事件.currentTarget.setPointerCapture?.(事件.pointerId);
    拖拽引用.current = {
      类型: "元素缩放",
      方向,
      起点: { x: 事件.clientX, y: 事件.clientY },
      起始板: 板,
      起始矩形: { x: 元素.x, y: 元素.y, w: 元素.w, h: 元素.h },
      元素id: id,
      板路径: 路径,
      捕获元素: 事件.currentTarget,
      脏: false,
    };
  };

  const 板头指针按下 = (事件, 路径) => {
    if (事件.button !== 0 || 只读) return;
    事件.stopPropagation();
    const 布局 = 画布?.boards?.[路径];
    if (!布局) return;
    事件.currentTarget.setPointerCapture?.(事件.pointerId);
    拖拽引用.current = {
      类型: "板移动",
      起点: { x: 事件.clientX, y: 事件.clientY },
      起点板: { x: 布局.x, y: 布局.y },
      当前板: { x: 布局.x, y: 布局.y },
      板路径: 路径,
      捕获元素: 事件.currentTarget,
      脏: false,
    };
  };

  const 板角指针按下 = (事件, 路径) => {
    if (事件.button !== 0 || 只读) return;
    事件.stopPropagation();
    const 布局 = 画布?.boards?.[路径];
    if (!布局) return;
    事件.currentTarget.setPointerCapture?.(事件.pointerId);
    拖拽引用.current = {
      类型: "板缩放",
      起点: { x: 事件.clientX, y: 事件.clientY },
      起点板: { w: 布局.w, h: 布局.h },
      板路径: 路径,
      捕获元素: 事件.currentTarget,
      脏: false,
    };
  };

  /* ── 键盘快捷键 ── */

  useEffect(() => {
    const 可用 = () => {
      const 节点 = 外壳引用.current;
      // 画布标签被 canvas-hidden 隐藏时组件仍挂载，不能抢别的面板的快捷键
      if (!节点 || 节点.offsetParent === null) return false;
      const 焦点 = document.activeElement;
      return 节点.contains(焦点) || 焦点 === document.body || 焦点 === null;
    };
    const 按下 = (事件) => {
      if (播放中 || !可用()) return;
      const 焦点 = document.activeElement;
      const 目标是输入 = Boolean(焦点?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(焦点?.tagName || "");
      if (事件.code === "Space" && !目标是输入) {
        事件.preventDefault();
        if (!空格按下) set空格按下(true);
        return;
      }
      if (目标是输入) return;
      if (事件.key.toLowerCase() === "h" && !事件.ctrlKey && !事件.metaKey && !事件.altKey) {
        事件.preventDefault();
        set手形工具((值) => !值);
        return;
      }
      const 修饰 = 事件.ctrlKey || 事件.metaKey;
      if (修饰 && 事件.key.toLowerCase() === "z") {
        事件.preventDefault();
        撤销或重做(事件.shiftKey ? 1 : -1);
        return;
      }
      if (修饰 && 事件.key.toLowerCase() === "y") {
        事件.preventDefault();
        撤销或重做(1);
        return;
      }
      if ((事件.key === "Delete" || 事件.key === "Backspace") && 选中引用.current && !编辑引用.current) {
        事件.preventDefault();
        删除选中();
      }
    };
    const 抬起 = (事件) => {
      if (事件.code === "Space") set空格按下(false);
    };
    window.addEventListener("keydown", 按下);
    window.addEventListener("keyup", 抬起);
    return () => {
      window.removeEventListener("keydown", 按下);
      window.removeEventListener("keyup", 抬起);
    };
  }, [撤销或重做, 删除选中, 空格按下, 播放中]);

  // 拖拽/编辑结束或标签失焦时清掉空格态，避免"一直处于平移模式"
  useEffect(() => {
    const 失焦 = () => set空格按下(false);
    window.addEventListener("blur", 失焦);
    return () => window.removeEventListener("blur", 失焦);
  }, []);

  /* ── 渲染数据 ── */

  const 当前板 = 当前板路径 ? 板数据[当前板路径] : null;
  const 选中对象 = 当前板 && Array.isArray(当前板.elements) ? 当前板.elements.find((项) => 项.id === 选中元素) || null : null;
  // 历史引用不是 state：靠 历史版本 触发重渲染后再读取最新可用态
  void 历史版本;
  const 历史 = 当前板路径 ? 历史引用.current.get(当前板路径) : null;
  const 可撤销 = canUndo(历史);
  const 可重做 = canRedo(历史);

  const 顶栏 = (
    <div className="oaw-canvas-toolbar" role="toolbar" aria-label="创作画布工具条">
      <button type="button" className="oaw-canvas-tool" onClick={请求关闭} aria-label="关闭创作画布" title="返回（关闭画布）">
        <Icon name="back" size={14} />
      </button>
      <div className="oaw-canvas-title-wrap">
        {画布 ? (
          <button
            type="button"
            className="oaw-canvas-title"
            onDoubleClick={改名}
            title={`${画布.title}（双击改名）`}
            aria-label={`画布标题 ${画布.title}，双击可改名`}
          >
            {画布.title}
          </button>
        ) : (
          <span className="oaw-canvas-title">创作画布</span>
        )}
        {有脏 && <i className="oaw-canvas-dirty-dot" aria-label="有未保存修改" title="有未保存修改" />}
      </div>
      {画布 && 列表.length > 0 && (
        <label className="oaw-canvas-switcher" title="切换当前工作区的其他画布">
          <Icon name="grid" size={12} />
          <select
            className="oaw-canvas-switcher-select"
            value={画布键}
            onChange={(事件) => 切换画布(事件.target.value)}
            aria-label="切换画布"
          >
            {列表.map((项) => {
              const 标识 = String(项?.slug || "");
              return <option key={标识} value={标识}>{项?.title || 标识}</option>;
            })}
          </select>
        </label>
      )}
      {画布 && (
        <>
          <span className="oaw-canvas-divider" aria-hidden="true" />
          <button
            type="button"
            className={`oaw-canvas-tool ${空格按下 ? "active" : ""}`}
            onPointerDown={() => set空格按下(true)}
            onPointerUp={() => set空格按下(false)}
            onPointerLeave={() => set空格按下(false)}
            aria-pressed={空格按下}
            aria-label="选择工具（按住空格可平移画布）"
            title="选择工具：空格或中键拖拽平移"
          >
            <Icon name="cursor" size={14} />
          </button>
          <button
            type="button"
            className={`oaw-canvas-tool ${手形工具 ? "active" : ""}`}
            onClick={() => { set手形工具((值) => !值); set选中元素(""); }}
            aria-pressed={手形工具}
            aria-label="抓手工具（拖动平移画布）"
            title="抓手工具：拖动平移画布（快捷键 H）"
          >
            <Icon name="hand" size={14} />
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={添加文本} disabled={只读} aria-label="添加文本" title="添加文本">
            <Icon name="wrap" size={14} />
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={新建画板} disabled={只读 || 新建板中} aria-label="新建画板" title="在当前页新建一块画板">
            <Icon name="plus" size={14} /> 画板
          </button>
          <button type="button" className={`oaw-canvas-tool ${页面面板 ? "active" : ""}`} onClick={() => set页面面板(true)} aria-pressed={页面面板} aria-label="页管理" title="页：分组、重命名、删除">
            <Icon name="folder" size={14} /> 页
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={复制当前板} disabled={只读 || !当前板路径} aria-label="复制当前画板" title="复制当前画板（元素 id 重新生成）">
            <Icon name="copy" size={14} />
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={删除当前板} disabled={只读 || !当前板路径} aria-label="删除当前画板" title="删除当前画板（软删到 .trash，可从版本恢复）">
            <Icon name="trash" size={14} />
          </button>
          <span className="oaw-canvas-divider" aria-hidden="true" />
          <button type="button" className="oaw-canvas-tool" onClick={() => 以点缩放(1 / 1.2)} aria-label="缩小画布" title="缩小">
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="oaw-canvas-zoom"
            onClick={适配窗口}
            aria-label={`当前缩放 ${Math.round(视图.scale * 100)}%，点击适配窗口`}
            title="适配窗口"
          >
            {Math.round(视图.scale * 100)}%
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={() => 以点缩放(1.2)} aria-label="放大画布" title="放大">
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className="oaw-canvas-tool"
            onClick={() => 以点缩放(1 / (视图引用.current.scale || 1))}
            aria-label="缩放到 100%"
            title="缩放到 100%"
          >
            1:1
          </button>
          <button
            type="button"
            className={`oaw-canvas-tool ${网格显示 ? "active" : ""}`}
            onClick={() => set网格显示((值) => !值)}
            aria-pressed={网格显示}
            aria-label="切换网格背景"
            title="网格背景"
          >
            <Icon name="grid" size={14} />
          </button>
          <span className="oaw-canvas-divider" aria-hidden="true" />
          <button type="button" className="oaw-canvas-tool" onClick={() => 撤销或重做(-1)} disabled={!可撤销 || 只读} aria-label="撤销" title="撤销（Ctrl+Z）">
            <Icon name="backlink" size={14} />
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={() => 撤销或重做(1)} disabled={!可重做 || 只读} aria-label="重做" title="重做（Ctrl+Shift+Z）">
            <Icon name="arrowRight" size={14} />
          </button>
          <span className="oaw-canvas-divider" aria-hidden="true" />
          <button type="button" className="oaw-canvas-tool" onClick={打开播放} disabled={!板列表.length} aria-label="播放画布" title="全屏播放（←/→ 或空格翻页，Esc 退出）">
            <Icon name="play" size={14} /> 播放
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={打开历史} aria-label="版本历史" title="查看画布级版本时间线并恢复">
            <Icon name="history" size={14} /> 版本
          </button>
          <button type="button" className={`oaw-canvas-tool ${设置面板 ? "active" : ""}`} onClick={() => set设置面板(true)} aria-pressed={设置面板} aria-label="页面主题与间距" title="页面主题、网格与板间距">
            <Icon name="palette" size={14} /> 页面
          </button>
          <button type="button" className="oaw-canvas-tool" onClick={添加到对话} aria-label="添加到对话" title="把画布引用插入对话输入框">
            <Icon name="chatPlus" size={14} /> 对话
          </button>
          <span className="oaw-canvas-spacer" />
          <button type="button" className="oaw-canvas-tool" onClick={手动刷新} aria-label="刷新画布" title={`重新读取画布（最后更新 ${刷新时间 || "—"}）`}>
            <Icon name="refresh" size={14} />
          </button>
          {agent活动.active ? (
            <span className="oaw-canvas-status saving" role="status" title="Agent 正在通过 canvas_* 工具编辑画布，完成后自动增量刷新">
              <Icon name="loading" size={12} /> Agent 正在编辑{agent编辑板 ? `《${默认板标题(agent编辑板)}》` : ""}…
            </span>
          ) : 只读 ? (
            <span className="oaw-canvas-status readonly" role="status" title={只读原因}>
              <Icon name="lock" size={12} /> 只读
            </span>
          ) : 保存中 ? (
            <span className="oaw-canvas-status saving" role="status">
              <Icon name="loading" size={12} /> 保存中
            </span>
          ) : 有脏 ? (
            <span className="oaw-canvas-status dirty" role="status">
              <Icon name="edit" size={12} /> 未保存
            </span>
          ) : (
            <span className="oaw-canvas-status" role="status">
              <Icon name="check" size={12} /> 已保存
            </span>
          )}
          <button type="button" className="oaw-canvas-tool" onClick={() => set导出面板(true)} aria-label="导出画布" title="导出 SVG / PNG / PDF / PPTX">
            <Icon name="download" size={14} /> 导出
          </button>
        </>
      )}
    </div>
  );

  /* ── 加载 / 失败 / 无画布 三态 ── */

  if (加载态 === "加载中") {
    return (
      <div className="oaw-canvas-shell" id={designTabId({ workspace: 工作区, slug: 画布键 })}>
        {顶栏}
        <div className="oaw-canvas-state" role="status">
          <div className="loading-spinner" />
          <span>正在加载创作画布…</span>
        </div>
      </div>
    );
  }

  if (加载态 === "失败") {
    return (
      <div className="oaw-canvas-shell" id={designTabId({ workspace: 工作区, slug: 画布键 })}>
        {顶栏}
        <div className="oaw-canvas-state error" role="alert">
          <Icon name="warning" size={16} />
          <span>{加载错误 || "创作画布加载失败"}</span>
          <div className="oaw-canvas-state-actions">
            <button type="button" className="btn-xs" onClick={载入画布}>重试</button>
            <button type="button" className="btn-xs" onClick={请求关闭}>关闭标签</button>
          </div>
        </div>
      </div>
    );
  }

  if (!画布键) {
    return (
      <div className="oaw-canvas-shell" id={designTabId({ workspace: 工作区, slug: "" })}>
        {顶栏}
        <div className="oaw-canvas-empty">
          <h3>创作画布</h3>
          <p className="oaw-canvas-empty-text">
            画布真源是工作区的 designs/&lt;slug&gt;/project/canvas.json（可选 boards/*.board.json 对象板与
            .dc.html 兼容板）。可以在这里新建画布，或让 Agent 用 canvas_write 生成画板；兼容画布由 Agent 导入后只读渲染。
          </p>
          <div className="oaw-canvas-empty-form">
            <input
              className="oaw-canvas-field"
              value={新建标题}
              onChange={(事件) => set新建标题(事件.target.value)}
              placeholder="新画布标题"
              aria-label="新画布标题"
            />
            <select className="oaw-canvas-field" value={新建类型} onChange={(事件) => set新建类型(事件.target.value)} aria-label="画布类型">
              <option value="board">普通画布</option>
              <option value="deck">演示 deck（16:9）</option>
            </select>
            <button type="button" className="btn-xs" onClick={新建画布} disabled={!工作区} title={工作区 ? "新建画布" : "请先选择工作区"}>
              <Icon name="plus" size={12} /> 新建
            </button>
            <button type="button" className="btn-xs" onClick={导入画布} disabled={!工作区} title="导入 claude-design / baoyu-design 兼容画布（复制到当前工作区，不改原目录）">
              <Icon name="upload" size={12} /> 导入
            </button>
          </div>
          <div className="oaw-canvas-list">
            <div className="oaw-canvas-list-head">最近的画布（{列表.length}）</div>
            {列表.length === 0 && <div className="oaw-canvas-list-empty">当前工作区还没有创作画布。</div>}
            {列表.map((项) => {
              const 标识 = String(项?.slug || 项?.id || "");
              return (
                <button
                  key={标识 || 项?.title}
                  type="button"
                  className="oaw-canvas-list-item"
                  onClick={() => (typeof onOpenCanvas === "function" ? onOpenCanvas(标识) : notifyWarn("请在画布面板的「+」菜单打开该画布"))}
                >
                  <Icon name="grid" size={13} />
                  <span className="oaw-canvas-list-title">{项?.title || 标识 || "未命名画布"}</span>
                  <span className="oaw-canvas-list-meta">
                    {项?.kind === "deck" ? "deck" : "board"} · {Number(项?.boardCount ?? 项?.boards ?? 0)} 板
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const 空画布 = 板列表.length === 0;

  /* ── 主视图 ── */

  return (
    <div className="oaw-canvas-shell" id={designTabId({ workspace: 工作区, slug: 画布键 })} ref={外壳引用} tabIndex={-1}>
      {顶栏}

      {保存错误 && (
        <div className="oaw-canvas-banner warn" role="alert">
          <Icon name="warning" size={13} />
          <span>{保存错误}</span>
          <button type="button" className="btn-xs" onClick={() => set保存错误("")} aria-label="关闭保存错误提示">关闭</button>
        </div>
      )}

      {冲突 && (
        <div className="oaw-canvas-banner conflict" role="alert">
          <Icon name="warning" size={13} />
          <span>
            {冲突.消息 || "画布内容已变化（版本冲突）"}：{冲突.类型 === "板" ? `「${默认板标题(冲突.路径 || "")}」` : "画布索引"}
            在服务端已被修改。刷新会丢弃本地改动，覆盖会用本地内容覆盖服务端。
          </span>
          <div className="oaw-canvas-banner-actions">
            <button type="button" className="btn-xs" onClick={冲突刷新}>刷新</button>
            <button type="button" className="btn-xs danger" onClick={冲突覆盖}>覆盖</button>
          </div>
        </div>
      )}

      {远端更新 && (
        <div className="oaw-canvas-banner warn" role="alert">
          <Icon name="refresh" size={13} />
          <span>画布已有远端更新；当前有未保存修改，刷新会丢弃本地改动。</span>
          <div className="oaw-canvas-banner-actions">
            <button type="button" className="btn-xs" onClick={() => { set远端更新(false); 打开历史(); }}>查看版本</button>
            <button type="button" className="btn-xs" onClick={() => { set远端更新(false); 载入画布(); 载入画布列表(); }}>刷新（丢弃本地）</button>
            <button type="button" className="btn-xs" onClick={() => set远端更新(false)}>保留我的</button>
          </div>
        </div>
      )}

      {只读 && (
        <div className="oaw-canvas-banner" role="status">
          <Icon name="lock" size={13} />
          <span>{只读原因 || "当前画布为只读，编辑能力已关闭；可平移缩放与导出。"}</span>
        </div>
      )}

      {空画布 ? (
        <div className="oaw-canvas-empty">
          <h3>这个画布还没有画板</h3>
          <p className="oaw-canvas-empty-text">
            可以直接新建一块空白画板开始编辑；也可以让 Agent 用 canvas_write 生成，或导入已有
            claude-design / baoyu-design 兼容画布（.dc.html 只读）。
          </p>
          <div className="oaw-canvas-state-actions">
            <button type="button" className="btn-xs" onClick={新建画板} disabled={只读 || 新建板中}><Icon name="plus" size={12} /> 新建画板</button>
            <button type="button" className="btn-xs" onClick={新建页} disabled={只读}><Icon name="folder" size={12} /> 新建页</button>
            <button type="button" className="btn-xs" onClick={载入画布}><Icon name="refresh" size={12} /> 重新读取画布</button>
            <button type="button" className="btn-xs" onClick={请求关闭}>关闭标签</button>
          </div>
        </div>
      ) : (
        <div className="oaw-canvas-body">
          <div className="oaw-canvas-main">
            <div
              ref={视口引用}
              className={`oaw-canvas-viewport ${空格按下 ? "panning" : ""} ${手形工具 ? "pan-mode" : ""} ${网格显示 ? "grid" : ""}`}
              style={网格显示 ? { backgroundSize: `${Math.max(6, Number(页面设置.网格) || 16)}px ${Math.max(6, Number(页面设置.网格) || 16)}px` } : undefined}
              onPointerDown={(事件) => {
                if (事件.button === 1 || 空格按下 || 手形工具) 开始平移(事件);
                else if (事件.button === 0 && 事件.target === 事件.currentTarget) set选中元素("");
              }}
              onPointerMove={处理指针移动}
              onPointerUp={结束拖拽}
              onPointerCancel={结束拖拽}
              role="application"
              aria-label="创作画布视图：滚轮缩放，空格、中键或抓手工具拖拽平移"
            >
              {可见板.map((项) => {
                const 缩放 = 视图.scale || 1;
                const 是当前 = 项.path === 当前板路径;
                const 板 = 板数据[项.path];
                const 载入信息 = 板载入[项.path];
                const 是对象板 = 项.type === "object";
                return (
                  <div
                    key={项.path}
                    className={`oaw-canvas-board ${是当前 ? "active" : ""}`}
                    style={{ left: 项.x * 缩放 + 视图.tx, top: 项.y * 缩放 + 视图.ty, width: 项.w * 缩放, height: 项.h * 缩放 }}
                    data-board={项.path}
                  >
                    <div
                      className="oaw-canvas-board-head"
                      onPointerDown={(事件) => 板头指针按下(事件, 项.path)}
                      onDoubleClick={(事件) => { 事件.stopPropagation(); 改板标题(项.path); }}
                      title={`${项.title}（拖动移动画板，双击改名）`}
                    >
                      <Icon name={是对象板 ? "grid" : "html"} size={11} />
                      <span className="oaw-canvas-board-title">{项.title}</span>
                      <span className="oaw-canvas-board-size">{项.w}×{项.h}</span>
                      {项.type === "html" && <span className="oaw-canvas-board-badge" title="兼容板只读：不提供内部对象编辑">只读·兼容板</span>}
                      {项.type === "svg" && <span className="oaw-canvas-board-badge" title="只读矢量板">只读·矢量板</span>}
                    </div>
                    <div className="oaw-canvas-board-scale">
                      {(载入信息 === undefined || 载入信息 === "加载中") && (
                        <div className="oaw-canvas-board-placeholder">
                          <div className="loading-spinner" />
                        </div>
                      )}
                      {typeof 载入信息 === "string" && 载入信息.startsWith("失败") && (
                        <div className="oaw-canvas-board-placeholder error" role="alert">
                          <Icon name="warning" size={13} />
                          <span>{载入信息.replace(/^失败：/, "")}</span>
                          <button
                            type="button"
                            className="btn-xs"
                            onClick={() => { 在途引用.current.delete(项.path); 载入板(项.path, { 强制: true }); }}
                          >
                            重试
                          </button>
                        </div>
                      )}
                      {是对象板 && 板 && Array.isArray(板.elements) && 载入信息 === "就绪" && (
                        <div
                          className="oaw-canvas-board-paper"
                          style={{ width: 项.w, height: 项.h, background: 板.background || undefined, transform: `scale(${缩放})` }}
                          onPointerDown={(事件) => 板纸指针按下(事件, 项.path)}
                          onDoubleClick={(事件) => {
                            if (编辑引用.current || 只读) return;
                            const 纸 = 事件.currentTarget.getBoundingClientRect();
                            const 命中 = 命中元素(板, { x: (事件.clientX - 纸.left) / 缩放, y: (事件.clientY - 纸.top) / 缩放 });
                            const 目标 = 板.elements.find((元素) => 元素.id === 命中);
                            set当前板路径(项.path);
                            set选中元素(命中);
                            if (目标?.type === "text") set编辑元素(命中);
                          }}
                        >
                          {板.elements.map((元素) =>
                            编辑元素 === 元素.id && 是当前 ? (
                              <文本编辑框
                                key={元素.id}
                                元素={元素}
                                on提交={(文本) => {
                                  set编辑元素("");
                                  const 最新板 = 板数据引用.current[项.path] || 板;
                                  const 下一个 = setElementText(最新板, 元素.id, 文本);
                                  应用板变更(项.path, () => 下一个, { 立即保存: false });
                                  记快照(项.path, 下一个);
                                  调度板保存(项.path);
                                }}
                                on取消={() => set编辑元素("")}
                              />
                            ) : (
                              <元素视图 key={元素.id} 元素={元素} 素材前缀={素材前缀} />
                            ),
                          )}
                          {Number(页面设置.安全边距) > 0 && (
                            <div
                              className="oaw-canvas-safe-area"
                              style={{ inset: Math.max(0, Number(页面设置.安全边距) || 0) }}
                              aria-hidden="true"
                            />
                          )}
                          {是当前 && 选中对象 && 编辑元素 !== 选中对象.id && (
                            <div
                              className="oaw-canvas-selection"
                              style={{
                                left: 选中对象.x,
                                top: 选中对象.y,
                                width: Math.max(选中对象.w, 1),
                                height: Math.max(选中对象.h, 0),
                                borderWidth: 1 / 缩放,
                              }}
                              aria-hidden="true"
                            >
                              {!只读 &&
                                八向.map((方向) => (
                                  <button
                                    key={方向}
                                    type="button"
                                    className="oaw-canvas-handle"
                                    data-handle={方向}
                                    style={{ width: 9 / 缩放, height: 9 / 缩放 }}
                                    onPointerDown={(事件) => 缩放柄指针按下(事件, 方向)}
                                    aria-label={`向${方向标签[方向]}缩放选中元素`}
                                    title={`向${方向标签[方向]}缩放`}
                                  />
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                      {!是对象板 && 板 && 载入信息 === "就绪" && (
                        <div
                          className="oaw-canvas-board-paper oaw-canvas-board-paper-plain"
                          style={{ width: 项.w, height: 项.h, transform: `scale(${缩放})` }}
                        >
                          {板.srcDoc ? (
                            <iframe
                              className="oaw-canvas-iframe"
                              title={`兼容板 ${项.title}`}
                              /* 安全边界：只开 allow-same-origin，不开脚本权限，兼容板内脚本不会执行 */
                              sandbox="allow-same-origin"
                              srcDoc={板.srcDoc}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                            />
                          ) : 板.rawUrl ? (
                            <iframe
                              className="oaw-canvas-iframe"
                              title={`兼容板 ${项.title}`}
                              sandbox="allow-same-origin"
                              src={板.rawUrl}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                            />
                          ) : 项.type === "svg" ? (
                            <img className="oaw-canvas-iframe" src={素材地址({ slug: 画布键, workspace: 工作区, path: 项.path })} alt="" draggable={false} />
                          ) : (
                            <div className="oaw-canvas-board-placeholder">
                              <Icon name="info" size={13} />
                              <span>兼容板内容未返回：需要板接口给出 HTML 正文（srcDoc）或受控地址（rawUrl）</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {!只读 && (
                      <button
                        type="button"
                        className="oaw-canvas-board-resize"
                        onPointerDown={(事件) => 板角指针按下(事件, 项.path)}
                        aria-label={`调整画板「${项.title}」尺寸`}
                        title="拖动调整画板尺寸"
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {页列表.length > 1 && (
              <div className="oaw-canvas-page-tabs" role="tablist" aria-label="页筛选">
                <button type="button" role="tab" aria-selected={!当前页} className={!当前页 ? "active" : ""} onClick={() => set当前页("")}>全部</button>
                {页列表.map((页) => (
                  <button
                    key={页.id}
                    type="button"
                    role="tab"
                    aria-selected={当前页 === 页.id}
                    className={当前页 === 页.id ? "active" : ""}
                    onClick={() => {
                      set当前页(页.id);
                      if (页.boards[0]) set当前板路径(页.boards[0].path);
                    }}
                  >
                    {页.name || 页.id}
                  </button>
                ))}
              </div>
            )}

            <div className={`oaw-canvas-deck ${deck模式 ? "" : "boards"}`} role="list" aria-label={deck模式 ? "幻灯片缩略条" : "画板列表"}>
              {(deck模式 ? 幻灯列表 : 显示板列表).map((项, 序号) => {
                const 是当前 = 项.path === 当前板路径;
                const 板 = 板数据[项.path];
                return (
                  <div
                    key={项.path}
                    role="listitem"
                    className={`oaw-canvas-deck-item ${是当前 ? "active" : ""}`}
                    draggable
                    onDragStart={(事件) => {
                      事件.dataTransfer.effectAllowed = "move";
                      事件.dataTransfer.setData("text/oaw-canvas-board", 项.path);
                    }}
                    onDragOver={(事件) => { 事件.preventDefault(); 事件.dataTransfer.dropEffect = "move"; }}
                    onDrop={(事件) => {
                      事件.preventDefault();
                      const 起点 = 事件.dataTransfer.getData("text/oaw-canvas-board");
                      if (起点 && 起点 !== 项.path) 拖拽排序(起点, 项.path);
                    }}
                  >
                    <button
                      type="button"
                      className="oaw-canvas-deck-thumb"
                      onClick={() => { set当前板路径(项.path); set选中元素(""); set编辑元素(""); }}
                      aria-current={是当前}
                      aria-label={`${deck模式 ? "幻灯片" : "画板"} ${序号 + 1}：${项.title}`}
                      title={项.title}
                      style={{ aspectRatio: `${项.w} / ${项.h}` }}
                    >
                      {板 && Array.isArray(板.elements) ? (
                        <span className="oaw-canvas-deck-mini">
                          {板.elements.slice(0, 12).map((元素) => (
                            <i
                              key={元素.id}
                              className="oaw-canvas-deck-shot"
                              data-type={元素.type}
                              style={{
                                left: `${(元素.x / Math.max(项.w, 1)) * 100}%`,
                                top: `${(元素.y / Math.max(项.h, 1)) * 100}%`,
                                width: `${(Math.max(元素.w, 1) / Math.max(项.w, 1)) * 100}%`,
                                height: `${(Math.max(元素.h, 1) / Math.max(项.h, 1)) * 100}%`,
                              }}
                            />
                          ))}
                        </span>
                      ) : (
                        <span className="oaw-canvas-deck-name">{项.title}</span>
                      )}
                    </button>
                    <span className="oaw-canvas-deck-index">
                      {序号 + 1}
                      {deck模式 && 项.role === "slide" ? " · 片" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {选中对象 && !只读 && (
            <aside className="oaw-canvas-inspector" aria-label="元素属性">
              <div className="oaw-canvas-inspector-head">
                <Icon name="tool" size={13} />
                <span>{选中对象.type === "text" ? "文本属性" : 选中对象.type === "rect" ? "形状属性" : "元素属性"}</span>
                <button type="button" className="btn-xs danger" onClick={删除选中} aria-label="删除选中元素" title="删除（Delete）">
                  <Icon name="trash" size={12} />
                </button>
              </div>

              {选中对象.type === "text" && (
                <>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">字号</span>
                    <input
                      type="number"
                      min="6"
                      max="400"
                      className="oaw-canvas-field"
                      value={Math.round(选中对象.style?.fontSize ?? 32)}
                      onChange={(事件) => 更新选中元素({ style: { fontSize: Number(事件.target.value) || 32 } })}
                      onBlur={当前板快照}
                      aria-label="字号"
                    />
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">粗细</span>
                    <select
                      className="oaw-canvas-field"
                      value={选中对象.style?.fontWeight ?? 400}
                      onChange={(事件) => 更新选中元素({ style: { fontWeight: Number(事件.target.value) } }, { 存快照: true })}
                      aria-label="字重"
                    >
                      {[300, 400, 500, 600, 700, 800].map((值) => (
                        <option key={值} value={值}>{值}</option>
                      ))}
                    </select>
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">颜色</span>
                    <input
                      type="text"
                      className="oaw-canvas-field"
                      value={选中对象.style?.color || ""}
                      placeholder="如 var(--text) / 深色值"
                      onChange={(事件) => 更新选中元素({ style: { color: 事件.target.value } })}
                      onBlur={当前板快照}
                      aria-label="文字颜色"
                    />
                    <i className="oaw-canvas-swatch" style={{ background: 选中对象.style?.color || "transparent" }} aria-hidden="true" />
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">对齐</span>
                    <select
                      className="oaw-canvas-field"
                      value={选中对象.style?.textAlign || "left"}
                      onChange={(事件) => 更新选中元素({ style: { textAlign: 事件.target.value } }, { 存快照: true })}
                      aria-label="文本对齐"
                    >
                      <option value="left">左对齐</option>
                      <option value="center">居中</option>
                      <option value="right">右对齐</option>
                    </select>
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">行高</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0.8"
                      max="3"
                      className="oaw-canvas-field"
                      value={选中对象.style?.lineHeight ?? 1.3}
                      onChange={(事件) => 更新选中元素({ style: { lineHeight: Number(事件.target.value) || 1.3 } })}
                      onBlur={当前板快照}
                      aria-label="行高"
                    />
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">字体</span>
                    <select
                      className="oaw-canvas-field"
                      value={选中对象.style?.fontFamily || ""}
                      onChange={(事件) => 更新选中元素({ style: { fontFamily: 事件.target.value } }, { 存快照: true })}
                      aria-label="字体"
                    >
                      <option value="">跟随界面</option>
                      {字体候选.map((字) => (
                        <option key={字} value={字}>{字}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              {选中对象.type === "rect" && (
                <>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">填充</span>
                    <input
                      type="text"
                      className="oaw-canvas-field"
                      value={选中对象.style?.fill || ""}
                      placeholder="如 var(--surface)"
                      onChange={(事件) => 更新选中元素({ style: { fill: 事件.target.value } })}
                      onBlur={当前板快照}
                      aria-label="填充色"
                    />
                    <i className="oaw-canvas-swatch" style={{ background: 选中对象.style?.fill || "transparent" }} aria-hidden="true" />
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">圆角</span>
                    <input
                      type="number"
                      min="0"
                      max="400"
                      className="oaw-canvas-field"
                      value={Math.round(选中对象.style?.radius ?? 0)}
                      onChange={(事件) => 更新选中元素({ style: { radius: Number(事件.target.value) || 0 } })}
                      onBlur={当前板快照}
                      aria-label="圆角"
                    />
                  </label>
                  <label className="oaw-canvas-inspector-row">
                    <span className="oaw-canvas-inspector-label">描边</span>
                    <input
                      type="text"
                      className="oaw-canvas-field"
                      value={选中对象.style?.stroke || ""}
                      placeholder="留空为无描边"
                      onChange={(事件) => 更新选中元素({ style: { stroke: 事件.target.value } })}
                      onBlur={当前板快照}
                      aria-label="描边色"
                    />
                  </label>
                </>
              )}

              <div className="oaw-canvas-inspector-row">
                <span className="oaw-canvas-inspector-label">位置</span>
                <input
                  type="number"
                  className="oaw-canvas-field"
                  value={Math.round(选中对象.x)}
                  onChange={(事件) => {
                    const x = Number(事件.target.value);
                    if (Number.isFinite(x)) 更新选中元素({ x });
                  }}
                  onBlur={当前板快照}
                  aria-label="X 坐标"
                />
                <input
                  type="number"
                  className="oaw-canvas-field"
                  value={Math.round(选中对象.y)}
                  onChange={(事件) => {
                    const y = Number(事件.target.value);
                    if (Number.isFinite(y)) 更新选中元素({ y });
                  }}
                  onBlur={当前板快照}
                  aria-label="Y 坐标"
                />
              </div>
              <div className="oaw-canvas-inspector-row">
                <span className="oaw-canvas-inspector-label">尺寸</span>
                <input
                  type="number"
                  className="oaw-canvas-field"
                  value={Math.round(选中对象.w)}
                  onChange={(事件) => {
                    const w = Number(事件.target.value);
                    if (Number.isFinite(w) && w >= 1) 更新选中元素({ w });
                  }}
                  onBlur={当前板快照}
                  aria-label="宽度"
                />
                <input
                  type="number"
                  className="oaw-canvas-field"
                  value={Math.round(选中对象.h)}
                  onChange={(事件) => {
                    const h = Number(事件.target.value);
                    if (Number.isFinite(h) && h >= 0) 更新选中元素({ h });
                  }}
                  onBlur={当前板快照}
                  aria-label="高度"
                />
              </div>
              <p className="oaw-canvas-inspector-hint">双击文本进入编辑（Esc 取消 / 失焦提交）；Delete 删除；Ctrl+Z 撤销。</p>
            </aside>
          )}
        </div>
      )}

      {播放中 && (
        <div className="oaw-canvas-play" role="dialog" aria-modal="true" aria-label="画布播放">
          <div className="oaw-canvas-play-stage" onClick={() => 播放步进(1)}>
            {播放项 ? (() => {
              const 板 = 板数据[播放项.path];
              const 宽 = Math.max(1, Number(播放项.w) || 1280);
              const 高 = Math.max(1, Number(播放项.h) || 720);
              const 缩放 = Math.max(0.1, Math.min((播放尺寸.w - 120) / 宽, (播放尺寸.h - 160) / 高, 2));
              if (!板) return <div className="oaw-canvas-play-empty">正在加载画板…</div>;
              return (
                <div
                  className="oaw-canvas-play-paper"
                  style={{ width: Math.round(宽 * 缩放), height: Math.round(高 * 缩放), background: 板.background || undefined }}
                  onClick={(事件) => 事件.stopPropagation()}
                >
                  <div style={{ position: "absolute", left: 0, top: 0, width: 宽, height: 高, transform: `scale(${缩放})`, transformOrigin: "top left" }}>
                    {Array.isArray(板.elements) ? (
                      板.elements.map((元素) => <元素视图 key={元素.id} 元素={元素} 素材前缀={素材前缀} />)
                    ) : 板.srcDoc ? (
                      <iframe className="oaw-canvas-play-iframe" title={`播放 ${播放项.title}`} sandbox="allow-same-origin" srcDoc={板.srcDoc} referrerPolicy="no-referrer" />
                    ) : 板.rawUrl ? (
                      <iframe className="oaw-canvas-play-iframe" title={`播放 ${播放项.title}`} sandbox="allow-same-origin" src={板.rawUrl} referrerPolicy="no-referrer" />
                    ) : 播放项.type === "svg" ? (
                      <img className="oaw-canvas-play-iframe" src={素材地址({ slug: 画布键, workspace: 工作区, path: 播放项.path })} alt="" />
                    ) : (
                      <div className="oaw-canvas-play-empty">兼容板内容未加载</div>
                    )}
                  </div>
                </div>
              );
            })() : <div className="oaw-canvas-play-empty">画布没有可播放的画板</div>}
          </div>
          <div className="oaw-canvas-play-bar">
            <button type="button" className="btn-xs" onClick={() => 播放步进(-1)} disabled={播放序号 <= 0} aria-label="上一页">‹ 上一页</button>
            <span className="oaw-canvas-play-title">{播放项?.title || ""}{播放列表.length ? `　${Math.min(播放序号 + 1, 播放列表.length)} / ${播放列表.length}` : ""}</span>
            <button type="button" className="btn-xs" onClick={() => 播放步进(1)} disabled={播放序号 >= 播放列表.length - 1} aria-label="下一页">下一页 ›</button>
            <button type="button" className="btn-xs" onClick={关闭播放} aria-label="退出播放">退出（Esc）</button>
          </div>
        </div>
      )}

      {设置面板 && (
        <div className="oaw-canvas-export" role="dialog" aria-modal="true" aria-label="页面主题与间距">
          <div className="oaw-canvas-export-card oaw-canvas-dialog-card">
            <div className="oaw-canvas-export-head">
              <Icon name="palette" size={14} />
              <strong>页面主题与间距</strong>
              <span className="oaw-canvas-export-sub">{画布?.title || ""}</span>
              <button type="button" className="btn-xs" onClick={() => set设置面板(false)} aria-label="关闭页面设置"><Icon name="close" size={12} /></button>
            </div>
            <div className="oaw-canvas-export-body">
              <div className="oaw-canvas-field-row">
                <span className="oaw-canvas-inspector-label">画板背景</span>
                <input
                  className="oaw-canvas-field"
                  style={{ width: 200 }}
                  value={String(当前板?.background || "")}
                  placeholder="留空=默认纸白；可填颜色或 CSS 变量"
                  onChange={(事件) => 应用画板背景(事件.target.value)}
                  onBlur={当前板快照}
                  disabled={只读 || !当前板 || !Array.isArray(当前板.elements)}
                  aria-label="画板背景色"
                />
                <i className="oaw-canvas-swatch" style={{ background: String(当前板?.background || "transparent") }} aria-hidden="true" />
              </div>
              <div className="oaw-canvas-settings-actions">
                <button type="button" className="btn-xs" onClick={() => { 应用画板背景(""); 当前板快照(); }} disabled={只读 || !当前板 || !Array.isArray(当前板.elements)}>默认纸白</button>
                <button type="button" className="btn-xs" onClick={() => { 应用画板背景("var(--panel-bg)"); 当前板快照(); }} disabled={只读 || !当前板 || !Array.isArray(当前板.elements)}>面板色</button>
                <button type="button" className="btn-xs" onClick={() => { 应用画板背景("var(--surface)"); 当前板快照(); }} disabled={只读 || !当前板 || !Array.isArray(当前板.elements)}>表面色</button>
                <button type="button" className="btn-xs" onClick={背景应用到全部} disabled={只读 || !当前板 || !Array.isArray(当前板.elements)}>应用到全部对象板</button>
              </div>
              <div className="oaw-canvas-field-row">
                <span className="oaw-canvas-inspector-label">网格间距</span>
                <input type="number" min="6" max="200" className="oaw-canvas-field" value={页面设置.网格} onChange={(事件) => 更新页面设置({ 网格: Math.max(6, Number(事件.target.value) || 16) })} aria-label="网格间距" />
                <span className="oaw-canvas-export-note">px</span>
              </div>
              <div className="oaw-canvas-field-row">
                <span className="oaw-canvas-inspector-label">板间距</span>
                <input type="number" min="20" max="800" className="oaw-canvas-field" value={页面设置.板距} onChange={(事件) => 更新页面设置({ 板距: Math.max(20, Number(事件.target.value) || 160) })} aria-label="板间距" />
                <span className="oaw-canvas-export-note">px，“整理画板”按此间距排列</span>
              </div>
              <div className="oaw-canvas-field-row">
                <span className="oaw-canvas-inspector-label">安全边距</span>
                <input type="number" min="0" max="200" className="oaw-canvas-field" value={页面设置.安全边距} onChange={(事件) => 更新页面设置({ 安全边距: Math.max(0, Number(事件.target.value) || 0) })} aria-label="安全边距" />
                <span className="oaw-canvas-export-note">px 辅助线，不参与导出</span>
              </div>
              <div className="oaw-canvas-settings-actions">
                <button type="button" className="btn-xs" onClick={整理画板} disabled={只读 || !板列表.length}>按板间距整理画板</button>
                <button type="button" className="btn-xs" onClick={适配窗口}>适配窗口</button>
              </div>
              <p className="oaw-canvas-export-note">页面设置保存在本机；画板背景写入当前画板，整理画板会写回 canvas.json。</p>
            </div>
          </div>
        </div>
      )}

      {页面面板 && (
        <div className="oaw-canvas-export" role="dialog" aria-modal="true" aria-label="页管理">
          <div className="oaw-canvas-export-card oaw-canvas-dialog-card">
            <div className="oaw-canvas-export-head">
              <Icon name="folder" size={14} />
              <strong>页</strong>
              <span className="oaw-canvas-export-sub">页是画板分组；删除页不会删除画板</span>
              <button type="button" className="btn-xs" onClick={() => set页面面板(false)} aria-label="关闭页管理"><Icon name="close" size={12} /></button>
            </div>
            <div className="oaw-canvas-export-body">
              {!页列表.length ? (
                <div className="oaw-canvas-history-empty">这张画布还没有页；新建页后可以把画板分到不同章节。</div>
              ) : 页列表.map((页) => (
                <div className="oaw-canvas-history-item" key={页.id || "all"}>
                  <div className="oaw-canvas-history-item-main">
                    <span className="oaw-canvas-history-time">{页.name || 页.id}</span>
                    <span className="oaw-canvas-history-meta">{页.boards.length} 块板{当前页 === 页.id ? " · 当前页" : ""}</span>
                  </div>
                  <div className="oaw-canvas-page-actions">
                    <button type="button" className="btn-xs" onClick={() => { set当前页(页.id); if (页.boards[0]) set当前板路径(页.boards[0].path); }}>切换</button>
                    <button type="button" className="btn-xs" onClick={() => 重命名页(页)} disabled={只读}>重命名</button>
                    <button type="button" className="btn-xs" onClick={() => 删除页(页)} disabled={只读 || 页列表.length <= 1}>删除</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="oaw-canvas-export-actions">
              <button type="button" className="btn-xs" onClick={新建页} disabled={只读}><Icon name="plus" size={12} /> 新建页</button>
              <button type="button" className="btn-xs" onClick={() => set页面面板(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {历史面板 && (
        <div className="oaw-canvas-export" role="dialog" aria-modal="true" aria-label="版本历史">
          <div className="oaw-canvas-export-card oaw-canvas-dialog-card">
            <div className="oaw-canvas-export-head">
              <Icon name="history" size={14} />
              <strong>版本时间线</strong>
              <span className="oaw-canvas-export-sub">画布级版本 · {历史列表.length} 条</span>
              <button type="button" className="btn-xs" onClick={() => set历史面板(false)} aria-label="关闭版本历史"><Icon name="close" size={12} /></button>
            </div>
            <div className="oaw-canvas-export-body">
              <div className="oaw-canvas-history-scope">
                <span>恢复范围</span>
                <select className="oaw-canvas-field" value={版本恢复范围} onChange={(事件) => set版本恢复范围(事件.target.value)} aria-label="恢复范围">
                  <option value="canvas">整张画布</option>
                  <option value="board" disabled={!当前板路径}>当前板{当前板路径 ? `（${默认板标题(当前板路径)}）` : "（未选择）"}</option>
                </select>
              </div>
              {版本差异 && (
                <div className="oaw-canvas-history-diff">
                  <div className="oaw-canvas-history-diff-head">
                    <strong>版本 #{版本差异.n} → 当前</strong>
                    <button type="button" className="btn-xs" onClick={() => set版本差异(null)}>收起</button>
                  </div>
                  <div className="oaw-canvas-history-diff-body">
                    {版本差异.added?.length ? <div>新增：{版本差异.added.join("、")}</div> : null}
                    {版本差异.modified?.length ? <div>修改：{版本差异.modified.join("、")}</div> : null}
                    {版本差异.removed?.length ? <div>删除：{版本差异.removed.join("、")}</div> : null}
                    {!版本差异.added?.length && !版本差异.modified?.length && !版本差异.removed?.length ? <div>与当前内容一致。</div> : null}
                  </div>
                </div>
              )}
              {历史载入中 ? (
                <div className="oaw-canvas-history-empty">正在读取版本时间线…</div>
              ) : 历史错误 ? (
                <div className="oaw-canvas-history-empty" style={{ color: "var(--error)" }}>{历史错误}</div>
              ) : !历史列表.length ? (
                <div className="oaw-canvas-history-empty">还没有画布级版本。每次保存/Agent 写入会按批次合并成一条版本（最近 20 条不清理）。</div>
              ) : 历史列表.map((项) => (
                <div className="oaw-canvas-history-item" key={项.n}>
                  <div className="oaw-canvas-history-item-main">
                    <span className="oaw-canvas-history-time">#{项.n} · {项.at ? new Date(项.at).toLocaleString() : "未知时间"}</span>
                    <span className="oaw-canvas-history-meta">
                      {项.by === "agent" ? "Agent" : 项.by === "system" ? "系统" : "用户"}
                      {项.runId ? ` · ${String(项.runId).slice(0, 12)}` : ""}
                      {` · ${项.changes?.length || 0} 个文件`}
                      {项.restoredFrom ? ` · 恢复自 #${项.restoredFrom}` : ""}
                      {项.summary ? ` · ${项.summary}` : ""}
                    </span>
                  </div>
                  <div className="oaw-canvas-page-actions">
                    <button type="button" className="btn-xs" onClick={() => 查看版本差异(项)} disabled={版本差异中 === `diff-${项.n}`}>
                      {版本差异中 === `diff-${项.n}` ? "对比中…" : "对比当前"}
                    </button>
                    <button type="button" className="btn-xs" onClick={() => 恢复历史(项)} disabled={只读 || 历史恢复中 === `v-${项.n}`}>
                      {历史恢复中 === `v-${项.n}` ? "恢复中…" : "恢复"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="oaw-canvas-export-actions">
              <button type="button" className="btn-xs" onClick={载入历史} disabled={历史载入中}>刷新</button>
              <button type="button" className="btn-xs" onClick={() => set历史面板(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {导出面板 && 计划 && (
        <div className="oaw-canvas-export" role="dialog" aria-modal="true" aria-label="导出创作画布">
          <div className="oaw-canvas-export-card">
            <div className="oaw-canvas-export-head">
              <Icon name="download" size={14} />
              <strong>导出画布</strong>
              <span className="oaw-canvas-export-sub">{计划.total} 块板</span>
              <button type="button" className="btn-xs" onClick={() => set导出面板(false)} aria-label="关闭导出对话框">
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="oaw-canvas-export-body">
              <div className="oaw-canvas-export-row">
                <span className="oaw-canvas-inspector-label">格式</span>
                <div className="oaw-canvas-export-formats" role="radiogroup" aria-label="导出格式">
                  {导出格式.map((项) => {
                    const 启用 = Boolean(计划.formats[项.值]?.enabled);
                    return (
                      <button
                        key={项.值}
                        type="button"
                        role="radio"
                        aria-checked={导出格式值 === 项.值}
                        className={`oaw-canvas-export-option ${导出格式值 === 项.值 ? "active" : ""}`}
                        disabled={!启用}
                        onClick={() => set导出格式值(项.值)}
                        title={计划.formats[项.值]?.reason || 项.说明}
                      >
                        <strong>{项.名称}</strong>
                        <span>{项.说明}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="oaw-canvas-export-row">
                <span className="oaw-canvas-inspector-label">范围</span>
                <select className="oaw-canvas-field" value={导出范围} onChange={(事件) => set导出范围(事件.target.value)} aria-label="导出范围">
                  <option value="全部板">全部板（{计划.total}）</option>
                  <option value="当前板" disabled={!当前板路径}>当前板</option>
                </select>
              </label>
              <p className="oaw-canvas-export-note">{当前格式.reason}</p>
              {计划.hasImagePage && <p className="oaw-canvas-export-note warn">{计划.note}</p>}
              {导出结果 && <p className="oaw-canvas-export-result" role="status">{导出结果}</p>}
            </div>
            <div className="oaw-canvas-export-actions">
              <button type="button" className="btn-xs" onClick={() => set导出面板(false)}>取消</button>
              <button type="button" className="btn-xs" onClick={执行导出} disabled={!当前格式.enabled || 导出进行}>
                {导出进行 ? "导出中…" : "开始导出"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
