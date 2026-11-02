/**
 * 工作区画布标签状态（浏览器式标签）。
 *
 * 纯函数 + localStorage 持久化，不依赖 React：
 * - doc 标签按文件身份去重，可多实例；
 * - artifacts / changes / browser / objects / workflows 为单例；
 * - subagent 为临时标签，不持久化；
 * - 关闭当前标签后优先选右邻，再选左邻；
 * - 只持久化标签身份，不持久化文档正文。
 */

export const MAX_CANVAS_TABS = 12;
export const CANVAS_STORAGE_KEY = "oaw_canvas_v2";
export const CANVAS_WIDTH_KEY = "oaw_canvas_w";
export const CANVAS_SIDE_WIDTH_KEY = "oaw_canvas_side_w";

export const SINGLETON_TAB_KINDS = new Set(["artifacts", "changes", "browser", "objects", "workflows", "mapPreview"]);


const VIEW_META = Object.freeze({
  artifacts: { title: "工作产物", icon: "package" },
  changes: { title: "改动", icon: "history" },
  browser: { title: "浏览器", icon: "globe" },
  objects: { title: "对象", icon: "layers" },
  workflows: { title: "工作流", icon: "flow" },
  mapPreview: { title: "地图预览", icon: "map" },
  subagent: { title: "子代理", icon: "robot" },
});

export function viewTabMeta(kind) {
  return VIEW_META[kind] || { title: kind || "视图", icon: "file" };
}

export function docTabId(docId) {
  return `doc:${String(docId || "")}`;
}

export function createDocTab(docId, title = "") {
  const id = docTabId(docId);
  return {
    id,
    kind: "doc",
    docId: String(docId || ""),
    title: String(title || "未命名文件"),
    icon: "file",
    closable: true,
    payload: { docId: String(docId || ""), name: String(title || "") },
  };
}

export function createViewTab(kind, payload = {}) {
  const meta = viewTabMeta(kind);
  return {
    id: `view:${kind}`,
    kind,
    title: meta.title,
    icon: meta.icon,
    closable: true,
    payload: { ...payload },
  };
}

export function createSubagentTab(block = {}) {
  const childId = String(block?.id || block?.childId || "");
  return {
    id: `subagent:${childId || Math.random().toString(36).slice(2)}`,
    kind: "subagent",
    title: block?.role || block?.label || "子代理",
    icon: "robot",
    closable: true,
    payload: { block },
  };
}

function isSingleton(kind) {
  return SINGLETON_TAB_KINDS.has(String(kind || ""));
}

function sameTab(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.kind === "doc" && b.kind === "doc") return a.docId && a.docId === b.docId;
  return isSingleton(a.kind) && a.kind === b.kind;
}

/** 打开/聚焦标签。单例与同一文档只保留一份；超过上限时保留最近打开的标签。 */
export function openCanvasTab(tabs = [], tab) {
  if (!tab?.id || !tab?.kind) return { tabs: [...tabs], activeId: "" };
  const list = Array.isArray(tabs) ? [...tabs] : [];
  const index = list.findIndex((item) => sameTab(item, tab));
  if (index >= 0) {
    list[index] = { ...list[index], ...tab, id: list[index].id, payload: { ...list[index].payload, ...tab.payload } };
    return { tabs: list, activeId: list[index].id };
  }
  list.push(tab);
  const trimmed = list.length > MAX_CANVAS_TABS ? list.slice(list.length - MAX_CANVAS_TABS) : list;
  return { tabs: trimmed, activeId: tab.id };
}

/** 关闭标签并返回下一个应激活的标签。 */
export function closeCanvasTab(tabs = [], activeId = "", id = "") {
  const list = Array.isArray(tabs) ? tabs : [];
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return { tabs: list, activeId };
  const next = list.filter((item) => item.id !== id);
  if (activeId !== id) return { tabs: next, activeId };
  const neighbor = next[index] || next[index - 1] || null;
  return { tabs: next, activeId: neighbor?.id || "" };
}

