/**
 * Electron 主进程入口（ADR 0024「壳优先」）。
 *
 * 为什么用 CJS 而不是 ESM：Electron 33 的 ESM 主进程在加载内置 `electron`
 * 模块时会触发 `cjsPreparseModuleExports` 崩溃（`module.exports` 为 undefined），
 * 属于运行时兼容问题。改用 CJS 外壳、内部用 `await import()` 加载 ESM 的服务端，
 * 既稳定又不影响 server/ 保持 ESM。
 *
 * 职责只有四件：
 *   1. 单实例锁 + 窗口生命周期；
 *   2. 在进程内启动现有 Express 服务（见 服务宿主.mjs）；
 *   3. 通过 preload 把「服务地址 + token + 宿主能力」交给渲染进程；
 *   4. 原生能力（文件/目录对话框、系统打开）。
 *
 * 业务代码一律不在本目录：client/ 与 server/ 是唯一事实源（平台边界检查守护）。
 */

const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { createEmbeddedBrowserHost } = require("./浏览器视图.mjs");

const DEV_PROJECT_DIR = path.resolve(__dirname, "..", "..");
const isPackaged = app.isPackaged;
const PROJECT_DIR = isPackaged ? path.join(process.resourcesPath, "app") : DEV_PROJECT_DIR;

const state = { service: null, window: null, quitting: false };

/** 桌面端可写目录：Electron userData（与 server/平台/宿主信息.mjs 的约定一致）。 */
function resolveUserDataDir() {
  const dir = app.getPath("userData");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function resolveClientDist() {
  if (isPackaged) return path.join(PROJECT_DIR, "client", "dist");
  return path.join(DEV_PROJECT_DIR, "client", "dist");
}

function createWindow(service) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: "#1b1f27",
    title: "Open Plan 规聚",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // 外部链接一律交给系统浏览器，禁止应用内开窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = service && url.startsWith(service.url);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("host:ready", {
      port: service.port,
      token: service.token,
      url: service.url,
      version: app.getVersion(),
      isPackaged,
    });
  });

  win.on("closed", () => { state.window = null; });
  return win;
}

/** 加载渲染进程：优先走服务地址（与 web 形态同源），缺构建产物则给明确指引。 */
async function loadRenderer(win, service) {
  const indexFile = path.join(resolveClientDist(), "index.html");
  if (fs.existsSync(indexFile)) {
    await win.loadURL(`${service.url}/?token=${encodeURIComponent(service.token)}`);
    return;
  }
  const hint = [
    "未找到前端构建产物：",
    indexFile,
    "",
    "请先在仓库根执行：",
    "  npm run build",
    "然后重新启动桌面端。",
  ].join("\n");
  await win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<pre style="font:14px/1.7 monospace;padding:24px;white-space:pre-wrap">${hint}</pre>`),
  );
}

/** 原生能力：只暴露白名单方法（渲染进程拿不到 ipcRenderer 本体）。 */
function registerNativeBridges() {
  ipcMain.handle("native:openFile", async (_event, options = {}) => {
    const opts = options || {};
    const result = await dialog.showOpenDialog(state.window, {
      properties: opts.directory ? ["openDirectory"] : ["openFile"],
      filters: opts.filters || undefined,
      title: opts.title || "选择文件",
      defaultPath: opts.defaultPath || undefined,
    });
    return { canceled: result.canceled, paths: result.filePaths || [] };
  });
  ipcMain.handle("native:openPath", async (_event, target) => {
    if (typeof target !== "string" || !target) return { ok: false, error: "路径为空" };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle("native:showItem", async (_event, target) => {
    if (typeof target !== "string" || !target) return { ok: false };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  // 内嵌浏览器视图：渲染进程上报面板矩形与可见性（ADR 0024 §6）
  ipcMain.handle("browser:setBounds", async (_event, payload = {}) => {
    if (!state.browserHost) return { ok: false, error: "browser host not ready" };
    try {
      return { ok: await state.browserHost.setBounds(payload.key || "", payload.bounds || {}) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });
  ipcMain.handle("browser:setVisible", async (_event, payload = {}) => {
    if (!state.browserHost) return { ok: false };
    try {
      return { ok: await state.browserHost.setVisible(payload.key || "", payload.visible !== false) };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });
  ipcMain.handle("native:info", async () => ({
    browserDriver: "embedded",
    platform: process.platform,
    version: app.getVersion(),
    userData: resolveUserDataDir(),
    resources: isPackaged ? process.resourcesPath : DEV_PROJECT_DIR,
  }));
}

/** 在进程内启动服务（ESM 动态导入，保证 env 先就位）。 */
async function bootService() {
  const entry = path.join(PROJECT_DIR, "server", "服务入口.mjs");
  const mod = await import(pathToFileURL(entry).href);
  return mod.startDesktopService({
    projectDir: PROJECT_DIR,
    userDataDir: resolveUserDataDir(),
    resourcesDir: isPackaged ? process.resourcesPath : DEV_PROJECT_DIR,
    clientDist: resolveClientDist(),
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (state.window) {
      if (state.window.isMinimized()) state.window.restore();
      state.window.focus();
    }
  });

  app.whenReady().then(async () => {
    registerNativeBridges();
    try {
      state.service = await bootService();
    } catch (error) {
      dialog.showErrorBox("服务启动失败", String((error && (error.stack || error.message)) || error));
      app.quit();
      return;
    }
    state.window = createWindow(state.service);
    // 注入浏览器原生视图宿主：服务侧的 browser_* 工具将改用内嵌视图（无帧流）
    try {
      state.browserHost = createEmbeddedBrowserHost({ getWindow: () => state.window });
      const driverMod = await import(pathToFileURL(path.join(PROJECT_DIR, "server", "平台", "浏览器驱动.mjs")).href);
      driverMod.installEmbeddedBrowserHost(state.browserHost);
    } catch (error) {
      console.warn("[desktop] 内嵌浏览器宿主注入失败，将回退系统浏览器驱动：", String((error && error.message) || error));
    }
    await loadRenderer(state.window, state.service);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!state.window && state.service) state.window = createWindow(state.service);
  });

  app.on("before-quit", async (event) => {
    if (state.quitting) return;
    event.preventDefault();
    state.quitting = true;
    try { if (state.browserHost) await state.browserHost.disposeAll(); } catch {}
    try { if (state.service) await state.service.stop(); } catch {}
    app.exit(0);
  });
}
