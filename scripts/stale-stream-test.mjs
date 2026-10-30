/**
 * P1-6 陈旧流停摆测试（Qoder 对标，开关 staleStreamSuspend 默认关）：
 *   - 开关开：同键新流接管后，宽限期外的旧流标记 stale（停推数据帧、保留心跳）；
 *     同键上限（MAX_SAME_KEY=2）仍先硬关最旧流，stale 落在存活的次旧流上；
 *     不同 thread 的流互不影响；宽限期内并存不判旧。
 *   - 开关关（基线）：旧流照常推送，永不标记 stale（子进程单独验证）。
 * 纯逻辑测试：直接驱动 流连接.mjs 的登记表，不依赖真实 SSE。
 * 注：/api/browser/stream 的宽限期为 5s，等待 5.2s 即可越过。
 */
import assert from "node:assert/strict";

const ROLE = String(process.env.STALE_TEST_ROLE || "");

if (!ROLE) {
  // ── 父进程：先用「开关关」跑基线子进程，再本进程跑「开关开」套件 ──
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, [self], {
    stdio: "inherit",
    env: { ...process.env, STALE_TEST_ROLE: "baseline", OAW_QODER_ALIGN: "0", OAW_STALE_STREAM_SUSPEND: "0" },
  });
  if (child.status !== 0) {
    console.error("陈旧流停摆测试：基线（开关关）子进程失败");
    process.exit(1);
  }
  process.env.OAW_QODER_ALIGN = "0";
  process.env.OAW_STALE_STREAM_SUSPEND = "1"; // 必须在 import 前设置：开关在模块加载时解析一次
} else if (ROLE === "baseline") {
  // ── 基线套件（开关关 = 与历史行为逐字一致）：永不标记 stale ──
  const { registerServerStream, isStreamStale } = await import("../server/流连接.mjs");
  const a = registerServerStream({ path: "/api/browser/stream", client: "b1", thread: "t1", close: () => {}, probe: () => true });
  await new Promise((r) => setTimeout(r, 5200));
  registerServerStream({ path: "/api/browser/stream", client: "b1", thread: "t1", close: () => {}, probe: () => true });
  if (isStreamStale(a.id) !== false) {
    console.error("✗ 基线（开关关）：旧流不应被标记 stale");
    process.exit(1);
  }
  console.log("  ✓ 基线（开关关）：接管后旧流照常推送，不标 stale");
  process.exit(0);
}

// ── 开关开套件（主进程）──
const { registerServerStream, releaseServerStream, isStreamStale, listServerStreams } = await import("../server/流连接.mjs");

const PASS = [];
const step = (name, fn) => { try { fn(); PASS.push(name); } catch (e) { console.error(`✗ ${name}: ${e.message}`); process.exitCode = 1; } };
const noClose = () => {};

// 1. 同键先后注册：宽限期内旧流不判旧（组件切换短暂重叠）
const a = registerServerStream({ path: "/api/browser/stream", client: "c1", thread: "t1", close: noClose, probe: () => true });
const b = registerServerStream({ path: "/api/browser/stream", client: "c1", thread: "t1", close: noClose, probe: () => true });
step("宽限期内不标 stale", () => {
  assert.equal(isStreamStale(a.id), false, "宽限期内旧流不应标记 stale");
  assert.equal(isStreamStale(b.id), false);
});

// 2. 宽限期后同键再注册：同键上限先硬关最旧流 a，stale 落在存活的次旧流 b 上
await new Promise((r) => setTimeout(r, 5200));
const c = registerServerStream({ path: "/api/browser/stream", client: "c1", thread: "t1", close: noClose, probe: () => true });
step("宽限期后接管标记 stale", () => {
  assert.ok(c.replaced.some((r) => r.id === a.id && r.reason === "same-key"), "最旧流 a 应被同键上限收掉");
  assert.equal(isStreamStale(a.id), false, "a 已移出登记表，查询安全回落 false");
  assert.equal(isStreamStale(b.id), true, "宽限期外的次旧流 b 应标记 stale");
  assert.equal(isStreamStale(c.id), false, "最新流不应标记 stale");
});

// 诊断清单暴露 stale 字段（在注册 d 之前检查，避免被同 path/client/tab 的 supersede 收掉）
step("listServerStreams 暴露 stale 字段", () => {
  const item = listServerStreams().find((s) => s.id === b.id);
  assert.ok(item, "清单应包含存活的流");
  assert.equal(item.stale, true, "b 在清单中应标记 stale");
  assert.ok("staleAt" in item, "应含 staleAt 字段");
});

// 3. 不同 thread 的流不互标（多标签页看不同会话）
const d = registerServerStream({ path: "/api/browser/stream", client: "c1", thread: "t2", close: noClose, probe: () => true });
step("不同 thread 不互标", () => {
  assert.equal(isStreamStale(d.id), false, "不同会话的流不受接管影响");
  assert.equal(isStreamStale(c.id), false);
});

// 4. release 后 stale 查询安全回落
releaseServerStream(a.id);
step("release 后 isStreamStale 回落 false", () => assert.equal(isStreamStale(a.id), false));

console.log(`陈旧流停摆测试：${process.exitCode ? "失败" : "通过"}（开关开 ${PASS.length} 项 + 基线子进程 1 项）`);
for (const name of PASS) console.log(`  ✓ ${name}`);
