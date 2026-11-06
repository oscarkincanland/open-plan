/**
 * 跨标签页 SSE 总配额（浏览器同源连接池保护）。
 *
 * ## 为什么需要这一层
 *
 * 浏览器同源 HTTP/1.1 只有 6 个连接槽，SSE 长连接会长期占住其中一格。
 * 一旦占满，控制面请求（会话列表 / 文件列表 / 项目列表）只会永远排队：
 * 服务端完全空闲，页面却显示"读取失败，已保留上一次可用数据"。
 *
 * 实测（2026-11-02，Chrome）：浏览器里占满 6 条 SSE 后，
 * `GET /api/sessions` 挂死满 8 秒才超时（= apiControl 的 CONTROL_TIMEOUT_MS），
 * 与控制面超时的报错文案完全一致。
 *
 * 既有防护只有两层，都不覆盖多标签页：
 *   - `长连接预算.js` 的 MAX_STREAMS 是**每标签页**上限（3）；
 *   - `跨标签页流租约.js` 只对**全局事件流**去重（每 origin 一条）。
 * 于是 3 个标签页 × 最多 3 条流 − 2 条重复的全局流 = **7 条 > 6 槽**，控制面饿死。
 *
 * 本模块补第三层：**跨标签页总数**上限。
 *
 * ## 机制
 *
 * 每个标签页把自己的活跃流登记到 localStorage 的独立键
 * （`oaw_stream_quota:<tabId>`）；全局计数 = 各存活标签页（心跳未过期）之和。
 * 标签页之间用 BroadcastChannel 通知"我释放了/请释放可放弃的流"，让槽位立刻归还，
 * 不必等心跳超时。
 *
 * ## 额度口径
 *
 * GLOBAL_MAX_STREAMS = 4：留出 2 个槽位给控制面。
 *   - 可放弃流（记忆变更流 / 浏览器帧流）：全局达到上限即拒绝申请，等空位再连；
 *   - 必需流（对话流 / 全局事件流）：**永不拒绝**（拒绝了对话就废了），
 *     但会先释放本标签页的可放弃流，并广播请求其他标签页让出可放弃流。
 *
 * 典型场景：
 *   - 1 标签页：对话流 + 全局事件流 = 2，面板流照常开（受每标签页 3 条上限约束）；
 *   - 2 标签页：3 条必需流，面板流只允许再开 1 条；
 *   - 3 标签页：4 条必需流（3 对话 + 1 全局），面板流全部让位 → 留 2 槽给控制面。
 */

import { getQuotaTabId } from "./标签页标识.js";

/** 全部标签页合计的 SSE 上限：6 槽里留 2 个给控制面。 */
export const GLOBAL_MAX_STREAMS = 4;

/** 标签页心跳超时（毫秒）：超过这个时间没心跳就视为标签页已关闭。 */
const ENTRY_TTL_MS = 15000;
/** 心跳间隔（毫秒）。 */
const HEARTBEAT_MS = 3000;
/** localStorage 键前缀（每个标签页一个独立键，避免互相覆盖）。 */
const KEY_PREFIX = "oaw_stream_quota:";
/** 跨标签页通知频道。 */
const CHANNEL_NAME = "oaw_stream_quota_v1";

const TAB_ID = getQuotaTabId();

/** 本标签页的活跃流：key → { kind, essential, priority }。 */
const localStreams = new Map();
/** 收到"请释放可放弃流"广播的订阅者。 */
const releaseListeners = new Set();

let channel = null;
let heartbeatTimer = null;

function readEntry(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && value.tabId ? value : null;
  } catch {
    return null;
  }
}

function writeEntry() {
  try {
    const key = `${KEY_PREFIX}${TAB_ID}`;
    if (!localStreams.size) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({
      tabId: TAB_ID,
      at: Date.now(),
      streams: [...localStreams.values()].map((item) => ({ kind: item.kind, essential: item.essential, priority: item.priority })),
    }));
  } catch {
    /* 隐私模式 / 配额满：登记失败只是失去跨标签页视野，不影响本标签页 */
  }
}

function liveEntries() {
  const entries = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const entry = readEntry(key);
      if (!entry) {
        try { localStorage.removeItem(key); } catch {}
        continue;
      }
      // 心跳过期 = 标签页已关闭（崩溃/关闭/休眠唤醒），其流不再占槽。
      if (Date.now() - Number(entry.at || 0) > ENTRY_TTL_MS) {
        try { localStorage.removeItem(key); } catch {}
        continue;
      }
      entries.push(entry);
    }
  } catch {
    return [];
  }
  return entries;
}

function ensureChannel() {
  if (channel !== null) return channel;
  // 只在浏览器里建频道：Node 有全局 BroadcastChannel，建了会让测试进程不退出。
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    channel = null;
    return channel;
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  if (channel) {
    channel.onmessage = (event) => {
      const message = event?.data || {};
      if (message.tabId === TAB_ID) return;
      if (message.type === "release-optional") {
        for (const listener of [...releaseListeners]) {
          try { listener(message.reason || ""); } catch {}
        }
      }
    };
  }
  return channel;
}

function ensureHeartbeat() {
  if (heartbeatTimer !== null) return;
  if (typeof window === "undefined") return;
  heartbeatTimer = setInterval(() => {
    if (!localStreams.size) {
      stopHeartbeat();
      return;
    }
    writeEntry();
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 全部标签页当前占用的 SSE 条数（含本标签页）。
 * 读不到 localStorage 时回退为本标签页计数（保守：宁可少算也不误杀）。
 */
export function globalStreamCount() {
  const entries = liveEntries();
  if (!entries.length) return localStreams.size;
  let total = 0;
  for (const entry of entries) total += Array.isArray(entry.streams) ? entry.streams.length : 0;
  return total;
}

/** 全局占用明细（按标签页分组），用于诊断。 */
export function globalStreamSnapshot() {
  return liveEntries().map((entry) => ({
    tabId: entry.tabId,
    count: Array.isArray(entry.streams) ? entry.streams.length : 0,
    kinds: (entry.streams || []).map((item) => item.kind),
    ageMs: Date.now() - Number(entry.at || 0),
  }));
}

/** 登记本标签页的一条流。 */
export function registerQuotaStream(key, { kind = "", essential = false, priority = 5 } = {}) {
  localStreams.set(key, { kind, essential, priority });
  writeEntry();
  ensureChannel();
  ensureHeartbeat();
  return globalStreamCount();
}

/** 注销本标签页的一条流。 */
export function unregisterQuotaStream(key) {
  if (!localStreams.delete(key)) return globalStreamCount();
  writeEntry();
  if (!localStreams.size) stopHeartbeat();
  return globalStreamCount();
}

/**
 * 广播请求其他标签页释放可放弃的流。
 * 控制面请求超时、或本标签页需要为必需流腾位时调用。
 */
export function requestOthersReleaseOptional(reason = "") {
  const ch = ensureChannel();
  if (!ch) return 0;
  try {
    ch.postMessage({ type: "release-optional", tabId: TAB_ID, reason, at: Date.now() });
    return 1;
  } catch {
    return 0;
  }
}

/** 订阅"请释放可放弃流"的广播（标签页内部据此回收面板流）。 */
export function onRemoteReleaseRequest(listener) {
  releaseListeners.add(listener);
  ensureChannel();
  return () => releaseListeners.delete(listener);
}

/** 测试用：清空本标签页登记并移除自己的 localStorage 键。 */
export function resetQuotaStreams() {
  localStreams.clear();
  stopHeartbeat();
  try { localStorage.removeItem(`${KEY_PREFIX}${TAB_ID}`); } catch {}
}
