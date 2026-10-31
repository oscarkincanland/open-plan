#!/usr/bin/env node
/**
 * 恢复隔离测试：验证"另一个实例不能把别人正在跑的活动 Run 标记成 recovering"。
 *
 * 背景：本机可以同时跑主服务（3002）与验证/测试实例（3199），它们共享同一个 .oaw/runs。
 * 修复前，第二个实例启动时的 recoverActiveRuns() 会把主服务正在执行的活动 Run
 * 标记为 recovering 并写入 run_recovered 事件（实测压力测试中 3 个全新 Run 都中招）。
 *
 * 存活判定（两重证据，缺一不可）：
 *   1. owner 实例的心跳文件存在且新鲜 —— 只有真正在提供服务的实例才写心跳；
 *   2. 心跳里的 PID 仍然存活 —— 排除崩溃后 PID 被系统复用的可能。
 * 因此一次性脚本/测试进程创建过的 Run 不会被误判为"仍在跑"，服务重启后仍能正常恢复。
 *
 * 覆盖：
 *   1. owner 是存活服务实例 → 不标记 recovering（跨实例隔离）
 *   2. owner 进程已退出/无心跳 → 仍按中断恢复（重启恢复能力不被破坏）
 *   3. 旧 Run（没有 owner 字段）→ 仍按中断恢复（向后兼容）
 *   4. OAW_DISABLE_RECOVERY=1 → 完全跳过恢复
 *
 * 用法：node scripts/恢复隔离测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

function makeRuntime(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oaw-recovery-${label}-`));
  const runsDir = path.join(dir, "runs");
  const instanceDir = path.join(dir, "instances");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(instanceDir, { recursive: true });
  return {
    dir,
    runsDir,
    instanceDir,
    env: {
      PORT: "0",
      OAW_RUNS_DIR: runsDir,
      OAW_WRITE_LOCK_DIR: path.join(dir, "locks"),
      OAW_EVENT_DIR: path.join(dir, "events"),
      OAW_INSTANCE_DIR: instanceDir,
      OAW_GOAL_DIR: path.join(dir, "goals"),
    },
  };
}

function writeRun(runsDir, run) {
  fs.writeFileSync(path.join(runsDir, `${run.id}.json`), JSON.stringify({
    version: 1,
    clientId: "client-recovery",
    threadId: "thread-recovery",
    sessionId: null,
    cwd: path.dirname(runsDir),
    task: { goal: "recovery probe", mode: "agent" },
    touchedPaths: [],
    events: [{ seq: 1, type: "run_started", data: {}, at: new Date().toISOString() }],
    artifacts: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    ...run,
  }), "utf8");
  return path.join(runsDir, `${run.id}.json`);
}

/** 模拟一个"正在提供服务"的实例：写心跳文件并用存活 PID。 */
function writeLiveInstanceHeartbeat(instanceDir, instanceId, pid) {
  fs.writeFileSync(path.join(instanceDir, `${instanceId}.json`), JSON.stringify({
    instanceId,
    pid,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  }), "utf8");
}

