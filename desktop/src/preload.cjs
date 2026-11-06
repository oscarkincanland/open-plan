/**
 * preload：把最小能力集通过 contextBridge 交给渲染进程。
 *
 * 安全约定（ADR 0024 §4.2）：
 *   - 不暴露 ipcRenderer 本体，只暴露语义化方法；
 *   - 不暴露 Node API（require/process 一律不出桥）；
 *   - 渲染进程只能通过 window.__OAW_HOST__ 感知宿主并调用白名单方法。
 */

const { contextBridge, ipcRenderer } = require("electron");

const hostBridge = {
  isDesktop: true,
  platform: process.platform,
  /** 白名单原生能力 */
  async openFile(options) { return ipcRenderer.invoke("native:openFile", options || {}); },
  async openDirectory(options) { return ipcRenderer.invoke("native:openFile", { ...(options || {}), directory: true }); },
  async openPath(target) { return ipcRenderer.invoke("native:openPath", target); },
  async showItemInFolder(target) { return ipcRenderer.invoke("native:showItem", target); },
  async info() { return ipcRenderer.invoke("native:info"); },
  /** 内嵌浏览器视图：面板矩形与可见性（ADR 0024 §6，桌面宿主专用） */
  browser: {
    async setBounds(key, rect) { return ipcRenderer.invoke('browser:setBounds', { key: key, bounds: rect }); },
    async setVisible(key, visible) { return ipcRenderer.invoke('browser:setVisible', { key: key, visible: visible }); },
  },
  /** 服务连接信息（端口 + token），用于 api.js 拼 baseURL 与鉴权头 */
  onReady(callback) {
    const handler = (_event, payload) => {
      try { callback(payload); } catch {}
    };
    ipcRenderer.on("host:ready", handler);
    return () => ipcRenderer.removeListener("host:ready", handler);
  },
};

try {
  contextBridge.exposeInMainWorld("__OAW_HOST__", hostBridge);
} catch (error) {
  // 开发期若沙箱配置导致 expose 失败，至少让渲染进程能感知宿主（不含 ipc 能力）
  console.error("[preload] exposeInMainWorld 失败：", error);
}
