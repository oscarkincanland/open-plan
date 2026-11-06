/**
 * 内嵌浏览器视图桥（平台适配层，ADR 0024 §6）。
 *
 * 桌面宿主下，内置浏览器页面由 Electron `WebContentsView` 原生渲染，
 * 渲染进程需要做两件事：
 *   1. 把面板在窗口中的矩形上报给主进程（视图按该矩形摆位）；
 *   2. 面板不可见时通知隐藏（避免原生视图浮在别的页签上）。
 *
 * web 形态下 `window.__OAW_HOST__.browser` 不存在 → 所有函数降级为 no-op，
 * 面板继续走原来的帧流渲染（行为零变化）。
 */

import { hostBridge } from "./宿主.js";

/** 是否内嵌视图模式（桌面宿主且 preload 暴露了 browser 通道）。 */
export function 是内嵌浏览器视图() {
  const bridge = hostBridge();
  return Boolean(bridge?.isDesktop && bridge?.browser);
}

/** 会话键：与 server/内置浏览器.mjs 的 browserSessionKey 保持一致（client::thread）。 */
export function 浏览器会话键(clientId, threadId) {
  const client = String(clientId || "").trim();
  const thread = String(threadId || "").trim();
  const key = `${client}::${thread}`;
  return key;
}

/**
 * 上报面板矩形（CSS 像素，相对窗口左上角）。
 * @param {string} key 会话键
 * @param {{x:number,y:number,width:number,height:number}} rect
 */
export async function 上报视图边界(key, rect) {
  const bridge = hostBridge();
  if (!bridge?.browser?.setBounds) return false;
  try {
    const result = await bridge.browser.setBounds(key, rect);
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

/** 设置内嵌视图可见性（面板切走/隐藏时调用）。 */
export async function 设置视图可见(key, visible) {
  const bridge = hostBridge();
  if (!bridge?.browser?.setVisible) return false;
  try {
    const result = await bridge.browser.setVisible(key, Boolean(visible));
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}
