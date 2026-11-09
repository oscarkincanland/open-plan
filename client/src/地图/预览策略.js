/**
 * 地图预览决策纯函数（无 React 依赖，供 App 与 Node 测试复用）。
 *
 * 背景（2026-11-09 计划 §4.1）：早期“是否打开地图预览”被绑定在“画布是否为空”上，
 * 画布通常已有产物/文档标签，于是点击地图会话时静默跳过；同时多会话切换时
 * 预览 payload 只比较项目名，会留下旧会话的视口。这里把规则收敛成一个纯函数：
 *
 *   - 会话无 mapProject：有预览就关闭，否则什么都不做；
 *   - 会话有 mapProject：没有预览就打开（是否激活只取决于 userInitiated）；
 *   - 已有预览且 payload 相同：不动，避免无意义重挂；
 *   - 已有预览但项目/视口/会话变化：同步 payload（update）。
 *
 * 显式点击（userInitiated=true）由调用方传 true 并激活标签；agent 事件、文件变更、
 * 会话列表刷新等被动路径传 false，只补建/同步，不抢用户正在看的文档。
 */

const VIEW_KEYS = ["center", "zoom", "bounds", "regionName", "updatedAt"];

function toProject(value) {
  return String(value || "").trim();
}

/** 归一化视口：只比较可持久化白名单字段，避免临时层等噪声触发 update。 */
export function normalizePreviewView(view) {
  if (!view || typeof view !== "object") return null;
  const out = {};
  for (const key of VIEW_KEYS) {
    const value = view[key];
    if (value === undefined || value === null) continue;
    if (key === "center" && Array.isArray(value) && value.length === 2) out.center = [Number(value[0]), Number(value[1])];
    else if (key === "zoom" && Number.isFinite(Number(value))) out.zoom = Number(value);
    else if (key === "bounds" && Array.isArray(value) && value.length === 4) out.bounds = value.map((item) => Number(item));
    else if (key === "regionName" && typeof value === "string") out.regionName = value;
    else if (key === "updatedAt" && Number.isFinite(Number(value))) out.updatedAt = Number(value);
  }
  return Object.keys(out).length ? out : null;
}

function sameView(a, b) {
  const left = normalizePreviewView(a);
  const right = normalizePreviewView(b);
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 预览 payload 相等判定：项目 / 会话 / 视口（含 updatedAt）三者都相同才算同一次。 */
export function sameMapPreviewPayload(left, right) {
  if (!left || !right) return false;
  if (toProject(left.project) !== toProject(right.project)) return false;
  if (String(left.sessionId || "") !== String(right.sessionId || "")) return false;
  return sameView(left.view, right.view);
}

/** 由会话构造预览 payload：view 缺省为 null（会话没有记录视口时交给地图默认相机）。 */
export function buildMapPreviewPayload(session) {
  return {
    project: toProject(session?.mapProject),
    view: session?.mapView && typeof session.mapView === "object" ? session.mapView : null,
    sessionId: String(session?.id || ""),
  };
}

/**
 * 解析地图预览动作。
 *
 * @param {object} input
 * @param {object|null} input.session 当前会话（含 id / mapProject / mapView）
 * @param {object|null} input.previewTab 当前“地图预览”标签（单例；无则 null）
 * @param {boolean} [input.userInitiated] 是否用户显式点击（显式点击才激活标签）
 * @returns {{type: "close"} |
 *   {type: "none"} |
 *   {type: "open", payload: object, activate: boolean} |
 *   {type: "update", payload: object, activate: boolean}}
 */
export function resolveMapPreviewAction({ session, previewTab, userInitiated = false } = {}) {
  // 只认真正的 mapPreview 标签；调用方误传其它标签时按“没有预览”处理。
  const kind = previewTab?.kind;
  const preview = previewTab && (!kind || kind === "mapPreview") ? previewTab : null;
  const project = toProject(session?.mapProject);
  if (!project) return preview ? { type: "close" } : { type: "none" };
  const payload = buildMapPreviewPayload(session);
  const activate = Boolean(userInitiated);
  if (!preview) return { type: "open", payload, activate };
  if (sameMapPreviewPayload(preview.payload, payload)) return { type: "none" };
  return { type: "update", payload, activate };
}
