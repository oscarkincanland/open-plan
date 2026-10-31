/**
 * 会话地图上下文（服务端校验）
 *
 * 只持久化视口白名单字段与项目名，避免把临时层、要素内容等写进会话 header。
 * 与 client/src/地图/地图上下文.js 的 normalizeMapView 保持同一语义。
 */

function toFiniteNumber(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

export function normalizeMapView(view = {}) {
  if (!view || typeof view !== "object") return {};
  const out = {};
  if (Array.isArray(view.center) && view.center.length === 2) {
    const center = view.center.map(toFiniteNumber);
    if (center.every((item) => item !== null)) out.center = center;
  }
  const zoom = toFiniteNumber(view.zoom);
  if (zoom !== null) out.zoom = zoom;
  if (Array.isArray(view.bounds) && view.bounds.length === 4) {
    const bounds = view.bounds.map(toFiniteNumber);
    if (bounds.every((item) => item !== null)) out.bounds = bounds;
  }
  if (typeof view.regionName === "string") out.regionName = view.regionName.slice(0, 80);
  if (typeof view.updatedAt === "number" && Number.isFinite(view.updatedAt)) out.updatedAt = view.updatedAt;
  return out;
}

/** 生成可写入 session header 的补丁；mapProject 为空表示不绑定项目。 */
export function buildMapContextPatch(body = {}) {
  const mapProject = String(body?.mapProject || "").trim().slice(0, 64);
  return { mapProject, mapView: normalizeMapView(body?.mapView) };
}