function readRun(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 启动一个 server 实例，等它 listen 完成。 */
async function startServer(runtime, extraEnv = {}) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: ROOT,
    env: { ...process.env, ...runtime.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  for (let i = 0; i < 120 && !out.includes("running at"); i += 1) await sleep(250);
  return { child, output: () => out };
}

await test("owner 是存活服务实例时，Run 不会被另一个实例标记成 recovering", async () => {
  const runtime = makeRuntime("alive");
  const instanceId = "instance-alive";
  // 心跳新鲜 + PID 存活（用当前测试进程代表那个服务实例）。
  writeLiveInstanceHeartbeat(runtime.instanceDir, instanceId, process.pid);
  const file = writeRun(runtime.runsDir, {
    id: "run_recovery_alive_owner",
    status: "running",
    owner: { pid: process.pid, instanceId, startedAt: new Date().toISOString() },
  });
  const server = await startServer(runtime);
  try {
    await sleep(800);
    const run = readRun(file);
    assert.equal(run.status, "running", `Run 状态不应被改写，实际 ${run.status}`);
    assert.equal(
      (run.events || []).some((e) => e.type === "run_recovered"),
      false,
      "不应写入 run_recovered 事件",
    );
  } finally {
    try { server.child.kill(); } catch {}
    await sleep(300);
    fs.rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("owner 进程已退出时仍按中断恢复（重启恢复能力不被破坏）", async () => {
  const runtime = makeRuntime("dead");
  const instanceId = "instance-dead";
  // 心跳存在但 PID 已不存在（模拟崩溃后 PID 回收）。
  writeLiveInstanceHeartbeat(runtime.instanceDir, instanceId, 999999);
  const file = writeRun(runtime.runsDir, {
    id: "run_recovery_dead_owner",
    status: "running",
    owner: { pid: 999999, instanceId, startedAt: new Date().toISOString() },
  });
  const server = await startServer(runtime);
  try {
    await sleep(800);
    const run = readRun(file);
    assert.equal(run.status, "recovering", `Run 应被标记为 recovering，实际 ${run.status}`);
    assert.equal(
      (run.events || []).some((e) => e.type === "run_recovered"),
      true,
      "应写入 run_recovered 事件",
    );
  } finally {
    try { server.child.kill(); } catch {}
    await sleep(300);
    fs.rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("没有心跳的 owner（一次性脚本创建）按中断恢复", async () => {
  const runtime = makeRuntime("noheartbeat");
  const file = writeRun(runtime.runsDir, {
    id: "run_recovery_no_heartbeat",
    status: "running",
    // PID 仍存活，但没有心跳文件：不是"在提供服务的实例"，不应阻止恢复。
    owner: { pid: process.pid, instanceId: "instance-script", startedAt: new Date().toISOString() },
  });
  const server = await startServer(runtime);
  try {
    await sleep(800);
    const run = readRun(file);
    assert.equal(run.status, "recovering", `Run 应被标记为 recovering，实际 ${run.status}`);
    assert.equal(
      (run.events || []).some((e) => e.type === "run_recovered"),
      true,
      "应写入 run_recovered 事件",
    );
  } finally {
    try { server.child.kill(); } catch {}
    await sleep(300);
    fs.rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("旧 Run（没有 owner 字段）仍按中断恢复（向后兼容）", async () => {
  const runtime = makeRuntime("legacy");
  const file = writeRun(runtime.runsDir, {
    id: "run_recovery_legacy_no_owner",
    status: "running",
  });
  const server = await startServer(runtime);
  try {
    await sleep(800);
    const run = readRun(file);
    assert.equal(run.status, "recovering", `Run 应被标记为 recovering，实际 ${run.status}`);
    assert.equal(
      (run.events || []).some((e) => e.type === "run_recovered"),
      true,
      "应写入 run_recovered 事件",
    );
  } finally {
    try { server.child.kill(); } catch {}
    await sleep(300);
    fs.rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("OAW_DISABLE_RECOVERY=1 的实例完全不恢复任何 Run", async () => {
  const runtime = makeRuntime("disabled");
  const file = writeRun(runtime.runsDir, {
    id: "run_recovery_disabled",
    status: "running",
  });
  const server = await startServer(runtime, { OAW_DISABLE_RECOVERY: "1" });
  try {
    await sleep(800);
    const run = readRun(file);
    assert.equal(run.status, "running", `Run 状态不应被改写，实际 ${run.status}`);
    assert.equal(
      (run.events || []).some((e) => e.type === "run_recovered"),
      false,
      "不应写入 run_recovered 事件",
    );
    assert.match(server.output(), /OAW_DISABLE_RECOVERY/, "应输出跳过恢复的日志");
  } finally {
    try { server.child.kill(); } catch {}
    await sleep(300);
    fs.rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("服务实例监听后才会写心跳（一次性进程不写心跳）", async () => {
  const runtime = makeRuntime("heartbeat");
  const server = await startServer(runtime);
  try {
    await sleep(800);
    const files = fs.readdirSync(runtime.instanceDir).filter((name) => name.endsWith(".json"));
    assert.ok(files.length >= 1, "服务实例应写心跳文件");
  } finally {
    try { server.child.kill(); } catch {}
    await sleep(300);
    fs.rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("验证脚本使用隔离的运行时目录，不读写生产 .oaw", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts", "验证脚本.mjs"), "utf8");
  assert.match(source, /OAW_RUNS_DIR/, "验证脚本应设置隔离的 OAW_RUNS_DIR");
  assert.match(source, /OAW_WRITE_LOCK_DIR/, "验证脚本应设置隔离的 OAW_WRITE_LOCK_DIR");
  assert.match(source, /OAW_EVENT_DIR/, "验证脚本应设置隔离的 OAW_EVENT_DIR");
  assert.match(source, /OAW_DISABLE_RECOVERY/, "验证脚本应关闭恢复");
  assert.match(source, /rmSync\(verifyRuntime/, "验证脚本应清理临时运行时目录");
});

console.log(failed ? "\n恢复隔离测试：存在失败" : "\n恢复隔离测试：全部通过");
process.exitCode = failed ? 1 : 0;
