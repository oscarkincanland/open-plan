#!/usr/bin/env node
/**
 * WP-S1 长连接预算回归测试：
 * 1. 同 (path, client, tab, thread) 只保留 1 条流；
 * 2. 同一 client+tab 最多 4 条，超出收掉最旧；
 * 3. 不同 tab 互不干扰（不再因共享 clientId 互相踢）；
 * 4. 超寿命流判定（sweep 会强制回收）。
 *
 * 用法: node scripts/长连接预算测试.mjs
 */
import assert from "node:assert/strict";
import {
  isStreamExpired,
  listServerStreams,
  registerServerStream,
  releaseServerStream,
  serverStreamStats,
  streamKeyOf,
  streamQuotaPolicy,
} from "../server/流连接.mjs";

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const noop = () => {};

console.log("\n▶ S1 配额策略");

test("配额：同键 1 条、每 client+tab 4 条、单流寿命 > 1 小时", () => {
  const policy = streamQuotaPolicy();
  assert.equal(policy.maxSameKey, 1);
  assert.equal(policy.maxPerClientTab, 4);
  assert.ok(policy.maxAgeMs >= 60 * 60_000);
  assert.equal(policy.supersede["/api/agent/stream"].keep, 1);
  assert.equal(policy.supersede["/api/agent/events"].keep, 1);
});

test("streamKey 包含 tab（两个标签页不再共享同键）", () => {
  const a = streamKeyOf({ path: "/api/agent/stream", client: "c", tab: "t1", thread: "x" });
  const b = streamKeyOf({ path: "/api/agent/stream", client: "c", tab: "t2", thread: "x" });
  assert.notEqual(a, b);
});

console.log("\n▶ S1 同键去重");

{
  let closedFirst = 0;
  const first = registerServerStream({ path: "/api/agent/stream", client: "c1", tab: "t1", thread: "th1", close: () => { closedFirst += 1; } });
  const second = registerServerStream({ path: "/api/agent/stream", client: "c1", tab: "t1", thread: "th1", close: noop });
  test("同键只保留 1 条，旧流被收掉", () => {
    assert.equal(closedFirst, 1);
    assert.ok(second.replaced.some((item) => item.reason === "same-key"));
    const sameKey = listServerStreams().filter((item) => item.path === "/api/agent/stream" && item.client === "c1" && item.tab === "t1" && item.thread === "th1");
    assert.equal(sameKey.length, 1);
  });
  releaseServerStream(second.id);
}

console.log("\n▶ S1 每 client+tab 上限与跨标签页隔离");

{
  for (let index = 0; index < 4; index += 1) {
    registerServerStream({ path: `/api/test/${index}`, client: "c2", tab: "t1", close: noop });
  }
  const overflow = registerServerStream({ path: "/api/test/overflow", client: "c2", tab: "t1", close: noop });
  test("第 5 条触发 client-limit，总量回到 4", () => {
    assert.ok(overflow.replaced.some((item) => item.reason === "client-limit"));
    const count = listServerStreams().filter((item) => item.client === "c2" && item.tab === "t1").length;
    assert.equal(count, 4);
  });
  const otherTab = registerServerStream({ path: "/api/agent/events", client: "c2", tab: "t2", thread: "", close: noop });
  test("另一个标签页不受影响", () => {
    assert.equal(otherTab.replaced.length, 0);
    assert.equal(listServerStreams().filter((item) => item.client === "c2" && item.tab === "t2").length, 1);
  });
}

console.log("\n▶ S1 寿命回收");

test("超寿命流判定", () => {
  const maxAge = streamQuotaPolicy().maxAgeMs;
  assert.equal(isStreamExpired({ openedAt: Date.now() - maxAge - 1000 }), true);
  assert.equal(isStreamExpired({ openedAt: Date.now() }), false);
  assert.equal(isStreamExpired(null), false);
});

test("统计包含 tab 维度", () => {
  const stats = serverStreamStats();
  assert.ok(stats.byPath["/api/test/overflow"] >= 1);
  const item = listServerStreams().find((entry) => entry.path === "/api/test/overflow");
  assert.equal(item.tab, "t1");
});

console.log(failed ? "\n✗ 长连接预算测试存在失败" : "\n✓ 长连接预算测试全部通过");
process.exitCode = failed ? 1 : 0;
