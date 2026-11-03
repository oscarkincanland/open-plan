#!/usr/bin/env node
/**
 * 多任务并发回归测试：验证同一工作区并发执行多个任务时的关键不变量。
 *
 * 覆盖（2026-10-31 压力测试发现的问题）：
 *   1. 多个任务并发执行 → 全部 Run 有终态，不出现"运行中永久悬挂"
 *   2. 全新 Run 不带 run_recovered（跨实例恢复污染已修复）
 *   3. 写入遇到工作区级锁冲突时走退避等待，而不是立即失败
 *   4. 只读 bash 命令不占用工作区写锁（不与并发写入互相挡）
 *
 * 模式：
 *   - 默认（无模型）：用注入的假 Run 记录模拟并发场景，只验证锁与恢复不变量；
 *   - --live：真的调用 /api/agent/prompt 跑 3 个 Agent 任务（需要模型与运行中的服务）。
 *
 * 用法：
 *   node scripts/多任务并发回归测试.mjs            # 离线锁/恢复不变量
 *   node scripts/多任务并发回归测试.mjs --live     # 真实并发任务（需要服务在 3002）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 用 fileURLToPath 解码：仓库路径含空格/中文时 URL.pathname 仍是 %20 编码，动态 import 会找不到模块。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--live");
const BASE = process.env.OAW_BASE_URL || "http://127.0.0.1:3002";

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await test("并发写入：3 个任务写不同子目录，全部成功且互不阻塞", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-multi-"));
  process.env.OAW_WRITE_LOCK_DIR = path.join(workspace, ".locks");
  process.env.OAW_RUNS_DIR = path.join(workspace, "runs");
  const { stageWriteWithRetry, releaseRunLocks } = await import(pathToFileURL(path.join(ROOT, "server", "写入协调.mjs")).href);
  try {
    const results = await Promise.all(["A", "B", "C"].map((id) => stageWriteWithRetry(
      { runId: `run_multi_${id}`, workspace, targetPath: path.join(workspace, id, "data.csv"), content: id, kind: "write" },
      { timeoutMs: 5000, intervalMs: 60 },
    )));
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.equal(result?.ok, true, `写入应成功：${result?.path}`);
    }
    assert.deepEqual(results.map((r) => r.path).sort(), ["A/data.csv", "B/data.csv", "C/data.csv"]);
    for (const id of ["A", "B", "C"]) releaseRunLocks(`run_multi_${id}`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("并发写入：一个任务持有工作区级锁时，其他任务等待后成功", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-multi-lock-"));
  process.env.OAW_WRITE_LOCK_DIR = path.join(workspace, ".locks");
  process.env.OAW_RUNS_DIR = path.join(workspace, "runs");
  const { acquireWriteLock, releaseWriteLock, stageWriteWithRetry, releaseRunLocks } = await import(pathToFileURL(path.join(ROOT, "server", "写入协调.mjs")).href);
  try {
    const holder = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_multi_holder", kind: "bash" });
    const startedAt = Date.now();
    const pending = stageWriteWithRetry(
      { runId: "run_multi_waiter", workspace, targetPath: path.join(workspace, "waited.md"), content: "ok", kind: "write" },
      { timeoutMs: 5000, intervalMs: 60 },
    );
    setTimeout(() => releaseWriteLock(holder), 500);
    const result = await pending;
    const waited = Date.now() - startedAt;
    assert.equal(result?.ok, true, "等待后应写入成功");
    assert.ok(waited >= 400, `应等待过（实测 ${waited}ms）`);
    releaseRunLocks("run_multi_waiter");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

await test("只读 bash 命令不占用工作区写锁", async () => {
  const { isReadonlyBash } = await import(pathToFileURL(path.join(ROOT, "server", "office规范", "执行闸门.mjs")).href);
  const readonly = [
    "ls -la",
    "diff data.csv other.csv",
    "wc -l data.csv",
    "cmp a.txt b.txt",
    "sha256sum data.csv",
    "jq '.rows | length' metrics.json",
    "cat data.csv | grep R01",
  ];
  for (const command of readonly) {
    assert.equal(isReadonlyBash(command), true, `应判为只读：${command}`);
  }
  const mutating = [
    "node script.mjs",
    "mkdir out",
    "rm -rf tmp",
    "node -e \"require('fs').writeFileSync('a.txt','x')\"",
    "diff a.txt b.txt > out.txt",
    "ls; rm -rf important",
    "cat a.txt | tee b.txt",
    "find . -delete",
    "sed -i 's/a/b/' file.txt",
  ];
  for (const command of mutating) {
    assert.equal(isReadonlyBash(command), false, `应判为写操作：${command}`);
  }
});

await test("全新 Run 不带 run_recovered 事件", async () => {
  const { beginRun, finishRun, getRun } = await import(pathToFileURL(path.join(ROOT, "server", "runs.mjs")).href);
  const run = beginRun({
    clientId: "client_multi_probe",
    threadId: "thread_multi_probe",
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "oaw-multi-run-")),
    task: { goal: "probe", mode: "agent" },
    snapshotMode: "none",
  });
  try {
    const view = getRun(run.id);
    const types = (view?.events || []).map((e) => e.type);
    assert.equal(types.includes("run_recovered"), false, `全新 Run 不应带 run_recovered：${types.join(",")}`);
    assert.ok(view?.owner?.pid, "Run 应记录 owner.pid");
    assert.ok(view?.owner?.instanceId, "Run 应记录 owner.instanceId");
  } finally {
    finishRun(run.id, { status: "completed", summary: "probe" });
  }
});

if (LIVE) {
  await test("--live：3 个并发 Agent 任务全部完成，且无 run_recovered / 未处理写冲突", async () => {
    const workspace = path.join(ROOT, "office-workspace");
    const stamp = Date.now();
    const root = `oaw-multi-live-${stamp}`;
    const post = async (p, body) => {
      const res = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const cases = ["A", "B", "C"].map((id) => ({
      id,
      client: `client-multi-${id}-${stamp}`,
      thread: `thread-multi-${id}-${stamp}`,
      prompt: `请完成一个多文件任务：在工作区根目录创建目录 ${root}/${id}/，生成 data.csv（表头 + 3 条数据行）与 summary.md（说明）。完成后用 read 回读并在最终答复里说明结果。不要只说明步骤。`,
    }));
    for (const c of cases) {
      await post("/api/agent/new", { client: c.client, thread: c.thread, cwd: workspace, label: `MULTI-${c.id} ${stamp}` });
    }
    const prompted = await Promise.all(cases.map((c) => post("/api/agent/prompt", {
      client: c.client, thread: c.thread, text: c.prompt, model: "opencode-go/deepseek-v4.1-flash", effort: "low",
      task: { goal: c.prompt, mode: "agent", workspace, projectId: null, currentFile: null, references: [] },
    })));
    const runs = prompted.map((p, i) => ({ id: cases[i].id, runId: p.data?.runId }));
    const deadline = Date.now() + 240000;
    const finals = new Map();
    while (Date.now() < deadline) {
      let pending = 0;
      for (const r of runs) {
        if (!r.runId) { pending += 1; continue; }
        const body = await (await fetch(`${BASE}/api/runs/${encodeURIComponent(r.runId)}`)).json();
        const run = body.run || body;
        if (run && ["completed", "failed", "cancelled", "aborted"].includes(run.status)) finals.set(r.id, run);
        else pending += 1;
      }
      if (!pending) break;
      await sleep(1000);
    }
    const summary = runs.map((r) => {
      const run = finals.get(r.id);
      const events = run?.events || [];
      return {
        id: r.id,
        status: run?.status || "timeout",
        completion: run?.completion?.status || null,
        recovered: events.some((e) => e.type === "run_recovered"),
        writeRejected: events.filter((e) => e.type === "write_rejected").length,
      };
    });
    console.log("    明细:", JSON.stringify(summary));
    for (const item of summary) {
      assert.equal(item.status, "completed", `${item.id} 应完成，实际 ${item.status}`);
      assert.equal(item.recovered, false, `${item.id} 不应出现 run_recovered`);
    }
    for (const c of cases) {
      try { fs.rmSync(path.join(workspace, root, c.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
    }
    try { fs.rmSync(path.join(workspace, root), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  });
} else {
  console.log("  - 跳过 --live 真实并发任务用例（加 --live 启用）");
}

console.log(failed ? "\n多任务并发回归测试：存在失败" : "\n多任务并发回归测试：全部通过");
process.exitCode = failed ? 1 : 0;
