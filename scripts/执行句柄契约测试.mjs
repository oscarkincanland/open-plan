#!/usr/bin/env node
/**
 * 统一执行句柄契约测试（Qoder 对标 P1-1）。
 *
 * 1) 句柄暴露七个方法：执行 / 中断 / 响应交互 / 释放 / 订阅 / 可用性 / 能力；
 * 2) 可用性() 三态可达：ready（空闲）/ busy（执行中）/ disconnected（运行时掉线）；
 * 3) 中断之后仍可再次执行（中断不把句柄锁死）；
 * 4) 订阅能收到状态变化，退订后不再收到；
 * 5) 释放会摘掉会话占用并销毁 Runtime；
 * 6) 能力() 自述与实际动作一致。
 *
 * 用法：node scripts/执行句柄契约测试.mjs
 */
import assert from "node:assert/strict";
import { 创建执行句柄 } from "../server/执行句柄.mjs";

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

// ---- 替身：全部依赖注入，测试不触碰真实 Pi Runtime 与工作区 ----

function 假运行时({ busy = false, health = "healthy" } = {}) {
  const sessions = new Map();
  const 记录 = { 中断: [], 释放: [], 提交: [], 派发: [] };
  return {
    记录,
    sessions,
    manager: {
      sessions,
      pendingAsks: new Map(),
      runtimeSnapshot: () => ({ status: "healthy", health: { status: "healthy" } }),
      runtimeHealth: () => ({ status: health === "failed" ? "failed" : "ok", health: { status: health } }),
      resolveLiveEntry: (key) => sessions.get(key) || null,
      listRuntimes: () => [...sessions.values()],
      promptWithContext: async (key, text) => { 记录.派发.push({ key, text }); },
      abort: async (key, options) => { 记录.中断.push({ key, runId: options?.runId || null }); return { ok: true, aborted: true }; },
      submitAnswer: (key, answer) => { 记录.提交.push({ key, answer }); return { ok: true, key }; },
      disposeAll: async () => {},
    },
  };
}

function 假Run仓库() {
  const runs = new Map();
  let 序号 = 0;
  const 记录 = { 事件: [], 取消: [] };
  return {
    记录,
    runs,
    runsApi: {
      beginRun: (payload) => {
        序号 += 1;
        const run = { id: `run-${序号}`, status: "running", before: [], events: [], ...payload };
        runs.set(run.id, run);
        return run;
      },
      recordRunEvent: (id, type, data) => { 记录.事件.push({ id, type, data }); },
      finishRun: (id, patch) => {
        const run = runs.get(id);
        if (!run) return null;
        Object.assign(run, patch);
        return run;
      },
      getRun: (id) => runs.get(id) || null,
      listRuns: () => [...runs.values()],
      listRunArtifacts: () => [],
      requestRunCancellation: (id, reason) => { 记录.取消.push({ id, reason }); return { ok: true }; },
      snapshotWorkspace: () => [],
    },
  };
}

function 建句柄(overrides = {}) {
  const 运行时 = 假运行时();
  const 仓库 = 假Run仓库();
  const 事件 = [];
  const 句柄 = 创建执行句柄({
    agentManager: 运行时.manager,
    runs: 仓库.runsApi,
    stageWrite: () => {},
    waitForFlush: async () => [],
    validateArtifacts: () => [],
    validateStagedArtifacts: () => [],
    timing: { markRunTiming: () => {}, attachRunTimingMeta: () => {}, attachRunTimingSpans: () => {} },
    emit: (entry, type, data) => { 事件.push({ type, data }); },
    recordDiagnostic: () => ({ message: "" }),
    ...overrides,
  });
  return { 句柄, 运行时, 仓库, 事件 };
}

const 假入口 = (overrides = {}) => ({
  busy: false,
  activeRunId: null,
  session: { sessionId: "session-1", model: { provider: "test", id: "test-model" } },
  channel: { seq: 0, history: [], emitter: { emit: () => {} } },
  ...overrides,
});

await test("七个契约方法齐备", async () => {
  const { 句柄 } = 建句柄();
  for (const 键 of ["执行", "中断", "响应交互", "释放", "订阅", "可用性", "能力"]) {
    assert.equal(typeof 句柄[键], "function", `缺少方法：${键}`);
  }
});

