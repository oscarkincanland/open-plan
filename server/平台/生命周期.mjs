/**
 * 生命周期钩子（平台适配层，ADR 0024）。
 *
 * web 形态：`scripts/服务监督.mjs` 负责起停与重启，本模块注册的钩子为空实现；
 * 桌面形态：Electron 主进程持有服务，退出前需要有序关闭（停子进程、落盘会话、关浏览器）。
 *
 * 用法（server/index.mjs 挂点）：
 *   import { onShutdown } from "./平台/生命周期.mjs";
 *   onShutdown(async () => { await browserModule.shutdownBrowsers(); });
 */

const shutdownHooks = [];
let shuttingDown = false;

/**
 * 注册退出前回调（按注册顺序执行，单个失败不影响其余）。
 * @param {() => Promise<void>|void} handler
 * @returns {() => void} 反注册
 */
export function onShutdown(handler) {
  if (typeof handler !== "function") return () => {};
  shutdownHooks.push(handler);
  return () => {
    const index = shutdownHooks.indexOf(handler);
    if (index >= 0) shutdownHooks.splice(index, 1);
  };
}

/** 是否已进入退出流程（供业务侧避免重复清理）。 */
export function isShuttingDown() {
  return shuttingDown;
}

/**
 * 执行全部退出钩子（幂等）。桌面端主进程在 `before-quit` 里调用；
 * web 形态由服务监督在收到 SIGTERM 时调用。
 */
export async function runShutdownHooks(timeoutMs = 8000) {
  if (shuttingDown) return { executed: 0, failures: 0, skipped: true };
  shuttingDown = true;
  let failures = 0;
  const handlers = shutdownHooks.splice(0, shutdownHooks.length);
  for (const handler of handlers) {
    try {
      await Promise.race([
        Promise.resolve(handler()),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      failures += 1;
    }
  }
  return { executed: handlers.length, failures, skipped: false };
}
