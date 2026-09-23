import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PROJECT_DIR } from "./workspace.mjs";
import { loadNetworkSettings } from "./Pi配置管理.mjs";

/**
 * 内置浏览器：Agent 可直接操作的可视化浏览器。
 *
 * 实现方式（零外部依赖）：
 *   - 启动系统 Edge/Chrome（headless=new，独立 profile 保留登录态），开启 CDP；
 *   - Node 内置 WebSocket 直连页面级 CDP，执行导航 / 快照 / 点击 / 输入 / 滚动 / 截图；
 *   - Page.startScreencast 帧推送给前端面板，用户在“工作产物 → 浏览器”中实时观看并可接管。
 *
 * 观察方式与 Playwright MCP 一致：可访问性语义快照（编号元素），非像素识别。
 */

const PROFILE_DIR = process.env.OAW_BROWSER_PROFILE || path.join(PROJECT_DIR, ".oaw", "browser-profile");
const SHOT_DIR = path.join(PROJECT_DIR, ".oaw", "browser-shots");
// 以更接近桌面浏览器的视口启动，面板缩放时仍保持清晰的网页文字。
const VIEWPORT = { width: 1440, height: 900 };
const MAX_CAPTURE = { width: 2400, height: 1600 };
// 页面导航不能把 Agent 回合阻塞到 25 秒；超时后仍保留当前页面，
// 后续 browser_snapshot/browser_wait 类操作可以继续观察加载结果。
const NAV_TIMEOUT_MS = 8000;
const FRAME_BROADCAST_INTERVAL_MS = 90;

const sessions = new Map(); // key -> BrowserSession
const subscribers = new Map(); // key -> Set<fn(type, data)>
// 浏览器进程按端口共享：不同会话线程可能通过 PORT_FILE 复用同一个 Edge 实例，
// 只有最后一个使用方关闭时才真正结束浏览器进程，避免误杀其他会话正在用的浏览器。
const portUsers = new Map(); // port -> Set<sessionKey>

function acquireBrowserPort(port, key) {
  const portNumber = Number(port);
  if (!Number.isFinite(portNumber) || portNumber <= 0) return;
  if (!portUsers.has(portNumber)) portUsers.set(portNumber, new Set());
  portUsers.get(portNumber).add(key);
}

function releaseBrowserPort(port, key) {
  const portNumber = Number(port);
  const users = portUsers.get(portNumber);
  if (!users) return 0;
  users.delete(key);
  if (!users.size) portUsers.delete(portNumber);
  return users.size;
}

/**
 * 会话键（client::thread）。
 * 注意：Agent 工具上下文里的 clientId 实际是复合 agentKey（client::thread），
 * 这里统一归一化为「原始 client + thread」，保证工具与前端面板订阅同一个键。
 */
export function browserSessionKey(clientId, threadId) {
  let client = String(clientId || "").trim();
  const thread = String(threadId || "").trim();
  if (thread && client.endsWith(`::${thread}`)) {
    client = client.slice(0, -(thread.length + 2));
  }
  return `${client}::${thread}`;
}

export function hasBrowserSession(key) {
  const session = sessions.get(key);
  return Boolean(session && session.state.active);
}

export function subscribeBrowser(key, handler) {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(handler);
  cleanupSubscribers();
  return () => {
    const set = subscribers.get(key);
    if (!set) return;
    set.delete(handler);
    if (!set.size) subscribers.delete(key);
  };
}

function cleanupSubscribers() {
  for (const [key, set] of subscribers.entries()) {
    if (!set.size) subscribers.delete(key);
  }
}

export function broadcast(key, type, data) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const handler of set) {
    try { handler(type, data); } catch {}
  }
}

function findBrowserExecutable() {
  const candidates = [
    process.env.OAW_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((item) => { try { return fs.existsSync(item); } catch { return false; } }) || null;
}

function sessionProfileDir(key) {
  const token = Buffer.from(String(key || "default"), "utf8").toString("base64url").slice(0, 96) || "default";
  return path.join(PROFILE_DIR, "sessions", token);
}

function browserProxyArgs() {
  try {
    const settings = loadNetworkSettings();
    if (settings.mode !== "manual" || !settings.proxyUrl) return [];
    const args = [`--proxy-server=${settings.proxyUrl}`];
    const bypass = String(settings.noProxy || "")
      .split(/[;,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(";");
    if (bypass) args.push(`--proxy-bypass-list=${bypass}`);
    return args;
  } catch {
    return [];
  }
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 结束仍占用同一 profile 的残留浏览器进程。
 *
 * 场景：Edge 自动升级后旧实例仍在运行，或上一次异常退出没清干净。
 * 此时用同一个 --user-data-dir 启动新实例会被旧进程截获并立刻退出，
 * CDP 调试端口永远起不来，前端只看到「浏览器启动失败」。
 * 只在首次启动已经失败后才调用，避免误杀其他会话正在使用的浏览器。
 */
function killProfileBrowserProcesses(profileDir) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(0);
    const script = [
      "$d = $env:OAW_BROWSER_PROFILE_DIR",
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" -ErrorAction SilentlyContinue",
      "$hits = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) })",
      "foreach ($p in $hits) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }",
      "Write-Output $hits.Count",
    ].join("; ");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20000, env: { ...process.env, OAW_BROWSER_PROFILE_DIR: profileDir } },
      (_error, stdout) => {
        const n = Number.parseInt(String(stdout || "").trim(), 10);
        resolve(Number.isFinite(n) ? n : 0);
      },
    );
  });
}

/** 页面内同源 iframe 递归查找脚本片段：注入到快照/定位/聚焦脚本中复用。 */
const FIND_EL_SNIPPET = `const findEl = (doc, ref) => {
  if (!doc) return null;
  const direct = doc.querySelector('[data-oaw-ref="' + ref + '"]');
  if (direct) return direct;
  for (const frame of doc.querySelectorAll('iframe,frame')) {
    try {
      const nested = findEl(frame.contentDocument, ref);
      if (nested) return nested;
    } catch {}
  }
  return null;
}`;

