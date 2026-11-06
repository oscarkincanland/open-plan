/**
 * 工具展示映射（verb / icon）的客户端登记处。
 *
 * 唯一事实源在 `server/工具元数据.mjs` 的 `presentation`（随 /api/harness/tools 下发）。
 * 这里只做"服务端元数据 → 前端可查询"的薄缓存；服务端未下发（离线、旧服务端、历史会话）
 * 时返回 null，由调用方回落到 ChatPanel / 事件展示 里的内置映射。
 *
 * 为什么要有这一层：此前 `toolPhrase`（ChatPanel.jsx）与 `toolIdentity`（事件展示.js）
 * 各维护一份工具名映射，新增工具会退化成「调用 xxx」或通用图标。
 */
let registry = new Map();

/** 应用服务端下发的工具元数据列表；返回已登记的条数。 */
export function applyToolMetadata(list) {
  const next = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const presentation = item?.presentation;
    if (!presentation || (!presentation.verb && !presentation.icon)) continue;
    next.set(name, {
      verb: presentation.verb ? String(presentation.verb) : "",
      icon: presentation.icon ? String(presentation.icon) : "",
    });
  }
  registry = next;
  return registry.size;
}

/** 查询某个工具的展示信息；未登记返回 null（调用方回落内置映射）。 */
export function toolPresentationOf(name) {
  return registry.get(String(name || "").trim()) || null;
}

/** 已登记的工具名（测试与调试用）。 */
export function toolPresentationNames() {
  return [...registry.keys()];
}
