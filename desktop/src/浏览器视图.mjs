/**
 * 桌面端内置浏览器：原生视图宿主（ADR 0024 §6 方案 B）。
 *
 * 职责：给 server 侧的浏览器业务逻辑提供**CDP 传输**，并把页面画进窗口。
 *   - 传输：Electron `webContents.debugger`（同一套 CDP 命令，无 WebSocket）；
 *   - 画面：`WebContentsView` 原生渲染 → 不需要 screencast/SSE/base64 帧流。
 *
 * 与 web 形态的关系：
 *   server/内置浏览器.mjs 只依赖 transport 契约（ready / send / on / close），
 *   因此同一套 browser_* 工具（open/snapshot/click/type/screenshot…）在两端完全一致。
 *
 * 注意：本文件属于「壳」，可以 import electron；它通过
 * `server/平台/浏览器驱动.mjs` 的注册点注入，server 侧不感知 electron。
 */

const { WebContentsView, session } = require("electron");
const path = require("node:path");

/** key -> { view, webContents, session } */
const views = new Map();

/** 把 Electron debugger 包成 server 期望的 transport 契约。 */
function createTransport(webContents) {
  const handlers = new Map();
  const onDebuggerMessage = (_event, method, params) => {
    const set = handlers.get(method);
    if (set) for (const fn of [...set]) { try { fn(params); } catch {} }
  };

  let attached = false;
  const ready = (async () => {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }
    attached = true;
    webContents.debugger.on("message", onDebuggerMessage);
  })();

  return {
    ready,
    sessionId: null,
    async send(method, params = {}) {
      await ready;
      return webContents.debugger.sendCommand(method, params || {});
    },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    close() {
      try {
        if (attached && webContents.debugger.isAttached()) {
          webContents.debugger.removeListener("message", onDebuggerMessage);
          webContents.debugger.detach();
        }
      } catch {}
      attached = false;
      handlers.clear();
    },
  };
}

/**
 * 宿主实现（由 desktop/src/main.cjs 在服务启动后注入）。
 * @param {{getWindow: () => import('electron').BrowserWindow|null}} options
 */
function createEmbeddedBrowserHost(options) {
  const getWindow = options.getWindow;

  return {
    kind: "embedded",
    supportsScreencast: false,

    async attach(key) {
      const win = getWindow();
      if (!win) throw Object.assign(new Error("桌面窗口尚未就绪"), { code: "BROWSER_HOST_NOT_READY" });

      const existing = views.get(key);
      if (existing && !existing.webContents.isDestroyed()) {
        return createTransport(existing.webContents);
      }

      // 每个会话独立 partition：保留登录态，且与用户日常浏览器隔离（对应 web 端的独立 profile）
      const partition = `persist:oaw-browser-${String(key).replace(/[^\w-]/g, "_").slice(0, 40)}`;
      const browserSession = session.fromPartition(partition);
      const view = new WebContentsView({
        webPreferences: {
          session: browserSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          javascript: true,
        },
      });
      view.setBackgroundColor("#ffffff");
      win.contentView.addChildView(view);
      // 初始尺寸为 0：等渲染进程上报面板边界后再显示，避免遮挡页面
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

      views.set(key, { view, webContents: view.webContents, browserSession });
      const transport = createTransport(view.webContents);
      // 页面加载完成后再返回 transport，保证首条 command 不会早于文档提交
      await transport.ready;
      return transport;
    },

    async detach(key) {
      const entry = views.get(key);
      if (!entry) return;
      const win = getWindow();
      try { win?.contentView.removeChildView(entry.view); } catch {}
      try {
        if (entry.webContents.debugger.isAttached()) entry.webContents.debugger.detach();
      } catch {}
      try { entry.webContents.close(); } catch {}
      views.delete(key);
    },

    /** 渲染进程上报面板矩形（CSS 像素；Electron 已按缩放比换算到窗口坐标）。 */
    async setBounds(key, bounds) {
      const entry = views.get(key);
      if (!entry) return false;
      const { x = 0, y = 0, width = 0, height = 0 } = bounds || {};
      const safe = {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
      };
      entry.view.setBounds(safe);
      entry.view.setVisible(safe.width > 0 && safe.height > 0);
      // 同步视口，让页面按面板真实尺寸排版（替代 web 端的 browserResize）
      try { entry.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: Math.max(320, safe.width),
        height: Math.max(240, safe.height),
        deviceScaleFactor: 1,
        mobile: false,
      }); } catch {}
      return true;
    },

    async setVisible(key, visible) {
      const entry = views.get(key);
      if (!entry) return false;
      entry.view.setVisible(Boolean(visible));
      return true;
    },

    /** 关窗/退出时统一清理全部视图。 */
    async disposeAll() {
      for (const key of [...views.keys()]) {
        try { await this.detach(key); } catch {}
      }
    },
  };
}

module.exports = { createEmbeddedBrowserHost };