export function activateCanvasTab(tabs = [], id = "") {
  return (Array.isArray(tabs) ? tabs : []).some((item) => item.id === id) ? id : "";
}

export function reorderCanvasTabs(tabs = [], fromId = "", toId = "") {
  const list = Array.isArray(tabs) ? [...tabs] : [];
  const from = list.findIndex((item) => item.id === fromId);
  const to = list.findIndex((item) => item.id === toId);
  if (from < 0 || to < 0 || from === to) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSide(side) {
  const kind = side?.kind === "files" ? "files" : null;
  return {
    kind,
    width: clamp(side?.width, 200, 340, 260),
  };
}

function sanitizeTab(tab) {
  if (!tab || typeof tab !== "object") return null;
  const kind = String(tab.kind || "");
  if (kind === "doc") {
    const docId = String(tab.docId || tab.payload?.docId || "");
    if (!docId) return null;
    return {
      id: docTabId(docId),
      kind: "doc",
      docId,
      title: String(tab.title || tab.payload?.name || "未命名文件"),
      icon: "file",
      closable: true,
      payload: { docId, name: String(tab.payload?.name || tab.title || "") },
    };
  }
  if (kind === "subagent") return null; // 临时标签不恢复
  if (kind === "mapPreview") return null; // 会话地图预览跟随当前会话，不跨会话恢复
  if (!VIEW_META[kind]) return null;
  return {
    ...createViewTab(kind, tab.payload || {}),
    title: String(tab.title || viewTabMeta(kind).title),
  };
}

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try { localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(all)); } catch {}
}

export function loadCanvasState(workspace = "") {
  const entry = workspace ? readAll()[workspace] : null;
  const tabs = Array.isArray(entry?.tabs) ? entry.tabs.map(sanitizeTab).filter(Boolean).slice(-MAX_CANVAS_TABS) : [];
  const activeId = tabs.some((tab) => tab.id === entry?.activeId) ? entry.activeId : (tabs[tabs.length - 1]?.id || "");
  let width = 420;
  let sideWidth = 260;
  try {
    width = clamp(localStorage.getItem(CANVAS_WIDTH_KEY), 320, 760, 420);
    sideWidth = clamp(localStorage.getItem(CANVAS_SIDE_WIDTH_KEY), 200, 340, 260);
  } catch {}
  return {
    tabs,
    activeId,
    collapsed: false,
    maximized: Boolean(entry?.maximized),
    side: sanitizeSide(entry?.side),
    width,
    sideWidth,
  };
}

export function saveCanvasState(workspace = "", state = {}) {
  if (!workspace) return;
  const all = readAll();
  const tabs = (Array.isArray(state.tabs) ? state.tabs : [])
    .filter((tab) => tab?.kind !== "subagent")
    .map(sanitizeTab)
    .filter(Boolean)
    .slice(-MAX_CANVAS_TABS);
  const activeId = tabs.some((tab) => tab.id === state.activeId) ? state.activeId : (tabs[tabs.length - 1]?.id || "");
  all[workspace] = {
    tabs,
    activeId,
    maximized: Boolean(state.maximized),
    side: sanitizeSide(state.side),
  };
  writeAll(all);
  try {
    localStorage.setItem(CANVAS_WIDTH_KEY, String(clamp(state.width, 320, 760, 420)));
    localStorage.setItem(CANVAS_SIDE_WIDTH_KEY, String(clamp(state.sideWidth, 200, 340, 260)));
  } catch {}
}

export function saveCanvasWidth(width, sideWidth) {
  try {
    localStorage.setItem(CANVAS_WIDTH_KEY, String(clamp(width, 320, 760, 420)));
    if (sideWidth !== undefined) localStorage.setItem(CANVAS_SIDE_WIDTH_KEY, String(clamp(sideWidth, 200, 340, 260)));
  } catch {}
}