/** 页面内快照脚本：给可交互元素编号并输出语义清单 + 正文。覆盖同源 iframe（登录/表单/编辑器常嵌在 iframe 里）。 */
const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="slider"],[contenteditable]:not([contenteditable="false"])';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const docs = [];
  const collectDocs = (doc) => {
    if (!doc || docs.includes(doc)) return;
    docs.push(doc);
    for (const frame of doc.querySelectorAll('iframe,frame')) {
      try { collectDocs(frame.contentDocument); } catch {}
    }
  };
  collectDocs(document);
  for (const doc of docs) doc.querySelectorAll('[data-oaw-ref]').forEach((el) => el.removeAttribute('data-oaw-ref'));
  const lines = [];
  let counter = 0;
  outer: for (const doc of docs) {
    for (const el of doc.querySelectorAll(SELECTOR)) {
      if (counter >= 160) break outer;
      if (!isVisible(el)) continue;
      counter += 1;
      const ref = 'e' + counter;
      try { el.setAttribute('data-oaw-ref', ref); } catch {}
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type || 'input') : tag);
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      const rawName = isField
        ? (el.getAttribute('aria-label') || el.placeholder || el.title || el.name || '')
        : (el.innerText || el.getAttribute('aria-label') || el.title || '');
      const name = String(rawName).replace(/\\s+/g, ' ').trim().slice(0, 90);
      let extra = '';
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) extra = el.checked ? ' [已勾选]' : ' [未勾选]';
      else if (tag === 'select') {
        const options = Array.from(el.options || []).slice(0, 10).map((option) => String(option.text || '').trim()).filter(Boolean);
        extra = ' 当前:"' + String(el.value || '').slice(0, 30) + '"' + (options.length ? ' 选项:[' + options.join(' | ').slice(0, 140) + ']' : '');
      }
      else if ((tag === 'input' || tag === 'textarea') && el.value) extra = ' 值:"' + String(el.value).slice(0, 40) + '"';
      else if (tag === 'a' && el.href) extra = ' → ' + String(el.href).slice(0, 140);
      if (el.disabled) extra += ' (禁用)';
      lines.push('[' + ref + '] ' + role + ' "' + name + '"' + extra);
    }
  }
  let text = '';
  for (const doc of docs) {
    const part = String(doc.body ? doc.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
    if (part) text += (text ? '\\n\\n' : '') + part;
  }
  return { url: location.href, title: document.title, elements: lines, text: text.slice(0, 5000) };
})()`;

/** 页面内元素定位脚本（含同源 iframe）：返回元素中心在顶层视口中的坐标。 */
const LOCATE_SCRIPT = `(ref) => {
  ${FIND_EL_SNIPPET}
  const el = findEl(document, ref);
  if (!el) return null;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
  const rect = el.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  let win = el.ownerDocument.defaultView;
  while (win && win.frameElement) {
    const frameRect = win.frameElement.getBoundingClientRect();
    x += frameRect.left;
    y += frameRect.top;
    win = win.parent;
  }
  return {
    x, y,
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  };
}`;

/** 页面内聚焦并清空输入框的脚本（含同源 iframe）。 */
const FOCUS_SCRIPT = `(ref) => {
  ${FIND_EL_SNIPPET}
  const el = findEl(document, ref);
  if (!el) return null;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
  try { el.focus(); } catch {}
  if (el.isContentEditable) {
    el.textContent = '';
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    el.value = '';
  }
  try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  return { x: el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2, y: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 };
}`;

class CdpConnection {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.envelopes = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.sessionId = null;
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 15000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); });
    });
    this.ws.addEventListener("message", (event) => {
      let message = null;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }

      // 使用浏览器级 CDP + Target.attachToTarget(flatten:false) 时，标签页事件
      // 会被包在 Target.receivedMessageFromTarget 中，需要还原成普通 CDP 消息。
      if (message.method === "Target.receivedMessageFromTarget") {
        if (message.params?.sessionId !== this.sessionId) return;
        try {
          const inner = JSON.parse(message.params.message || "{}");
          if (inner.id && this.pending.has(inner.id)) {
            const pending = this.pending.get(inner.id);
            this.pending.delete(inner.id);
            if (message.error || inner.error) pending.reject(new Error((message.error || inner.error).message || "CDP 命令失败"));
            else pending.resolve(inner.result || {});
            return;
          }
          if (inner.method) this.dispatchEvent(inner);
        } catch {}
        return;
      }

      // Target.sendMessageToTarget 的外层确认只表示消息已入队，真正的返回值
      // 在上面的 receivedMessageFromTarget 事件中到达；外层错误需要传给内层请求。
      if (message.id && this.envelopes.has(message.id)) {
        const innerId = this.envelopes.get(message.id);
        this.envelopes.delete(message.id);
        if (message.error && this.pending.has(innerId)) {
          const pending = this.pending.get(innerId);
          this.pending.delete(innerId);
          pending.reject(new Error(message.error.message || "CDP 命令失败"));
        }
        return;
      }

      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失败"));
        else pending.resolve(message.result || {});
        return;
      }
      this.dispatchEvent(message);
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error("浏览器连接已关闭"));
        this.pending.delete(id);
      }
      this.envelopes.clear();
    });
  }

  dispatchEvent(message) {
    if (!message?.method) return;
    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) { try { handler(message.params || {}); } catch {} }
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("浏览器连接已关闭"));
    const id = this.nextId++;
    const envelopeId = this.sessionId ? this.nextId++ : null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          if (envelopeId) this.envelopes.delete(envelopeId);
          reject(new Error(`CDP 命令超时：${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); if (envelopeId) this.envelopes.delete(envelopeId); reject(error); },
      });
      try {
        const message = this.sessionId
          ? { id: envelopeId, method: "Target.sendMessageToTarget", params: { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) } }
          : { id, method, params };
        if (this.sessionId) this.envelopes.set(envelopeId, id);
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        if (envelopeId) this.envelopes.delete(envelopeId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

function normalizeNavUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("URL 不能为空");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)) return `https://${value}`;
  // 地址栏同时承担搜索入口：用户输入中文或普通关键词时，直接进入搜索结果页。
  // 仍然拒绝 file/javascript 等非网页协议，避免把本地协议交给浏览器进程。
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return `https://cn.bing.com/search?q=${encodeURIComponent(value)}`;
  }
  throw new Error(`无效的 URL：${value}（需 http/https 链接，或输入普通关键词搜索）`);
}

