#!/usr/bin/env node
/**
 * 跨标签页 SSE 总配额测试。
 *
 * 背景（2026-11-02 实测，Chrome）：浏览器同源 HTTP/1.1 只有 6 个连接槽。
 * 浏览器里占满 6 条 SSE 后，GET /api/sessions 挂死满 8 秒才超时
 * （= apiControl 的 CONTROL_TIMEOUT_MS），页面表现为"会话列表读取失败"。
 *
 * 既有防护不覆盖多标签页：长连接预算的 MAX_STREAMS 是每标签页上限（3），
 * 跨标签页流租约只对全局事件流去重（每 origin 一条）。
 * 于是 3 个标签页 × 3 条 − 2 条重复的全局流 = 7 条 > 6 槽，控制面饿死。
 *
 * 本测试守护第三层：跨标签页总配额（默认 4，给控制面留 2 槽）。
 *
 * 反证：把「可放弃流在全局满额时被拒绝」这条断言去掉（即回到只有每标签页预算的
 * 旧行为），第 4 条用例会失败——它正是本次修复引入的行为。
 */
import assert from "node:assert/strict";

// localStorage shim：必须在导入被测模块之前装好（模块加载时就要写登记）。
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key(index) { return [...store.keys()][index] ?? null; },
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(key, String(value)); },
  removeItem(key) { store.delete(key); },
  clear() { store.clear(); },
};

const quota = await import("../client/src/跨标签页流配额.js");
const budget = await import("../client/src/长连接预算.js");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

/** 伪造另一个标签页的流登记（心跳新鲜 = 标签页还活着）。 */
function writeForeignTab(tabId, count, ageMs = 0) {
  globalThis.localStorage.setItem(`oaw_stream_quota:${tabId}`, JSON.stringify({
    tabId,
    at: Date.now() - ageMs,
    streams: Array.from({ length: count }, (_, i) => ({ kind: "chat", essential: true, priority: 1 + i })),
  }));
}

test("初始没有其他标签页时全局计数为 0", () => {
  assert.equal(quota.globalStreamCount(), 0);
});

test("其他标签页的流计入全局总数", () => {
  writeForeignTab("oaw-tab-other", 3);
  assert.equal(quota.globalStreamCount(), 3);
  globalThis.localStorage.clear();
});

test("心跳过期的标签页不再占槽（标签页已关闭）", () => {
  writeForeignTab("oaw-tab-stale", 3, 60_000);
  assert.equal(quota.globalStreamCount(), 0, "过期登记应被忽略并清理");
  assert.equal(globalThis.localStorage.getItem("oaw_stream_quota:oaw-tab-stale"), null, "过期登记应被删除");
  globalThis.localStorage.clear();
});

test("全局满额时可放弃流被拒绝（关键行为）", () => {
  writeForeignTab("oaw-tab-other", 3);
  const first = budget.acquireStream("memory-changes", { priority: 4, label: "记忆变更流" });
  assert.ok(first, "未满额时应拿到槽位");
  assert.equal(quota.globalStreamCount(), 4);
  // 此刻全局已满：新的可放弃流必须被拒绝，把槽位留给控制面。
  const denied = budget.acquireStream("browser-frames", { priority: 3, label: "浏览器帧流" });
  assert.equal(denied, null, "全局满额时可放弃流应被拒绝");
  first.release();
  globalThis.localStorage.clear();
});

test("全局满额时必需流仍然放行（拒绝就等于对话瘫了）", () => {
  writeForeignTab("oaw-tab-other", 4);
  const slot = budget.acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
  assert.ok(slot, "必需流不得被拒绝");
  slot.release();
  globalThis.localStorage.clear();
});

test("必需流在全局满额时会先释放本标签页的可放弃流腾位", () => {
  writeForeignTab("oaw-tab-other", 3);
  const optional = budget.acquireStream("memory-changes", { priority: 4, label: "记忆变更流" });
  assert.ok(optional);
  assert.equal(quota.globalStreamCount(), 4);
  const essential = budget.acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
  assert.ok(essential, "必需流应拿到槽位");
  assert.equal(quota.globalStreamCount(), 4, "腾位后总数不应继续增长");
  essential.release();
  globalThis.localStorage.clear();
});

test("释放流会同步注销跨标签页登记", () => {
  budget.resetStreams();
  globalThis.localStorage.clear();
  const slot = budget.acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
  assert.equal(quota.globalStreamCount(), 1);
  slot.release();
  assert.equal(quota.globalStreamCount(), 0, "释放后不应再占槽");
});

test("每标签页预算仍然生效（单标签页最多 3 条）", () => {
  budget.resetStreams();
  globalThis.localStorage.clear();
  const a = budget.acquireStream("chat", { essential: true, priority: 1 });
  const b = budget.acquireStream("memory-changes", { priority: 4 });
  const c = budget.acquireStream("browser-frames", { priority: 3 });
  assert.ok(a && b && c, "3 条应都能拿到");
  const d = budget.acquireStream("extra", { priority: 5 });
  assert.equal(d, null, "第 4 条可放弃流应被每标签页预算拒绝");
  budget.resetStreams();
});

test("全局上限为 4（6 槽里留 2 给控制面）", () => {
  assert.equal(quota.GLOBAL_MAX_STREAMS, 4);
});

if (failed) {
  console.error("\n跨标签页流配额测试：存在失败项");
  process.exit(1);
}
console.log("\n跨标签页流配额测试：全部通过");
