/**
 * 宿主能力探测（平台适配层，ADR 0024）。
 *
 * 业务代码只问「能力有没有」，不问「是不是桌面」：
 *   if (平台能力.原生文件对话框) … 而不是 if (isDesktop) …
 *
 * 浏览器形态下 preload 不注入 window.__OAW_HOST__，所有原生能力自然为 false，
 * 调用方按各自回退路径执行（<input type=file> / 服务端接口）。
 */

/** 读取 preload 注入的宿主桥（不存在即浏览器形态）。 */
export function hostBridge() {
  if (typeof window === "undefined") return null;
  return window.__OAW_HOST__ || null;
}

/** 是否桌面宿主。 */
export function isDesktopHost() {
  return Boolean(hostBridge()?.isDesktop);
}

/** 能力表：每一项都是「有没有」，不是「什么形态」。 */
export const 平台能力 = {
  get 原生文件对话框() { return typeof hostBridge()?.openFile === "function"; },
  get 原生目录对话框() { return typeof hostBridge()?.openDirectory === "function"; },
  get 系统打开文件() { return typeof hostBridge()?.openPath === "function"; },
  get 文件管理器定位() { return typeof hostBridge()?.showItemInFolder === "function"; },
  /** 桌面端内置浏览器走原生视图（无帧流）；浏览器端走系统 Edge + CDP。 */
  get 内嵌浏览器视图() { return Boolean(hostBridge()?.isDesktop); },
};

/** 宿主信息（异步，仅在桌面宿主可用）。 */
export async function 宿主信息() {
  const bridge = hostBridge();
  if (!bridge?.info) return null;
  try { return await bridge.info(); } catch { return null; }
}

/** 等待主进程下发服务地址（端口 + token），浏览器形态立即返回 null。 */
export function onHostReady(callback) {
  const bridge = hostBridge();
  if (!bridge?.onReady) return () => {};
  return bridge.onReady(callback) || (() => {});
}
