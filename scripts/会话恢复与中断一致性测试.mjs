#!/usr/bin/env node
/**
 * 会话恢复与中断一致性测试（P0 回归）。
 *
 * 直接驱动 AgentManager 状态机，不依赖真实模型/Runtime：
 *   1. 同 client::thread 且同 sessionId 的 resume 必须幂等复用（忙/闲都不重建）；
 *   2. 不同 sessionId 且旧运行时忙时才允许 SESSION_BUSY；
 *   3. abort 必须结算 ask_user，否则阻塞 Promise 会把 promptChain 堵到 5 分钟超时；
 *   4. 新指令到达时同样结算旧提问；
 *   5. promptChain 仍有活但 busy 已被看门狗清零时，第二次入队必须发 agent_queued；
 *   6. 多会话下前缀兜底不得猜测，已知 runId 时按 activeRunId 精确命中。
 *
 * 用法: node scripts/会话恢复与中断一致性测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importServer = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { agentManager } = await importServer("server/agent.mjs");
const { piRuntimeManager } = await importServer("server/Pi运行时管理.mjs");

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error?.stack || error?.message || error}`);
  }
};

const uniqueKey = (label) => `test-client-${process.pid}::${label}-${Date.now()}`;

function fakeEntry({ key, sessionId = "session-a", busy = false, activeRunId = null, workspace = ROOT } = {}) {
  return {
    key,
    clientId: key,
    threadId: key.split("::").pop(),
    workspace,
    runtimeId: `runtime-test-${Math.random().toString(36).slice(2)}`,
    session: { sessionId, abort: async () => {} },
    busy,
    compacting: false,
    queuedCount: 0,
    chainDepth: 0,
    busyStartedAt: busy ? Date.now() : 0,
    activeRunId,
    cancelRequested: false,
    abortRequestedAt: 0,
    runStopCache: false,
    runStopCheckedAt: 0,
    abortedEmittedRunId: null,
    channel: {
      seq: 0,
      history: [],
      historyLimit: 200,
      streamId: "test-stream",
      emitter: new EventEmitter(),
    },
    promptChain: Promise.resolve(),
  };
}

function collectChannelEvents(entry) {
  const events = [];
  entry.channel.emitter.on("event", (event) => events.push(event));
  return events;
}

async function withStubs(stubs, fn) {
  const restores = [];
  for (const [target, key, value] of stubs) {
    restores.push([target, key, target[key]]);
    target[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [target, key, value] of restores.reverse()) target[key] = value;
  }
}

console.log("\n▶ 会话恢复幂等（resume）");

await test("同一 sessionId + busy：直接复用，不 dispose、不重建", async () => {
  const key = uniqueKey("resume-busy");
  const entry = fakeEntry({ key, sessionId: "sess-same", busy: true, activeRunId: "run_same" });
  agentManager.sessions.set(key, entry);
  let disposed = 0;
  let created = 0;
  try {
    await withStubs([
      [piRuntimeManager, "dispose", () => { disposed += 1; }],
      [agentManager, "_create", async () => { created += 1; return fakeEntry({ key }); }],
    ], async () => {
      const result = await agentManager.resumeThread(key, entry.threadId, `/tmp/sess-same.jsonl`, ROOT, "sess-same");
      assert.equal(result.ok, true);
      assert.equal(result.reused, true);
      assert.equal(result.sessionId, "sess-same");
    });
    assert.equal(disposed, 0, "复用不得 dispose 活运行时");
    assert.equal(created, 0, "复用不得重建运行时");
  } finally {
    agentManager.sessions.delete(key);
  }
});

await test("同一 sessionId + 空闲：同样复用，不冷启动", async () => {
  const key = uniqueKey("resume-idle");
  const entry = fakeEntry({ key, sessionId: "sess-idle" });
  agentManager.sessions.set(key, entry);
  let disposed = 0;
  let created = 0;
  try {
    await withStubs([
      [piRuntimeManager, "dispose", () => { disposed += 1; }],
      [agentManager, "_create", async () => { created += 1; return fakeEntry({ key }); }],
    ], async () => {
      const result = await agentManager.resumeThread(key, entry.threadId, `/tmp/sess-idle.jsonl`, ROOT, "sess-idle");
      assert.equal(result.reused, true);
    });
    assert.equal(disposed, 0);
    assert.equal(created, 0);
  } finally {
    agentManager.sessions.delete(key);
  }
});

await test("不同 sessionId + busy：保留 SESSION_BUSY（真正的冲突）", async () => {
  const key = uniqueKey("resume-conflict");
  const entry = fakeEntry({ key, sessionId: "sess-old", busy: true, activeRunId: "run_old" });
  agentManager.sessions.set(key, entry);
  try {
    await assert.rejects(
      () => agentManager.resumeThread(key, entry.threadId, "/tmp/sess-new.jsonl", ROOT, "sess-new"),
      (error) => error?.code === "SESSION_BUSY" && error.detail?.activeRunId === "run_old",
    );
  } finally {
    agentManager.sessions.delete(key);
  }
});

console.log("\n▶ 中断与待答问题结算");

await test("abort 结算 pending ask：resolver 被调用且从内存移除", async () => {
  const key = uniqueKey("abort-ask");
  const entry = fakeEntry({ key, busy: true, activeRunId: "run_abort" });
  agentManager.sessions.set(key, entry);
  const answers = [];
  const resolver = (answer) => answers.push(answer);
  resolver.payload = {
    askId: "ask_test",
    question: "继续吗？",
    options: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  agentManager.pendingAsks.set(key, resolver);
  try {
    const result = await agentManager.abort(key);
    assert.equal(result.cancelled, true);
    assert.equal(agentManager.pendingAsks.has(key), false, "abort 后 pending ask 必须移除");
    assert.equal(answers.length, 1, "ask 的 resolver 必须被调用一次");
    assert.match(answers[0], /取消|停止/, "回填内容应让模型收尾");
  } finally {
    agentManager.sessions.delete(key);
    agentManager.pendingAsks.delete(key);
  }
});

await test("新指令入队时结算旧提问", async () => {
  const key = uniqueKey("prompt-ask");
  const entry = fakeEntry({ key });
  const answers = [];
  const resolver = (answer) => answers.push(answer);
  resolver.payload = { askId: "ask_old", question: "旧提问", expiresAt: new Date(Date.now() + 60000).toISOString() };
  agentManager.pendingAsks.set(key, resolver);
  let prompted = 0;
  try {
    await withStubs([
      [agentManager, "_promptEntry", async () => { prompted += 1; return "ok"; }],
    ], async () => {
      await agentManager._enqueuePrompt(entry, { text: "新指令", images: [], references: [], runContext: null });
    });
    assert.equal(agentManager.pendingAsks.has(key), false);
    assert.equal(answers.length, 1);
    assert.match(answers[0], /新指令|作废/);
    assert.equal(prompted, 1);
  } finally {
    agentManager.pendingAsks.delete(key);
  }
});

console.log("\n▶ 排队可见性（chainDepth）");

await test("链上仍有活时第二次入队必须发 agent_queued", async () => {
  const key = uniqueKey("chain");
  const entry = fakeEntry({ key });
  // 模拟“Run 已被看门狗收尾、busy=false，但 promptChain 还挂着”的幽灵回合：
  // 链上已有一条在跑（chainDepth=1，queuedCount=0），此时新指令必须显示排队第 1 项。
  entry.promptChain = new Promise(() => {});
  entry.busy = false;
  entry.chainDepth = 1;
  entry.queuedCount = 0;
  const events = collectChannelEvents(entry);
  const originalPromptEntry = agentManager._promptEntry;
  agentManager._promptEntry = async () => "ok";
  try {
    const first = agentManager._enqueuePrompt(entry, { text: "新指令", images: [], references: [], runContext: null });
    assert.equal(entry.chainDepth, 2, "入队后 chainDepth 应叠加");
    const queued = events.filter((event) => event.type === "agent_queued");
    assert.equal(queued.length, 1, "幽灵回合下入队必须发 agent_queued");
    assert.equal(queued[0].data.position, 1);
    // 释放链条，让 operation 正常结束，避免留下永远 pending 的 Promise。
    assert.ok(first);
    entry.promptChain = Promise.resolve();
  } finally {
    agentManager._promptEntry = originalPromptEntry;
  }
});

console.log("\n▶ 多会话精确匹配（resolveLiveEntry）");

await test("多候选时拒绝前缀猜测；已知 runId 时精确命中", async () => {
  const client = `test-client-${process.pid}-multi`;
  const key1 = `${client}::t1`;
  const key2 = `${client}::t2`;
  const entry1 = fakeEntry({ key: key1, sessionId: "s1", busy: true, activeRunId: "run_1" });
  const entry2 = fakeEntry({ key: key2, sessionId: "s2", busy: true, activeRunId: "run_2" });
  agentManager.sessions.set(key1, entry1);
  agentManager.sessions.set(key2, entry2);
  try {
    assert.equal(agentManager.resolveLiveEntry(`${client}::missing`), null, "多候选时必须拒绝猜测");
    assert.equal(agentManager.resolveLiveEntry(`${client}::missing`, { runId: "run_2" }), entry2);
    assert.equal(agentManager.resolveLiveEntry(key1), entry1, "精确 key 仍然优先");
  } finally {
    agentManager.sessions.delete(key1);
    agentManager.sessions.delete(key2);
  }
});

console.log("\n▶ 接线（静态契约）");

await test("SSE 握手补发待答问题", () => {
  const source = fs.readFileSync(path.join(ROOT, "server/index.mjs"), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /agentManager\.pendingAsk\?\.\(agentKey\(client, thread\)\)/);
  assert.match(source, /type: "ask_user"/);
  assert.match(source, /recovered: true/);
});

await test("客户端按服务端期限确认中断，并在水合后恢复提问卡", () => {
  const source = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /settleDeadlineMs/);
  assert.match(source, /armStopConfirm/);
  assert.match(source, /listPendingQuestions\(clientId, threadId\)/);
  assert.match(source, /liveAskIdsRef/);
});

await test("待答时的新指令绕过本地队列并作废旧提问", () => {
  const source = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");
  // /api/agent/pending 返回活提问载荷，字段是 askId（持久化记录才是 id）。
  assert.match(source, /askId: String\(question\?\.askId \|\| question\?\.id \|\| ""\)/);
  assert.match(source, /const pendingAskOpen = messages\.some/);
  assert.match(source, /busyInputMode === "queue" && !pendingAskOpen/);
  assert.match(source, /已作废旧提问，新指令将排队执行/);
});

console.log(failed ? "\n✗ 会话恢复与中断一致性测试存在失败" : "\n✓ 会话恢复与中断一致性测试全部通过");
process.exit(failed ? 1 : 0);
