/**
 * 会话地图上下文纯函数（无 React 依赖，供 App 与 Node 测试复用）。
 *
 * 背景：MapViewer 的视口上报只包含 center/zoom/bounds/updatedAt，
 * 早期 App 用整条视口对象覆盖 mapContexts，导致 mapProject 被抹掉、
 * 回落到默认 zhejiang-map，Agent 因此继续操作旧项目。
 * 这里统一做白名单合并：视口字段可更新，地图项目始终保留。
 */

const VIEW_KEYS = ["center", "zoom", "bounds", "regionName", "updatedAt"];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toFiniteNumber(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

/** 仅保留合法视口字段，忽略任意其它键（含临时层等不可持久化内容）。 */
export function normalizeMapView(view = {}) {
  if (!view || typeof view !== "object") return {};
  const out = {};
  if (Array.isArray(view.center) && view.center.length === 2) {
    const center = view.center.map(toFiniteNumber);
    if (center.every((n) => n !== null)) out.center = center;
  }
  if (isFiniteNumber(view.zoom)) out.zoom = view.zoom;
  else {
    const zoom = toFiniteNumber(view.zoom);
    if (zoom !== null) out.zoom = zoom;
  }
  if (Array.isArray(view.bounds) && view.bounds.length === 4) {
    const bounds = view.bounds.map(toFiniteNumber);
    if (bounds.every((n) => n !== null)) out.bounds = bounds;
  }
  if (typeof view.regionName === "string") out.regionName = view.regionName.slice(0, 80);
  if (isFiniteNumber(view.updatedAt)) out.updatedAt = view.updatedAt;
  return out;
}

/**
 * 合并会话地图上下文：视口字段取并集，mapProject 只接受显式项目值，
 * 不会被纯视口上报覆盖。
 * @param {object} prev 会话已有上下文
 * @param {object} next 新上报的上下文（可含 mapProject 或 project）
 */
export function mergeMapContext(prev = {}, next = {}) {
  const base = prev && typeof prev === "object" ? prev : {};
  const incoming = next && typeof next === "object" ? next : {};
  const merged = { ...normalizeMapView(base), ...normalizeMapView(incoming) };
  const incomingProject = String(incoming.mapProject || incoming.project || "").trim();
  const baseProject = String(base.mapProject || "").trim();
  merged.mapProject = incomingProject || baseProject;
  return merged;
}

/** 供测试与调用方确认白名单字段。 */
export const MAP_CONTEXT_VIEW_KEYS = [...VIEW_KEYS];