class BrowserSession {
  constructor(key) {
    this.key = key;
    this.profileDir = sessionProfileDir(key);
    this.portFile = path.join(this.profileDir, ".oaw-devtools-port");
    this.child = null;
    this.cdp = null;
    this.port = 0;
    this.browserStderr = "";
    this.frame = null;
    this.pendingFrame = null;
    this.frameBroadcastTimer = null;
    this.lastUserInputAt = 0;
    this.activeTargetId = null;
    this.tabs = [];
    this.tabsTimer = null;
    this.state = { active: false, url: "about:blank", title: "", loading: false, viewport: { ...VIEWPORT }, startedAt: null, error: null };
  }

  queueFrameBroadcast(frame) {
    this.pendingFrame = frame;
    if (this.frameBroadcastTimer) return;
    this.frameBroadcastTimer = setTimeout(() => {
      this.frameBroadcastTimer = null;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (next) broadcast(this.key, "frame", next);
    }, FRAME_BROADCAST_INTERVAL_MS);
  }

  clearFrameBroadcast() {
    if (this.frameBroadcastTimer) clearTimeout(this.frameBroadcastTimer);
    this.frameBroadcastTimer = null;
    this.pendingFrame = null;
  }

  /** 列出所有页面标签（id/标题/URL/是否激活）。 */
  async fetchTargets() {
    if (!this.port) return [];
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2500) });
      const list = await response.json();
      return list.filter((item) => item.type === "page") || [];
    } catch {
      return [];
    }
  }

  /** 刷新标签列表并向面板广播（防抖合并）。 */
  async refreshTabs() {
    const targets = await this.fetchTargets();
    const tabs = targets.map((item) => ({
      id: item.id,
      title: String(item.title || "").trim() || String(item.url || "").replace(/^https?:\/\//, "").slice(0, 40) || "新标签页",
      url: item.url || "",
      active: item.id === this.activeTargetId,
    }));
    const fingerprint = JSON.stringify(tabs);
    if (fingerprint !== this.lastTabsFingerprint) {
      this.lastTabsFingerprint = fingerprint;
      this.tabs = tabs;
      broadcast(this.key, "tabs", { tabs, activeId: this.activeTargetId });
    }
    return tabs;
  }

  scheduleTabsRefresh(delay = 400) {
    if (this.tabsTimer) clearTimeout(this.tabsTimer);
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = null;
      this.refreshTabs().catch(() => {});
    }, delay);
  }

  /** 新建标签页并切换过去。 */
  async newTab(url = "about:blank", { agent = false } = {}) {
    await this.ensureStarted();
    // about:blank 是浏览器内置空白页，不走 http/https 校验
    const target = String(url || "").trim() === "about:blank" ? "about:blank" : normalizeNavUrl(url);
    const endpoint = `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(target)}`;
    // 新版 Edge/Chrome 要求 PUT
    let created = null;
    try {
      const response = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(5000) });
      created = await response.json();
    } catch {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        created = await response.json();
      } catch {}
    }
    const targets = await this.fetchTargets();
    const targetInfo = (created?.id && targets.find((item) => item.id === created.id)) || targets[targets.length - 1] || null;
    if (!targetInfo) throw new Error("新建标签页失败");
    await this.switchToTarget(targetInfo.id);
    if (agent) await this.emitAgentAction("tab", null, { action: "new", url: targetInfo.url });
    return { tabId: targetInfo.id, url: targetInfo.url };
  }

  /** 切换到指定标签页（重连 CDP 到该页面）。 */
  async switchToTarget(targetId, { agent = false } = {}) {
    const targets = await this.fetchTargets();
    const target = targets.find((item) => item.id === targetId);
    if (!target) throw new Error("标签页不存在或已关闭");
    try { await fetch(`http://127.0.0.1:${this.port}/json/activate/${targetId}`, { signal: AbortSignal.timeout(3000) }); } catch {}
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.clearFrameBroadcast();
    this.frame = null;
    await this.connectToTarget(target);
    this.activeTargetId = targetId;
    this.state.url = target.url || this.state.url;
    this.state.title = target.title || this.state.title;
    this.state.loading = false;
    this.emitState();
    this.scheduleTabsRefresh(80);
    if (agent) await this.emitAgentAction("tab", null, { action: "switch", url: target.url || "" });
    return this.stateView();
  }

  /** 关闭指定标签页；关掉当前页时自动切到剩余页。 */
  async closeTab(targetId, { agent = false } = {}) {
    const targets = await this.fetchTargets();
    if (targets.length <= 1) throw new Error("至少保留一个标签页");
    if (agent) await this.emitAgentAction("tab", null, { action: "close", url: (targets.find((item) => item.id === targetId) || {}).url || "" });
    await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    await sleep(400);
    if (targetId === this.activeTargetId) {
      const remaining = await this.fetchTargets();
      const next = remaining[remaining.length - 1];
      if (next) await this.switchToTarget(next.id);
    } else {
      this.scheduleTabsRefresh(100);
    }
    return { closed: targetId };
  }

  async reload() {
    await this.ensureStarted();
    await this.cdp.send("Page.reload", {});
    await sleep(500);
    return { reloaded: true, url: this.state.url };
  }

  /**
   * 把面板坐标换算成页面 CSS 像素：
   * 面板发送归一化坐标（nx/ny ∈ [0,1]），这里按当前布局视口换算，
   * 不受帧缩放、设备像素比和面板宽度影响。
   */
  async resolvePoint(payload = {}) {
    await this.ensureStarted();
    let clientWidth = VIEWPORT.width;
    let clientHeight = VIEWPORT.height;
    try {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || {};
      if (viewport.clientWidth) clientWidth = Number(viewport.clientWidth);
      if (viewport.clientHeight) clientHeight = Number(viewport.clientHeight);
    } catch {}
    const nx = Number(payload.nx);
    const ny = Number(payload.ny);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      return {
        x: Math.round(Math.max(0, Math.min(1, nx)) * clientWidth),
        y: Math.round(Math.max(0, Math.min(1, ny)) * clientHeight),
      };
    }
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("无效的点击坐标");
    return { x: Math.round(x), y: Math.round(y) };
  }

  async resize(width, height) {
    await this.ensureStarted();
    const next = {
      width: Math.max(320, Math.min(MAX_CAPTURE.width, Math.round(Number(width) || VIEWPORT.width))),
      height: Math.max(240, Math.min(MAX_CAPTURE.height, Math.round(Number(height) || VIEWPORT.height))),
    };
    const previous = this.state.viewport || VIEWPORT;
    if (previous.width === next.width && previous.height === next.height) return this.stateView();
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: next.width,
      height: next.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: next.width,
      screenHeight: next.height,
    });
    this.state.viewport = next;
    // resize 后先发一张与新 viewport 匹配的帧，避免前端短暂拿旧帧尺寸计算点击坐标。
    try {
      const result = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
      const data = result.data || "";
      if (data) {
        this.frame = { data, at: Date.now(), width: next.width, height: next.height };
        this.queueFrameBroadcast({ data, at: this.frame.at, width: next.width, height: next.height });
      }
    } catch {}
    this.emitState();
    return this.stateView();
  }

  stateView() {
    return {
      active: this.state.active,
      url: this.state.url,
      title: this.state.title,
      loading: this.state.loading,
      viewport: this.state.viewport,
      frameSize: this.frame ? { width: this.frame.width || null, height: this.frame.height || null } : null,
      error: this.state.error,
      hasFrame: Boolean(this.frame),
    };
  }

  emitState() {
    broadcast(this.key, "state", this.stateView());
  }

  /**
   * 广播 Agent 操作轨迹（面板上的虚拟鼠标）。坐标为页面 CSS 像素，
   * 这里换算成归一化坐标后下发，前端按帧画面比例定位，不受缩放影响。
   */
  async emitAgentAction(kind, point = null, extra = {}) {
    let nx = null;
    let ny = null;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      let clientWidth = VIEWPORT.width;
      let clientHeight = VIEWPORT.height;
      try {
        const metrics = await this.cdp.send("Page.getLayoutMetrics");
        const viewport = metrics.cssLayoutViewport || {};
        if (viewport.clientWidth) clientWidth = Number(viewport.clientWidth);
        if (viewport.clientHeight) clientHeight = Number(viewport.clientHeight);
      } catch {}
      nx = Math.max(0, Math.min(1, point.x / clientWidth));
      ny = Math.max(0, Math.min(1, point.y / clientHeight));
    }
    broadcast(this.key, "agent-action", { kind, nx, ny, ...extra, at: Date.now() });
  }

  async start() {
    if (this.state.active) return;
    const executable = findBrowserExecutable();
    if (!executable) throw new Error("未找到 Edge/Chrome，无法启动内置浏览器（可设置环境变量 OAW_BROWSER_PATH 指定浏览器路径）");
    fs.mkdirSync(this.profileDir, { recursive: true });
    // 1) 尝试复用上次启动且仍在运行的实例（服务重启后浏览器不中断）
    if (await this.tryReuse()) return;

    try {
      await this.launch(executable);
    } catch (error) {
      // 2) 自愈重试：Edge 自动升级 / 异常退出会留下仍持有同一 profile 的旧进程，
      //    新实例会被旧进程截获并立即退出，CDP 端口永远起不来。
      //    这里清理占用同一 profile 的残留进程后再启动一次；没有残留就直接抛出原错误。
      const killed = await killProfileBrowserProcesses(this.profileDir);
      if (!killed) throw error;
      this.child = null;
      await sleep(400);
      await this.launch(executable);
    }
  }

  /** 启动一个新的浏览器实例并等待 CDP 就绪（不含复用与残留清理）。 */
  async launch(executable) {
    this.port = await allocatePort();
    const headless = process.env.OAW_BROWSER_HEADLESS !== "0";
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      // 当前 Windows/Codex 环境中的 GPU 子进程会直接崩溃（GPU process isn't usable），
      // 导致浏览器虽然短暂打开，但 CDP 页面连接立即关闭。浏览器面板本身使用截图流，
      // 关闭 GPU 不影响用户接管，反而能保证 Edge/Chrome 在无 GPU 沙箱中稳定运行。
      "--disable-gpu",
      // 部分 Chromium 版本即使带 --disable-gpu 仍会启动独立 GPU 进程，
      // 而当前环境会让该子进程崩溃；内置 GPU 进程可避免 CDP 随浏览器退出。
      "--in-process-gpu",
      // 服务可能运行在受限账户下，Chromium 沙箱会再次触发 renderer 崩溃；
      // 浏览器已经使用独立临时 profile，并且只接受本地 CDP 连接。
      "--no-sandbox",
      "--disable-extensions",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ];
    args.splice(args.length - 1, 0, ...browserProxyArgs());
    if (headless) args.unshift("--headless=new");
    this.browserStderr = "";
    this.child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.child.stderr?.on("data", (chunk) => {
      this.browserStderr = `${this.browserStderr}${String(chunk)}`.slice(-4000);
    });
    this.child.on("exit", () => {
      // 浏览器进程退出（崩溃/被杀）时必须清掉最后一帧并广播 closed，
      // 否则面板会一直显示冻结的旧画面且状态混乱。
      this.frame = null;
      if (this.state.active) {
        this.state.active = false;
        this.tabs = [];
        this.emitState();
        broadcast(this.key, "closed", {});
      }
    });

    // 等待 CDP 端点就绪
    let target = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(300);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const list = await response.json();
        target = list.find((item) => item.type === "page") || null;
        if (target?.webSocketDebuggerUrl) break;
      } catch {}
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) break;
    }
    if (!target?.webSocketDebuggerUrl) {
      const exited = this.child?.exitCode;
      await this.close().catch(() => {});
      const detail = this.browserStderr.trim().replace(/\s+/g, " ");
      throw new Error(`浏览器启动失败：CDP 端点不可用${exited !== null && exited !== undefined ? `（进程退出码 ${exited}）` : ""}${detail ? `：${detail.slice(0, 800)}` : ""}`);
    }
    try { fs.writeFileSync(this.portFile, String(this.port)); } catch {}
    await this.connectToTarget(target);
  }

  /** 复用上次记录的浏览器实例（同 profile）。 */
  async tryReuse() {
    try {
      if (!fs.existsSync(this.portFile)) return false;
      const port = Number(String(fs.readFileSync(this.portFile, "utf8")).trim());
      if (!Number.isFinite(port) || port <= 0) return false;
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await response.json();
      const target = list.find((item) => item.type === "page") || null;
      if (!target?.webSocketDebuggerUrl) return false;
      this.port = port;
      this.child = null; // 复用实例不持有子进程
      await this.connectToTarget(target);
      return true;
    } catch {
      try { fs.rmSync(this.portFile, { force: true }); } catch {}
      return false;
    }
  }

  async connectToTarget(target) {
    // 新版 Chromium 的页面级 websocket 在部分 Windows 环境中能握手但不返回
    // Page.enable 响应。使用浏览器级 websocket + flatten attach 是 DevTools
    // 自身的连接方式，兼容 Edge/Chrome 新版，也为多标签切换保留清晰的会话边界。
    let version = null;
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(2500) });
      version = await response.json();
    } catch {}
    const browserWs = version?.webSocketDebuggerUrl;
    if (!browserWs) throw new Error("浏览器 CDP 端点缺少浏览器级 websocket");
    this.cdp = new CdpConnection(browserWs);
    await this.cdp.ready;
    const attached = await this.cdp.send("Target.attachToTarget", { targetId: target.id, flatten: false });
    if (!attached?.sessionId) throw new Error("浏览器 CDP 未能 attach 当前标签页");
    this.cdp.sessionId = attached.sessionId;
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    this.cdp.on("Page.screencastFrame", (params) => {
      this.frame = {
        data: params.data,
        at: Date.now(),
        // deviceWidth/deviceHeight 是 Chromium 的屏幕元数据，不一定是截图 JPEG 的像素尺寸；
        // 交互坐标和前端显示都应以当前 CSS viewport 为准。
        width: this.state.viewport.width,
        height: this.state.viewport.height,
      };
      this.queueFrameBroadcast({ data: params.data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
    this.cdp.on("Page.frameNavigated", (params) => {
      const frame = params?.frame;
      if (!frame || frame.parentId) return;
      this.state.url = frame.url || this.state.url;
      if (frame.name) this.state.title = frame.name;
      this.emitState();
    });
    this.cdp.on("Page.loadEventFired", () => {
      this.state.loading = false;
      this.refreshTitle().catch(() => {});
      this.emitState();
      this.scheduleTabsRefresh();
    });
    // 浏览器级事件：任何新标签页（target=_blank、window.open）出现都刷新标签列表
    this.cdp.on("Target.targetCreated", () => this.scheduleTabsRefresh(120));
    // 保持高质量和完整视口；服务端以约 11fps 推送最新帧，避免每个 CDP 帧
    // 都挤占 SSE、React 和浏览器主线程。
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: MAX_CAPTURE.width, maxHeight: MAX_CAPTURE.height, everyNthFrame: 1 }).catch(() => {});
    if (target.id) this.activeTargetId = target.id;
    acquireBrowserPort(this.port, this.key);
    this.state.active = true;
    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    this.state.error = null;
    this.emitState();
    this.scheduleTabsRefresh(100);
  }

  async ensureStarted() {
    if (!this.state.active) await this.start();
  }

  async evaluate(expression) {
    await this.ensureStarted();
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    return result.result?.value;
  }

  async refreshTitle() {
    const value = await this.evaluate("({ url: location.href, title: document.title })");
    if (value && typeof value === "object") {
      if (value.url) this.state.url = value.url;
      if (value.title) this.state.title = value.title;
    }
  }

  async waitForLoad(timeoutMs = NAV_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await this.evaluate("document.readyState");
        // interactive 只代表 HTML 已解析，SPA/搜索页的脚本和可交互控件
        // 可能还没挂载；browser_open 紧接 browser_snapshot 时会因此得到空页。
        if (ready === "complete") return true;
      } catch {}
      await sleep(150);
    }
    return false;
  }

  async navigate(rawUrl, { agent = false } = {}) {
    const url = normalizeNavUrl(rawUrl);
    await this.ensureStarted();
    this.state.loading = true;
    this.state.url = url;
    this.emitState();
    if (agent) await this.emitAgentAction("navigate", null, { url });
    const result = await this.cdp.send("Page.navigate", { url });
    // DNS/连接失败等会在这里返回 errorText，之前被忽略导致 Agent 对着错误页继续操作
    if (result?.errorText) {
      this.state.loading = false;
      this.emitState();
      throw new Error(`页面加载失败：${result.errorText}（${url}）`);
    }
    await this.waitForLoad(NAV_TIMEOUT_MS);
    this.state.loading = false;
    if (this.state.error && this.state.error.startsWith("页面加载超时")) this.state.error = null;
    await this.refreshTitle().catch(() => {});
    this.emitState();
    this.scheduleTabsRefresh();
    return this.stateView();
  }

  async snapshot() {
    const value = await this.evaluate(SNAPSHOT_SCRIPT);
    if (value?.url) this.state.url = value.url;
    if (value?.title) this.state.title = value.title;
    this.emitState();
    return value || { url: this.state.url, title: this.state.title, elements: [], text: "" };
  }

  async click(ref, { agent = false } = {}) {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const knownTabIds = new Set((await this.fetchTargets()).map((item) => item.id));
    const box = await this.evaluate(`(${LOCATE_SCRIPT})("${safe}")`);
    if (!box) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    const point = { x: Math.round(box.x), y: Math.round(box.y) };
    if (agent) await this.emitAgentAction("click", point, { text: box.text });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await sleep(600);
    await this.waitForLoad(8000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    // target=_blank 等新标签页：主动感知，让 Agent 知道要切换过去
    let newTabUrl = null;
    try {
      const targets = await this.fetchTargets();
      const created = targets.find((item) => !knownTabIds.has(item.id)) || null;
      if (created) {
        newTabUrl = created.url || null;
        this.scheduleTabsRefresh(100);
      }
    } catch {}
    return { clicked: safe, text: box.text, url: this.state.url, isSelect: box.tag === "select", newTabUrl };
  }

  async type(ref, text, { submit = false, agent = false } = {}) {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const focused = await this.evaluate(`(${FOCUS_SCRIPT})("${safe}")`);
    if (!focused) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    if (agent) await this.emitAgentAction("type", focused, { text: String(text ?? "").slice(0, 60), submit: Boolean(submit) });
    await this.cdp.send("Input.insertText", { text: String(text ?? "") });
    if (submit) {
      await this.press("Enter", { agent });
    } else {
      await sleep(200);
    }
    return { typed: safe, chars: String(text ?? "").length, submitted: Boolean(submit) };
  }

  async press(key, { agent = false, modifiers = [] } = {}) {
    const keyName = String(key || "Enter").trim() || "Enter";
    // 修正键位表：此前未知按键会静默回落成 Enter（面板方向键/Home/Delete 会被当成回车提交）
    const map = {
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", keyCode: 9, text: "\t" },
      Escape: { code: "Escape", keyCode: 27, text: "" },
      Backspace: { code: "Backspace", keyCode: 8, text: "" },
      Delete: { code: "Delete", keyCode: 46, text: "" },
      ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
      ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
      ArrowLeft: { code: "ArrowLeft", keyCode: 37, text: "" },
      ArrowRight: { code: "ArrowRight", keyCode: 39, text: "" },
      PageDown: { code: "PageDown", keyCode: 34, text: "" },
      PageUp: { code: "PageUp", keyCode: 33, text: "" },
      Home: { code: "Home", keyCode: 36, text: "" },
      End: { code: "End", keyCode: 35, text: "" },
      Space: { code: "Space", keyCode: 32, text: " " },
      " ": { code: "Space", keyCode: 32, text: " " },
    };
    const info = map[keyName];
    if (!info) {
      throw new Error(`不支持的按键：${keyName}（支持：${Object.keys(map).filter((name) => name !== " ").join(" / ")}；可组合 ctrl/alt/meta/shift）`);
    }
    // 组合键掩码：Alt=1 Ctrl=2 Meta=4 Shift=8（与 CDP Input.dispatchKeyEvent 一致）
    const modifierMaskMap = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
    let modifierMask = 0;
    for (const item of Array.isArray(modifiers) ? modifiers : [modifiers]) {
      const value = modifierMaskMap[String(item || "").toLowerCase()];
      if (value) modifierMask |= value;
    }
    await this.ensureStarted();
    if (agent) await this.emitAgentAction("key", null, { key: keyName });
    const base = { key: keyName, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: modifierMask };
    // text/unmodifiedText 是表单回车提交的关键：缺省时多数页面不会触发提交行为；
    // 组合键（Ctrl/Meta）时不能带 text，否则会向页面插入字符
    const withText = info.text && !(modifierMask & 6);
    const down = withText ? { ...base, text: info.text, unmodifiedText: info.text } : base;
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...down });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(600);
    await this.waitForLoad(10000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return { pressed: keyName };
  }

  async scroll(direction = "down", amount = 600, { agent = false } = {}) {
    await this.ensureStarted();
    const delta = (direction === "up" ? -1 : 1) * Math.abs(Number(amount) || 600);
    if (agent) await this.emitAgentAction("scroll", null, { direction: delta < 0 ? "up" : "down" });
    // 用真实滚轮事件（视口中心）而不是 window.scrollBy：内层滚动容器、
    // 懒加载和悬停触发的行为与真实用户一致；window.scrollBy 只动主文档。
    let cx = Math.round(VIEWPORT.width / 2);
    let cy = Math.round(VIEWPORT.height / 2);
    try {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || {};
      if (viewport.clientWidth) cx = Math.round(Number(viewport.clientWidth) / 2);
      if (viewport.clientHeight) cy = Math.round(Number(viewport.clientHeight) / 2);
    } catch {}
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: delta, button: "none" });
    await sleep(400);
    const value = await this.evaluate("({ y: window.scrollY, height: document.body ? document.body.scrollHeight : 0 })").catch(() => ({}));
    return value || {};
  }

  /** 前进一页（与 back 对应，供面板工具栏使用）。 */
  async forward({ agent = false } = {}) {
    await this.ensureStarted();
    if (agent) await this.emitAgentAction("navigate", null, { url: "history:forward" });
    await this.evaluate("history.forward()");
    await sleep(800);
    await this.waitForLoad(8000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return this.stateView();
  }

  /** 悬停在指定元素上（展开悬停菜单 / tooltip / 懒加载）。 */
  async hover(ref, { agent = false } = {}) {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const box = await this.evaluate(`(${LOCATE_SCRIPT})("${safe}")`);
    if (!box) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    const point = { x: Math.round(box.x), y: Math.round(box.y) };
    if (agent) await this.emitAgentAction("click", point, { text: box.text, hover: true });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await sleep(300);
    return { hovered: safe, text: box.text, url: this.state.url };
  }

  /** 选择 <select> 下拉框的选项：原生弹出层在 CDP 里点不到，必须设值 + 派发 change。 */
  async selectOption(ref, { value = "", label = "", index = -1, agent = false } = {}) {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const script = `(() => {
      ${FIND_EL_SNIPPET}
      const el = findEl(document, ${JSON.stringify(safe)});
      if (!el) return { error: 'missing' };
      if (el.tagName !== 'SELECT') return { error: 'not-select', tag: el.tagName.toLowerCase() };
      const options = Array.from(el.options || []);
      let match = null;
      const wantIndex = ${JSON.stringify(Number(index) || -1)};
      const wantValue = ${JSON.stringify(String(value))};
      const wantLabel = ${JSON.stringify(String(label))};
      if (wantIndex >= 0) match = options[wantIndex] || null;
      else if (wantValue) match = options.find((option) => option.value === wantValue) || null;
      else if (wantLabel) {
        const needle = wantLabel.trim();
        match = options.find((option) => option.text.trim() === needle) || options.find((option) => option.text.trim().includes(needle)) || null;
      }
      if (!match) return { error: 'no-option', options: options.slice(0, 30).map((option) => option.text.trim()) };
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: match.text.trim(), value: match.value };
    })()`;
    const outcome = await this.evaluate(script);
    if (!outcome) throw new Error("页面脚本执行失败");
    if (outcome.error === "missing") throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    if (outcome.error === "not-select") throw new Error(`元素 ${safe} 不是下拉框（是 ${outcome.tag}），可直接 browser_click`);
    if (outcome.error === "no-option") throw new Error(`没有匹配的选项（${label || value || index}）。可用选项：${(outcome.options || []).join(" | ") || "（无）"}`);
    return { selected: safe, label: outcome.selected, value: outcome.value, url: this.state.url };
  }

  /** 等待页面出现文本/元素（SPA 异步加载），或先固定等待 ms 毫秒。 */
  async wait({ ms = 0, text = "", selector = "", timeout = 10000 } = {}) {
    await this.ensureStarted();
    const settle = Math.min(Math.max(Number(ms) || 0, 0), 10000);
    if (settle) await sleep(settle);
    const wantText = String(text || "").trim();
    const wantSelector = String(selector || "").trim();
    if (!wantText && !wantSelector) return { waited: settle, url: this.state.url };
    const deadline = Date.now() + Math.min(Math.max(Number(timeout) || 10000, 1000), 30000);
    while (Date.now() < deadline) {
      try {
        const hit = await this.evaluate(`(() => {
          const wantText = ${JSON.stringify(wantText)};
          const wantSelector = ${JSON.stringify(wantSelector)};
          if (wantText) {
            let found = Boolean(document.body) && String(document.body.innerText).includes(wantText);
            if (!found) {
              for (const frame of document.querySelectorAll('iframe')) {
                try {
                  if (frame.contentDocument && frame.contentDocument.body && String(frame.contentDocument.body.innerText).includes(wantText)) { found = true; break; }
                } catch {}
              }
            }
            if (!found) return false;
          }
          if (wantSelector) {
            try {
              if (!document.querySelector(wantSelector)) return false;
            } catch { return 'bad-selector'; }
          }
          return true;
        })()`);
        if (hit === "bad-selector") throw new Error(`无效的 CSS 选择器：${wantSelector}`);
        if (hit) return { waited: true, condition: wantText || wantSelector, url: this.state.url };
      } catch (error) {
        if (error?.message?.includes("无效的 CSS 选择器")) throw error;
      }
      await sleep(400);
    }
    throw new Error(`等待超时：${wantText ? `页面未出现文本「${wantText}」` : ""}${wantText && wantSelector ? " 且 " : ""}${wantSelector ? `未出现元素 ${wantSelector}` : ""}（可先 browser_snapshot 查看当前页面）`);
  }

  async screenshot() {
    await this.ensureStarted();
    const result = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    const data = result.data || "";
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `shot-${Date.now()}.jpg`);
    try { fs.writeFileSync(file, Buffer.from(data, "base64")); } catch {}
    // 截图目录只保留最近 30 张，避免无限增长
    try {
      const shots = fs.readdirSync(SHOT_DIR).filter((name) => name.startsWith("shot-")).sort();
      for (const stale of shots.slice(0, Math.max(0, shots.length - 30))) {
        fs.rmSync(path.join(SHOT_DIR, stale), { force: true });
      }
    } catch {}
    this.frame = { data, at: Date.now(), width: this.state.viewport.width, height: this.state.viewport.height };
    this.queueFrameBroadcast({ data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
    return { file, bytes: Buffer.byteLength(data, "base64"), url: this.state.url };
  }

  async back({ agent = false } = {}) {
    await this.ensureStarted();
    if (agent) await this.emitAgentAction("back", null, {});
    await this.evaluate("history.back()");
    await sleep(800);
    await this.waitForLoad(8000).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return this.stateView();
  }

  async close() {
    const child = this.child;
    const port = this.port;
    this.state.active = false;
    this.clearFrameBroadcast();
    this.frame = null;
    this.emitState();
    broadcast(this.key, "closed", {});
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.child = null;
    // 其他会话还在共享同一浏览器实例（同 profile 复用）时不结束进程、不清端口文件
    const remainingUsers = releaseBrowserPort(port, this.key);
    if (!port || remainingUsers > 0) return;
    try {
      const recorded = String(fs.readFileSync(this.portFile, "utf8")).trim();
      if (!recorded || recorded === String(port)) fs.rmSync(this.portFile, { force: true });
    } catch {}
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await response.json();
      for (const target of list.filter((item) => item.type === "page")) {
        fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
      }
    } catch {}
    if (child?.pid) {
      await new Promise((resolve) => {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        setTimeout(resolve, 3000);
      });
    } else {
      // 复用模式（无子进程句柄）：通过浏览器级 CDP 优雅关闭
      try {
        const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        const version = await versionResponse.json();
        if (version?.webSocketDebuggerUrl) {
          const browserConnection = new CdpConnection(version.webSocketDebuggerUrl);
          await browserConnection.ready;
          await browserConnection.send("Browser.close").catch(() => {});
          browserConnection.close();
        }
      } catch {}
    }
  }
}

