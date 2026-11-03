#!/usr/bin/env node
/**
 * 中断链路回归测试（计划 2026-11-03-001 P0-4）：
 *
 * 背景：任务中心取消此前绕过 abort（只查 sessions.get(key)+busy），key 不匹配或
 * busy=false 时只 finishRun 而不真正中断 agent；officecli 是独立进程且工具回调
 * 丢弃 Pi 的 AbortSignal，长命令只能等自身超时。
 *
 * 覆盖：
 *   1. office.mjs：signal 已 aborted 时 runOfficecli 直接拒（OFFICECLI_ABORTED），不 spawn；
 *   2. office.mjs：运行中的子进程收到中止信号即 SIGTERM，工具调用快速返回；
 *   3. agent.mjs：resolveLiveEntry 在精确 key 缺失时按 runEntryKeys 反查 entry
 *      （busy / activeRunId / chainDepth 任一活体特征即返回）；
 *   4. agent.mjs：映射的 entry 已空闲时回退 activeRunId 线性扫描，不误中断空闲会话；
 *   5. 结构契约：runEntryKeys 在构造器初始化、_promptEntry 登记并在收尾删除；
 *   6. 结构契约：/api/runs/:id/cancel 统一走 执行句柄.中断。
 *
 * 用法: node scripts/中断链路回归测试.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runOfficecli } = await import(pathToFileURL(path.join(ROOT, "server/office.mjs")).href);
const { agentManager } = await import(pathToFileURL(path.join(ROOT, "server/agent.mjs")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn ? fn() : null; console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const 读取 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");
const OFFICE = 读取("server", "office.mjs");
const HANDLE = 读取("server", "执行句柄.mjs");
const INDEX = 读取("server", "index.mjs");

console.log("\n▶ office.mjs signal 中断");

await testAsync("signal 已 aborted：runOfficecli 立即拒绝且不 spawn 子进程", async () => {
  const controller = new AbortController();
  controller.abort();
  const t0 = Date.now();
  await assert.rejects(
    runOfficecli(["--version"], { signal: controller.signal, timeoutMs: 5000 }),
    (error) => error?.code === "OFFICECLI_ABORTED",
    "应拒绝并返回 OFFICECLI_ABORTED",
  );
  assert.ok(Date.now() - t0 < 1000, "预中止必须立即失败");
});

await testAsync("运行中子进程收到中止信号即 SIGTERM（<3s 返回）", async () => {
  const controller = new AbortController();
  // 用 node 自身作为假 officecli：睡 5 秒，验证中止能提前杀掉。
  const startedAt = Date.now();
  const pending = runOfficecli(["-e", "setTimeout(()=>{},5000)"], {
    executable: process.execPath,
    signal: controller.signal,
    timeoutMs: 30000,
  });
  await sleep(400);
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error?.code === "OFFICECLI_ABORTED",
    "中止后必须返回 OFFICECLI_ABORTED 而不是等子进程完成",
  );
  assert.ok(Date.now() - startedAt < 3000, "中止必须提前于命令自然完成（5s）");
});

console.log("\n▶ resolveLiveEntry runId→entry 反查");

test("runEntryKeys 命中：映射 entry 同样具备派生特征（chainDepth）即返回", () => {
  const runId = "run_mapped_live";
  const entry = { busy: false, activeRunId: null, chainDepth: 1 };
  agentManager.sessions.set("entry-chain-key", entry);
  agentManager.runEntryKeys.set(runId, "entry-chain-key");
  const found = agentManager.resolveLiveEntry("stale-key", { runId });
  assert.equal(found, entry, "精确 key 缺失时应按 runEntryKeys 反查到在跑 entry");
  agentManager.sessions.delete("entry-chain-key");
  agentManager.runEntryKeys.delete(runId);
});

test("映射 entry 空闲时回退 activeRunId 线性扫描，不误中断空闲会话", () => {
  const runId = "run_mapped_stale";
  const idleEntry = { busy: false, activeRunId: null, chainDepth: 0 };
  const liveEntry = { busy: true, activeRunId: runId, chainDepth: 0 };
  agentManager.sessions.set("entry-idle-key", idleEntry);
  agentManager.sessions.set("entry-live-key", liveEntry);
  agentManager.runEntryKeys.set(runId, "entry-idle-key");
  const found = agentManager.resolveLiveEntry("stale-key", { runId });
  assert.equal(found, liveEntry, "旧映射失效时应继续按 activeRunId 找到真正在跑的 entry");
  agentManager.sessions.delete("entry-idle-key");
  agentManager.sessions.delete("entry-live-key");
  agentManager.runEntryKeys.delete(runId);
});

console.log("\n▶ runEntryKeys 生命周期结构契约");

test("agent.mjs：构造器初始化 runEntryKeys，_promptEntry 登记并在收尾删除", () => {
  const agent = 读取("server", "agent.mjs");
  assert.ok(/this\.runEntryKeys = new Map\(\);/.test(agent), "缺少构造器初始化");
  // 登记：在 activeRunId 赋值之后立即登记
  const assignAt = agent.indexOf("entry.activeRunId = runContext?.runId || null;");
  const registerAt = agent.indexOf("this.runEntryKeys.set(runContext.runId, entry.clientId);");
  assert.ok(assignAt > 0 && registerAt > assignAt, "登记必须紧随 activeRunId 赋值");
  // 收尾：删除必须发生 activeRunId 置空之前（保留读取），且收尾段包含 busy=false
  const finishAt = agent.indexOf("if (entry.activeRunId) this.runEntryKeys.delete(entry.activeRunId);");
  const nullAt = agent.indexOf("entry.activeRunId = null;", finishAt > 0 ? finishAt : 0);
  assert.ok(finishAt > 0 && nullAt > finishAt, "收尾必须先撤销 runEntryKeys 映射再置空 activeRunId");
  assert.ok(/entry\.busy = false;\s*\n\s*\/\/ Run 收尾/.test(agent), "删除点必须挂在 Run 收尾路径");
});

test("执行句柄.中断回执 stillRunning/chainDepth（任务中心「收尾中」依据）", () => {
  const 中断起点 = HANDLE.indexOf("async function 中断(");
  const 函数体 = HANDLE.slice(中断起点, HANDLE.indexOf("/**", 中断起点 + 10) > 0 ? HANDLE.indexOf("/**", 中断起点 + 10) : undefined);
  assert.ok(函数体.includes("stillRunning"), "中断回执缺少 stillRunning");
  assert.ok(函数体.includes("chainDepth"), "中断回执缺少 chainDepth");
  assert.ok(函数体.includes("runtimeAborted"), "stillRunning 语义必须覆盖 runtime 中断未显式确认的路径");
});

test("/api/runs/:id/cancel 统一走执行句柄中断", () => {
  const 路由起点 = INDEX.indexOf('app.post("/api/runs/:id/cancel"');
  assert.ok(路由起点 > 0, "缺少 cancel 路由");
  const 片段 = INDEX.slice(路由起点, INDEX.indexOf("app.post", 路由起点 + 10));
  assert.ok(片段.includes("执行句柄.中断"), "cancel 路由必须走执行句柄.中断而不是手动 finishRun");
  assert.ok(片段.includes("finishRun"), "找不到活跃 entry 时仍需按取消收尾兜底");
});

console.log(failed ? "\n中断链路回归测试：存在失败" : "\n中断链路回归测试：全部通过");
process.exit(failed ? 1 : 0);
