/**
 * 跨标签页全局事件流租约（阶段 A）。
 *
 * 浏览器同源 HTTP/1.1 只有 6 个连接；每个标签页若都连“全局事件流 + 对话流”，
 * 3 个标签页就会占满连接池。这里让同一 origin 只保留一个标签页持有全局事件流：
 * - leader 连 `/api/agent/events`，并把事件通过 BroadcastChannel 广播；
 * - follower 不连全局流，只接收广播（对话流仍按标签页保留）；
 * - leader 崩溃/关闭后，租约过期或 resign 消息触发重新选举。
 *
 * 不支持 BroadcastChannel/localStorage 的环境直接退化为原行为（每个标签页自连）。
 */

const LEASE_KEY = "oaw_global_events_leader_v1";
const CHANNEL_NAME = "oaw_global_events_v1";
const LEASE_MS = 8000;
const HEARTBEAT_MS = 2500;
const CHECK_MS = 3000;
// 必须是“每标签页唯一、刷新后稳定”的 id。sessionStorage 在部分浏览器的
// 新标签页场景会被克隆，不能作为唯一依据；window.name 按浏览上下文隔离。
const TAB_ID = (() => {
  try {
    const existing = typeof window !== "undefined" ? String(window.name || "") : "";
    if (existing.startsWith("oaw-tab-")) return existing;
    const id = `oaw-tab-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    if (typeof window !== "undefined") window.name = id;
    return id;
  } catch {
    return `oaw-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

function readLease() {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && value.tabId ? value : null;
  } catch {
    return null;
  }
}

function writeLease() {
  try { localStorage.setItem(LEASE_KEY, JSON.stringify({ tabId: TAB_ID, at: Date.now() })); } catch {}
}

function clearLease() {
  try {
    const current = readLease();
    if (current?.tabId === TAB_ID) localStorage.removeItem(LEASE_KEY);
  } catch {}
}

export function createGlobalEventsLease({ onStart, onStop, onEvent } = {}) {
  const supported = typeof BroadcastChannel !== "undefined" && typeof localStorage !== "undefined";
  if (!supported) {
    onStart?.();
    const fallback = { tabId: TAB_ID, isLeader: () => true, publish() {}, stop() {} };
    if (typeof window !== "undefined") window.__oawGlobalLease = fallback;
    return fallback;
  }

  const channel = new BroadcastChannel(CHANNEL_NAME);
  let stopped = false;
  let leader = false;
  let heartbeat = null;
  let checker = null;

  const post = (message) => { try { channel.postMessage(message); } catch {} };
  const announce = () => post({ type: "leader", tabId: TAB_ID, at: Date.now() });
  const becomeLeader = () => {
    if (stopped || leader) return;
    leader = true;
    writeLease();
    onStart?.();
    announce();
    // 两个标签页同时 claim 时，广播消息可能晚到；稍后再按租约内容仲裁一次。
    window.setTimeout(() => assertLeaseOwnership(), 300);
    heartbeat = setInterval(() => {
      if (!leader) return;
      assertLeaseOwnership();
      if (leader) writeLease();
    }, HEARTBEAT_MS);
  };
  const assertLeaseOwnership = () => {
    if (!leader || stopped) return;
    const current = readLease();
    if (!current || current.tabId === TAB_ID) return;
    const fresh = Date.now() - Number(current.at || 0) <= LEASE_MS;
    // 行内更小的 tabId 优先；广播丢失时靠这条规则收敛，不会两个 leader 互相覆盖。
    if (fresh && String(current.tabId) < TAB_ID) stepDown();
  };
  const stepDown = () => {
    if (!leader) return;
    leader = false;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    onStop?.();
  };
  const claim = () => {
    const current = readLease();
    if (!current || current.tabId === TAB_ID || Date.now() - Number(current.at || 0) > LEASE_MS) {
      writeLease();
      return true;
    }
    return false;
  };
  const maybePromote = () => {
    if (stopped || leader) return;
    const current = readLease();
    if (!current || Date.now() - Number(current.at || 0) > LEASE_MS) {
      if (claim()) becomeLeader();
    }
  };

  channel.onmessage = (event) => {
    const message = event.data || {};
    if (message.tabId === TAB_ID) return;
    if (message.type === "event") {
      onEvent?.(message.payload);
      return;
    }
    if (message.type === "leader") {
      if (leader) {
        // 两个标签页同时 claim 时，用 tabId 字典序确定唯一 leader。
        if (String(message.tabId) < TAB_ID) stepDown();
      } else {
        maybePromote();
      }
      return;
    }
    if (message.type === "resign") maybePromote();
  };
  const onStorage = (event) => {
    if (event.key === LEASE_KEY) maybePromote();
  };
  const onPageHide = () => {
    if (!leader) return;
    clearLease();
    post({ type: "resign", tabId: TAB_ID });
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("pagehide", onPageHide);

  if (claim()) becomeLeader();
  checker = setInterval(maybePromote, CHECK_MS);

  const handle = {
    tabId: TAB_ID,
    isLeader: () => leader,
    publish(payload) { if (leader && !stopped) post({ type: "event", tabId: TAB_ID, payload }); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (checker) clearInterval(checker);
      checker = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", onPageHide);
      if (leader) clearLease();
      stepDown();
      try { channel.close(); } catch {}
      if (typeof window !== "undefined" && window.__oawGlobalLease?.tabId === TAB_ID) {
        try { delete window.__oawGlobalLease; } catch {}
      }
    },
  };
  if (typeof window !== "undefined") window.__oawGlobalLease = handle;
  return handle;
}