export function getBrowserSession(key) {
  return sessions.get(key) || null;
}

/**
 * 获取活动会话；服务重启后若浏览器进程仍存活，自动复用重连（无需重新 open）。
 */
async function requireActiveSession(key) {
  let session = sessions.get(key);
  if (!session) {
    session = await sessionFor(key);
    const reused = await session.tryReuse().catch(() => false);
    if (!reused) {
      sessions.delete(key); // 复用失败不留空会话，保持注册表干净
      const error = new Error("浏览器尚未启动，请先调用 browser_open 打开网页");
      error.code = "BROWSER_NOT_STARTED";
      throw error;
    }
  }
  if (!session.state.active) {
    const error = new Error("浏览器尚未启动，请先调用 browser_open 打开网页");
    error.code = "BROWSER_NOT_STARTED";
    throw error;
  }
  return session;
}

async function sessionFor(key) {
  if (!sessions.has(key)) sessions.set(key, new BrowserSession(key));
  return sessions.get(key);
}

/** 打开/切换页面（首次调用会启动浏览器；URL 非法时不启动）。 */
export async function browserOpen(key, url, { agent = false } = {}) {
  const target = normalizeNavUrl(url); // 先校验，避免为无效地址启动浏览器
  const session = await sessionFor(key);
  await session.ensureStarted();
  return session.navigate(target, { agent });
}