await test("可用性三态可达：ready / busy / disconnected", async () => {
  const { 句柄, 运行时 } = 建句柄();
  assert.equal(句柄.可用性(), "ready", "无会话时应为 ready");
  运行时.sessions.set("c1", { clientId: "c1", threadId: null, busy: true, queuedCount: 0 });
  assert.equal(句柄.可用性(), "busy", "有执行中的会话时应为 busy");
  运行时.sessions.set("c1", { clientId: "c1", threadId: null, busy: false, queuedCount: 0 });
  const 掉线运行时 = 假运行时({ health: "failed" });
  掉线运行时.sessions.set("c2", { clientId: "c2", threadId: null, busy: false, queuedCount: 0 });
  const 掉线 = 建句柄({ agentManager: 掉线运行时.manager });
  assert.equal(掉线.句柄.可用性(), "disconnected", "运行时失败时应为 disconnected");
});

await test("执行返回准入应答并派发到运行时", async () => {
  const { 句柄, 运行时 } = 建句柄();
  const 结果 = await 句柄.执行("帮我规划一下", {
    entry: 假入口(),
    key: "c1",
    client: "c1",
    thread: "t1",
    task: { mode: "work", goal: "规划" },
    resolved: [],
    workflowId: null,
    runWorkspace: "D:/tmp",
  });
  assert.equal(结果.ok, true);
  assert.equal(结果.accepted, true);
  assert.equal(结果.status, "accepted");
  assert.ok(String(结果.runId || "").startsWith("run-"), `runId 异常：${结果.runId}`);
  assert.equal(运行时.记录.派发.length, 1, "应派发一次运行时调用");
});

await test("中断之后仍可再次执行", async () => {
  const { 句柄, 运行时, 仓库 } = 建句柄();
  const 首次 = await 句柄.执行("第一轮", { entry: 假入口(), key: "c1", client: "c1", task: { mode: "work" } });
  const 中断结果 = await 句柄.中断(首次.runId, "用户请求中断", { client: "c1" });
  assert.equal(中断结果.ok, true);
  assert.equal(中断结果.runId, 首次.runId);
  assert.equal(仓库.记录.取消.length, 1, "中断应登记 Run 取消");
  const 再次 = await 句柄.执行("第二轮", { entry: 假入口(), key: "c1", client: "c1", task: { mode: "work" } });
  assert.equal(再次.ok, true, "中断后应能再次执行");
  assert.notEqual(再次.runId, 首次.runId, "再次执行应新建 Run");
});

await test("订阅可收到状态变化，退订后不再收到", async () => {
  const { 句柄 } = 建句柄();
  const 收到 = [];
  const 退订 = 句柄.订阅((event) => 收到.push(event));
  await 句柄.执行("订阅测试", { entry: 假入口(), key: "c1", client: "c1", task: { mode: "work" } });
  assert.ok(收到.length >= 1, "订阅者应收到状态变化");
  assert.equal(收到[0].type, "执行已接收");
  退订();
  const 数量 = 收到.length;
  await 句柄.执行("退订后", { entry: 假入口(), key: "c1", client: "c1", task: { mode: "work" } });
  assert.equal(收到.length, 数量, "退订后不应再收到事件");
});

await test("释放会摘掉会话占用", async () => {
  const { 句柄, 运行时 } = 建句柄();
  运行时.sessions.set("c1::t1", { clientId: "c1", threadId: "t1", runtimeId: "rt-1", session: { sessionId: "s1" } });
  运行时.manager.pendingAsks.set("c1::t1", () => {});
  const 结果 = await 句柄.释放("c1::t1");
  assert.equal(结果.ok, true);
  assert.equal(运行时.sessions.has("c1::t1"), false, "会话应从管理器摘除");
  assert.equal(运行时.manager.pendingAsks.has("c1::t1"), false, "待答交互应清理");
  const 再次 = await 句柄.释放("不存在的会话");
  assert.equal(再次.ok, false);
  assert.equal(再次.reason, "not_found");
});

await test("响应交互把答案交回运行时", async () => {
  const { 句柄, 运行时 } = 建句柄();
  const 结果 = 句柄.响应交互("c1", "选方案 A", { thread: "t1" });
  assert.equal(结果.ok, true);
  assert.equal(运行时.记录.提交.length, 1);
  assert.equal(运行时.记录.提交[0].key, "c1::t1");
});

await test("能力() 自述与实际动作一致", async () => {
  const { 句柄 } = 建句柄();
  const 能力 = 句柄.能力();
  assert.equal(能力.execute, true);
  assert.equal(能力.abort, true);
  assert.equal(能力.respond, true);
  assert.equal(能力.release, true);
  assert.equal(能力.subscribe, true);
  assert.equal(能力.availability, true);
  assert.equal(能力.actions.length, 7);
  assert.equal(能力.availabilityState, "ready");
});

console.log(failed ? "\n执行句柄契约测试：存在失败" : "\n执行句柄契约测试：全部通过");
process.exitCode = failed ? 1 : 0;
