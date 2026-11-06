/**
 * 浏览器驱动注册表（平台适配层，ADR 0024 §6）。
 *
 * 背景：同一个「内置浏览器」能力，两种宿主下画面来源完全不同——
 *   system   （web）：spawn 系统 Edge/Chrome → CDP → screencast JPEG → SSE 帧流；
 *   embedded （桌面）：Electron WebContentsView 原生渲染，页面直接画在窗口里，**不需要帧流**。
 *
 * 两者**共用同一套 CDP 命令**（Page.navigate / Runtime.evaluate / Input.* / captureScreenshot），
 * 差别只在「传输」与「画面」：
 *   - 传输：WebSocket ↔ webContents.debugger（同一套 send/on 语义）
 *   - 画面：screencast 帧流 ↔ 原生视图（宿主自己渲染）
 *
 * 因此本模块只定义「传输注入点」与「画面能力声明」，不 import electron、
 * 也不承载任何浏览器业务逻辑（业务仍在 server/内置浏览器.mjs）。
 *
 * 桌面主进程在启动服务后调用 installEmbeddedBrowserHost()，把原生视图实现注入。
 * web 形态不注入 → 自动走 system，行为与历史逐字一致。
 */

/** 当前注入的桌面宿主（null = web 形态）。 */
let embeddedHost = null;

/**
 * 桌面宿主契约（由 desktop/src/浏览器视图.mjs 实现，server 侧只调这些）：
 * {
 *   kind: "embedded",
 *   supportsScreencast: false,              // 原生视图不需要帧流
 *   async attach(sessionKey): transport,    // 创建/复用视图并返回 CDP 传输
 *   async detach(sessionKey): void,         // 释放视图
 *   async setBounds(sessionKey, bounds): void, // 渲染进程上报的面板位置
 *   async setVisible(sessionKey, visible): void,
 * }
 *
 * transport 契约（与 CdpConnection 同构，供 BrowserSession 直接使用）：
 * {
 *   ready: Promise<void>,
 *   sessionId: null,
 *   send(method, params): Promise<object>,
 *   on(event, handler): () => void,
 *   close(): void,
 * }
 */

/** 注入桌面宿主实现（只能调用一次；重复调用覆盖以便热更新）。 */
export function installEmbeddedBrowserHost(host) {
  if (!host || typeof host.attach !== "function") {
    throw new Error("installEmbeddedBrowserHost 需要实现 attach() 的宿主对象");
  }
  embeddedHost = host;
}

/** 是否已注入桌面宿主。 */
export function hasEmbeddedBrowserHost() {
  return Boolean(embeddedHost);
}

/** 取桌面宿主（未注入返回 null）。 */
export function getEmbeddedBrowserHost() {
  return embeddedHost;
}

/** 当前驱动类型：桌面注入了宿主 → embedded；否则 system。 */
export function currentBrowserDriver() {
  const explicit = String(process.env.OAW_BROWSER_DRIVER || "").trim().toLowerCase();
  if (explicit === "system") return "system";
  if (explicit === "embedded") return embeddedHost ? "embedded" : "system";
  return embeddedHost ? "embedded" : "system";
}