/** 观察页面：可交互元素编号清单 + 正文摘要。 */
export async function browserSnapshot(key) {
  const session = await requireActiveSession(key);
  return session.snapshot();
}

export async function browserClick(key, ref) {
  return (await requireActiveSession(key)).click(ref, { agent: true });
}

export async function browserType(key, ref, text, options = {}) {
  return (await requireActiveSession(key)).type(ref, text, { ...options, agent: true });
}

export async function browserPress(key, pressKey) {
  return (await requireActiveSession(key)).press(pressKey, { agent: true });
}

export async function browserScroll(key, direction, amount) {
  return (await requireActiveSession(key)).scroll(direction, amount, { agent: true });
}

export async function browserScreenshot(key) {
  return (await requireActiveSession(key)).screenshot();
}

export async function browserBack(key) {
  return (await requireActiveSession(key)).back({ agent: true });
}

export async function browserForward(key) {
  return (await requireActiveSession(key)).forward({ agent: true });
}

export async function browserHover(key, ref) {
  return (await requireActiveSession(key)).hover(ref, { agent: true });
}

export async function browserSelect(key, ref, options = {}) {
  return (await requireActiveSession(key)).selectOption(ref, { ...options, agent: true });
}

export async function browserWait(key, options = {}) {
  return (await requireActiveSession(key)).wait(options);
}

