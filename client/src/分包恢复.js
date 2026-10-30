/**
 * 分包失效自动恢复。
 *
 * 场景：服务端重新构建前端后，旧的 chunk 文件名（带内容哈希）已不存在，
 * 而用户页面仍是上一版 JS，此时按需加载组件会 404，界面表现为
 * “组件加载失败 / 正在加载 XX…卡住”。这里统一识别这类错误并自动刷新一次，
 * 让用户不必手动 F5（60 秒内只自动恢复一次，避免任何情况下的刷新死循环）。
 */

const RELOAD_AT_KEY = "oaw_chunk_reload_at";
const RAPID_RELOAD_WINDOW_MS = 60_000;
export const STALE_CHUNK_PATTERN = /dynamically imported module|Importing a module script failed|Loading chunk \d+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

/** 该错误是否属于“分包已过期/加载失败”（而非组件自身逻辑错误）。 */
export function isStaleChunkError(error) {
  return STALE_CHUNK_PATTERN.test(String(error?.message || error || ""));
}

/** 自动刷新一次以加载最新前端；返回 false 表示刚恢复过、本次不再刷新。 */
export function recoverFromStaleChunk(reason = "") {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_AT_KEY) || 0);
    if (Date.now() - last < RAPID_RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {}
  console.warn("[oaw] 前端分包与页面版本不一致（通常是服务端已重新构建），自动刷新加载最新前端：", reason);
  window.location.reload();
  return true;
}

/** 在应用入口安装全局兜底：Vite 预加载失败、动态 import 失败、脚本加载失败。 */
export function installStaleChunkRecovery() {
  window.addEventListener("vite:preloadError", (event) => {
    try { event.preventDefault(); } catch {}
    recoverFromStaleChunk(event?.payload?.message || "vite:preloadError");
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (isStaleChunkError(event?.reason)) recoverFromStaleChunk(String(event?.reason?.message || event?.reason));
  });
  window.addEventListener("error", (event) => {
    const message = String(event?.message || event?.error?.message || "");
    if (STALE_CHUNK_PATTERN.test(message)) recoverFromStaleChunk(message);
  });
}
