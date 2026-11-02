/**
 * 标签页标识（长连接键的唯一来源）。
 *
 * 两类 id 各司其职，不要混用：
 *
 *   - getTabId()：sessionStorage 生成，刷新后稳定。仅用于 SSE 查询参数 tab=
 *     （服务端据此做流去重）。**不参与会话/游标身份**，避免影响既有数据。
 *     注意：浏览器"复制标签页"会克隆 sessionStorage，此时两个标签页拿到同一个 id；
 *     该 id 只做流去重键，重复的后果是服务端少建一条流，不会写坏数据。
 *
 *   - getQuotaTabId()：window.name 生成，按浏览上下文隔离，跨标签页流配额登记用。
 *     window.name 在同源导航后保留，刷新不变；跨标签页各拿各的。
 *     跨标签页流租约.js 的 leader 选举也复用它，避免两个模块各写一份 window.name。
 */

/** SSE 查询参数 tab= 用的标签页 id（sessionStorage，刷新后稳定）。 */
export function getTabId() {
  try {
    let id = sessionStorage.getItem("oaw_tab_id");
    if (!id) {
      id = "tab-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("oaw_tab_id", id);
    }
    return id;
  } catch {
    return "tab-default";
  }
}

/** 跨标签页流配额登记用的标签页 id（window.name，按浏览上下文隔离）。 */
export function getQuotaTabId() {
  try {
    const existing = typeof window !== "undefined" ? String(window.name || "") : "";
    if (existing.startsWith("oaw-tab-")) return existing;
    const id = `oaw-tab-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    if (typeof window !== "undefined") window.name = id;
    return id;
  } catch {
    return `oaw-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