/** Agent 在页面上执行 JS（精确取数/批量收集），结果经 returnByValue 返回。 */
export async function browserEvaluate(key, expression) {
  const session = await requireActiveSession(key);
  const code = String(expression || "").trim();
  if (!code) throw new Error("表达式不能为空");
  if (code.length > 20000) throw new Error("表达式过长（上限 20000 字符）");
  const result = await session.cdp.send("Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "页面脚本执行失败";
    throw new Error(String(detail).slice(0, 500));
  }
  return { value: result.result?.value, url: session.state.url };
}

/** 用户接管：把面板上的点击/输入/导航/滚轮转发到页面。 */
export async function browserUserInput(key, payload = {}) {
  const session = await requireActiveSession(key);
  session.lastUserInputAt = Date.now();
  const action = String(payload.action || "");
  if (action === "navigate") return session.navigate(payload.url);
  if (action === "forward") return session.forward();
  if (action === "click") {
    const point = await session.resolvePoint(payload);
    const clickCount = Math.max(1, Math.min(3, Number(payload.clickCount) || 1));
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount, buttons: 1 });
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount, buttons: 0 });
    return { clicked: point };
  }
  // 拖拽（滑块验证码、画布、文本选择等）：按下 → 多次移动 → 抬起；hover 仅同步光标位置
  if (action === "pointer") {
    const point = await session.resolvePoint(payload);
    const phase = String(payload.phase || "move");
    const isRight = payload.button === "right";
    const button = isRight ? "right" : "left";
    const buttonsDown = isRight ? 2 : 1;
    const clickCount = Math.max(1, Math.min(3, Number(payload.clickCount) || 1));
    if (phase === "hover") {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0, buttons: 0 });
      return { pointer: "hover", point };
    }
    if (phase === "down") {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0, buttons: 0 });
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount, buttons: buttonsDown });
    } else if (phase === "up") {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount, buttons: 0 });
    } else {
      await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button, buttons: buttonsDown });
    }
    return { pointer: phase, point };
  }
  if (action === "resize") return session.resize(payload.width, payload.height);
  if (action === "wheel") {
    const point = await session.resolvePoint(payload);
    const deltaY = Math.max(-3000, Math.min(3000, Number(payload.deltaY) || 0));
    const deltaX = Math.max(-3000, Math.min(3000, Number(payload.deltaX) || 0));
    await session.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, button: "none" });
    return { wheel: { deltaX, deltaY } };
  }
  if (action === "type") {
    await session.cdp.send("Input.insertText", { text: String(payload.text ?? "") });
    return { typed: String(payload.text ?? "").length };
  }
  if (action === "key") return session.press(payload.key || "Enter", { modifiers: payload.modifiers });
  if (action === "scroll") return session.scroll(payload.direction || "down", payload.amount);
  if (action === "back") return session.back();
  if (action === "forward") return session.forward();
  if (action === "reload") return session.reload();
  if (action === "tab_new") return session.newTab(payload.url || "about:blank");
  if (action === "tab_switch") return session.switchToTarget(String(payload.tabId || ""));
  if (action === "tab_close") return session.closeTab(String(payload.tabId || ""));
  if (action === "tabs") return { tabs: await session.refreshTabs() };
  throw new Error(`不支持的操作：${action}`);
}

