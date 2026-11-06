#!/usr/bin/env node
/**
 * 写锁并发测试：验证 P1 修复——工作区级锁"用完即放" + 冲突时短退避等待。
 *
 * 场景：Run A 持有工作区锁时，Run B 的写入不再立刻失败，而是等到 A 释放后继续；
 *      超过等待窗口才按 WRITE_CONFLICT 报错。
 *
 * 另覆盖 2026-10-31 压力测试发现的问题：write/edit 走 stageWrite（立即取锁），
 * 撞上另一个任务的工作区锁会在 2ms 内直接失败。现在写入走 stageWriteWithRetry。
 *
 * 用法：node scripts/写入锁并发测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-lock-test-"));
process.env.OAW_WRITE_LOCK_DIR = path.join(workspace, ".locks");
process.env.OAW_RUNS_DIR = path.join(workspace, "runs");
const { acquireWriteLock, acquireWriteLockWithRetry, releaseWriteLock, releaseRunLocks, stageWrite, stageWriteWithRetry } = await import("../server/写入协调.mjs");

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

await test("A 持锁时 B 等待，A 释放后 B 立即拿到锁", async () => {
  const tokenA = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_A", kind: "bash" });
  const startedAt = Date.now();
  const waiting = acquireWriteLockWithRetry({ workspace, targetPath: workspace, runId: "run_B", kind: "bash" }, { timeoutMs: 5000, intervalMs: 100 });
  setTimeout(() => releaseWriteLock(tokenA), 600);
  const tokenB = await waiting;
  const waited = Date.now() - startedAt;
  assert.ok(tokenB?.key, "B 应该拿到锁");
  assert.ok(waited >= 500, `B 应该等待过（实测 ${waited}ms）`);
  releaseWriteLock(tokenB);
});

await test("等待窗口内无人释放时按 WRITE_CONFLICT 报错", async () => {
  const tokenA = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_C", kind: "officecli" });
  const startedAt = Date.now();
  let message = "";
  try {
    await acquireWriteLockWithRetry({ workspace, targetPath: workspace, runId: "run_D", kind: "officecli" }, { timeoutMs: 800, intervalMs: 100 });
  } catch (error) {
    message = `${error.code}: ${error.message}`;
  }
  const waited = Date.now() - startedAt;
  releaseWriteLock(tokenA);
  assert.match(message, /WRITE_CONFLICT/, `应报 WRITE_CONFLICT，实际 ${message || "无错误"}`);
  assert.ok(waited >= 700, `应在窗口后才失败（实测 ${waited}ms）`);
});

await test("同 Run 重入仍然计数正确", async () => {
  const first = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_E", kind: "bash" });
  const second = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_E", kind: "bash" });
  assert.equal(second.reentrant, true);
  releaseWriteLock(second);
  releaseWriteLock(first);
  const after = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_F", kind: "bash" });
  releaseWriteLock(after);
});

await test("同工作区不同文件可同时持锁（Word/PPT 并行）", () => {
  const a = acquireWriteLock({ workspace, targetPath: path.join(workspace, "a.docx"), runId: "run_G", kind: "officecli" });
  const b = acquireWriteLock({ workspace, targetPath: path.join(workspace, "b.pptx"), runId: "run_H", kind: "editorial_pipeline" });
  assert.ok(a?.key && b?.key, "不同文件应能同时拿到锁");
  releaseWriteLock(a);
  releaseWriteLock(b);
});

await test("工作区级锁仍会挡住文件锁（bash 兜底语义不变）", async () => {
  const root = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_I", kind: "bash" });
  let message = "";
  try {
    await acquireWriteLockWithRetry({ workspace, targetPath: path.join(workspace, "c.docx"), runId: "run_J", kind: "officecli" }, { timeoutMs: 400, intervalMs: 50 });
  } catch (error) {
    message = `${error.code}: ${error.message}`;
  }
  releaseWriteLock(root);
  assert.match(message, /WRITE_CONFLICT/, `应报 WRITE_CONFLICT，实际 ${message || "无错误"}`);
});

await test("stageWrite 撞上工作区锁会立即失败（旧行为，写入路径不应再用它）", async () => {
  const root = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_K", kind: "bash" });
  const startedAt = Date.now();
  let code = "";
  try {
    stageWrite({ runId: "run_L", workspace, targetPath: path.join(workspace, "old.md"), content: "x", kind: "agent" });
  } catch (error) {
    code = error.code || error.name;
  }
  const waited = Date.now() - startedAt;
  releaseWriteLock(root);
  assert.equal(code, "WRITE_CONFLICT", `应报 WRITE_CONFLICT，实际 ${code || "无错误"}`);
  assert.ok(waited < 500, `旧路径应立即失败（实测 ${waited}ms）`);
});

await test("stageWriteWithRetry 撞上工作区锁会等待，释放后写入成功", async () => {
  const root = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_M", kind: "bash" });
  const startedAt = Date.now();
  const waiting = stageWriteWithRetry(
    { runId: "run_N", workspace, targetPath: path.join(workspace, "retry.md"), content: "hello", kind: "agent" },
    { timeoutMs: 5000, intervalMs: 100 },
  );
  setTimeout(() => releaseWriteLock(root), 600);
  const result = await waiting;
  const waited = Date.now() - startedAt;
  assert.equal(result?.ok, true, "写入应成功");
  assert.equal(result?.path, "retry.md");
  assert.ok(waited >= 500, `应等待过（实测 ${waited}ms）`);
  // 暂存锁按既有语义持有到 Run 结束，这里显式释放，避免影响后续用例。
  releaseRunLocks("run_N");
});

await test("stageWriteWithRetry 超时后返回结构化可重试错误", async () => {
  const root = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_O", kind: "bash" });
  let error = null;
  const startedAt = Date.now();
  try {
    await stageWriteWithRetry(
      { runId: "run_P", workspace, targetPath: path.join(workspace, "timeout.md"), content: "hello", kind: "agent" },
      { timeoutMs: 700, intervalMs: 80 },
    );
  } catch (caught) {
    error = caught;
  }
  const waited = Date.now() - startedAt;
  releaseWriteLock(root);
  assert.ok(error, "应抛出错误");
  assert.equal(error.code, "WRITE_CONFLICT");
  assert.equal(error.details?.retryable, true, "错误应标记为可重试");
  assert.ok(Number(error.details?.attempts) > 1, `应记录尝试次数，实际 ${error.details?.attempts}`);
  assert.ok(Number(error.details?.waitedMs) >= 600, `应记录等待时长，实际 ${error.details?.waitedMs}`);
  assert.ok(waited >= 600, `应在窗口后才失败（实测 ${waited}ms）`);
});

await test("stageWriteWithRetry 不冲突时立即写入", async () => {
  const result = await stageWriteWithRetry(
    { runId: "run_Q", workspace, targetPath: path.join(workspace, "free.md"), content: "ok", kind: "agent" },
    { timeoutMs: 1000, intervalMs: 50 },
  );
  assert.equal(result?.ok, true);
  assert.equal(result?.path, "free.md");
  releaseRunLocks("run_Q");
});

await test("2026-11-04：暂存写只持有瞬间锁，不再挡住其他 Run", async () => {
  // 新语义：stageWrite 写完 staging 立即释放；其他 Run 可以立刻取同一文件/工作区根锁。
  // 发布阶段的冲突由 baseRevision + 冲突副本处理（见并发写入与版本冲突测试）。
  const scoped = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-lock-scope-"));
  try {
    const first = stageWrite({ runId: "run_scope_owner", workspace: scoped, targetPath: path.join(scoped, "a.md"), content: "x", kind: "write" });
    assert.equal(first?.ok, true);
    const rootLock = acquireWriteLock({ workspace: scoped, targetPath: scoped, runId: "run_scope_other", kind: "bash" });
    releaseWriteLock(rootLock);
    const second = stageWrite({ runId: "run_scope_other", workspace: scoped, targetPath: path.join(scoped, "a.md"), content: "y", kind: "write" });
    assert.equal(second?.ok, true, "另一个 Run 应能立即暂存同一文件");
  } finally {
    releaseRunLocks("run_scope_owner");
    releaseRunLocks("run_scope_other");
    fs.rmSync(scoped, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});

fs.rmSync(workspace, { recursive: true, force: true });
console.log(failed ? "\n写锁并发测试：存在失败" : "\n写锁并发测试：全部通过");
process.exitCode = failed ? 1 : 0;