/** Agent 侧标签页管理：list / new / switch / close。 */
export async function browserTabs(key, action = "list", tabId = "", url = "") {
  const session = await requireActiveSession(key);
  if (action === "list") return { tabs: await session.refreshTabs() };
  if (action === "new") return session.newTab(url || "about:blank", { agent: true });
  if (action === "switch") return session.switchToTarget(String(tabId || ""), { agent: true });
  if (action === "close") return session.closeTab(String(tabId || ""), { agent: true });
  throw new Error(`不支持的标签页操作：${action}`);
}

/**
 * 关闭浏览器。默认保护用户接管：用户 3 分钟内操作过时拒绝关闭，
 * 只有面板的“强制关闭”（force）或用户明确要求才真正关闭。
 */
export async function browserClose(key, { force = false, reason = "" } = {}) {
  const session = sessions.get(key);
  if (!session) return { closed: false, message: "没有运行中的浏览器" };
  const recent = session.lastUserInputAt && Date.now() - session.lastUserInputAt < 3 * 60 * 1000;
  if (!force && recent) {
    return {
      closed: false,
      kept: true,
      message: "用户刚刚在浏览器中操作过，已保留浏览器（如确需关闭，请让用户点击面板右上角关闭，或稍后再试）。",
    };
  }
  await session.close();
  sessions.delete(key);
  return { closed: true, reason };
}

/** 服务退出时清理所有浏览器进程。 */
export function shutdownBrowsers() {
  for (const [key, session] of sessions.entries()) {
    try { session.close(); } catch {}
    sessions.delete(key);
  }
}

process.on("exit", () => {
  for (const session of sessions.values()) {
    if (session.child?.pid) {
      try { session.child.kill(); } catch {}
    }
  }
});

export function browserStoreInfo() {
  return {
    profileDir: PROFILE_DIR,
    shotDir: SHOT_DIR,
    executable: findBrowserExecutable(),
    headless: process.env.OAW_BROWSER_HEADLESS !== "0",
    sessions: [...sessions.keys()],
  };
}
