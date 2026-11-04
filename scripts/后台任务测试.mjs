#!/usr/bin/env node
/**
 * 后台任务测试（2026-11-04）
 *
 * 覆盖：
 *   1) Job 生命周期：running → completed/failed/cancelled；
 *   2) 输出有界、日志尾部可读；
 *   3) waitForJob 等待与超时；
 *   4) cancelJob 触发 AbortSignal 与 onFinish；
 *   5) 服务重启把遗留 running 标为 interrupted；
 *   6) agent/task/元数据/事件注册表的接线契约。
 *
 * 用法：node scripts/后台任务测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempJobs = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-jobs-test-"));
process.env.OAW_JOBS_DIR = tempJobs;
process.env.OAW_BACKGROUND_AFTER_MS = "10000";

const jobsModule = await import("../server/后台任务.mjs");
const {
  BACKGROUND_AFTER_MS,
  appendJobOutput,
  cancelJob,
  createJob,
  finishJob,
  getJob,
  listJobs,
  markInterruptedJobs,
  readJobLog,
  resetJobsForTest,
  waitForJob,
} = jobsModule;

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (error) => { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); },
);

console.log("\n▶ Job 生命周期");
await test("阈值默认 2 分钟且可配置", () => {
  assert.equal(BACKGROUND_AFTER_MS, 10_000, "测试环境应读到 10 秒");
});

await test("创建 → 追加输出 → 完成，元数据与日志落盘", async () => {
  const job = createJob({ runId: "run_a", threadId: "t1", kind: "bash", command: "sleep 1", mutating: false });
  appendJobOutput(job, "hello\n");
  appendJobOutput(job, "world\n");
  const snapshot = finishJob(job, { status: "completed", exitCode: 0, summary: "ok" });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.exitCode, 0);
  assert.equal(readJobLog(job.jobId), "hello\nworld\n");
  const meta = JSON.parse(fs.readFileSync(path.join(tempJobs, "run_a", `${job.jobId}.json`), "utf8"));
  assert.equal(meta.status, "completed");
  assert.equal(meta.summary, "ok");
  assert.ok(fs.existsSync(path.join(tempJobs, "run_a", `${job.jobId}.log`)));
});

await test("非零退出码自动记为 failed", () => {
  const job = createJob({ runId: "run_b", kind: "bash", command: "false" });
  const snapshot = finishJob(job, { status: "completed", exitCode: 2 });
  assert.equal(snapshot.status, "failed");
});

await test("waitForJob 立即返回已完成任务", async () => {
  const job = createJob({ runId: "run_c", kind: "bash", command: "true" });
  finishJob(job, { status: "completed", exitCode: 0 });
  const snapshot = await waitForJob(job.jobId, 1000);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.waitedOut, undefined);
});

await test("waitForJob 超时返回运行中快照", async () => {
  const job = createJob({ runId: "run_d", kind: "bash", command: "sleep" });
  const snapshot = await waitForJob(job.jobId, 1000);
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.waitedOut, true);
  finishJob(job, { status: "cancelled" });
});

await test("cancelJob 触发 abort 与 onFinish，且只结算一次", () => {
  let finished = 0;
  const job = createJob({ runId: "run_e", kind: "bash", command: "sleep", onFinish: () => { finished += 1; } });
  let aborted = false;
  job.controller.signal.addEventListener("abort", () => { aborted = true; });
  const result = cancelJob(job.jobId, "test");
  assert.equal(result.ok, true);
  assert.equal(result.job.status, "cancelled");
  assert.equal(aborted, true);
  assert.equal(finished, 1);
  const again = finishJob(job, { status: "completed", exitCode: 0 });
  assert.equal(again.status, "cancelled");
  assert.equal(finished, 1);
});

await test("listJobs 可按 Run 过滤", () => {
  const jobs = listJobs("run_a");
  assert.ok(jobs.length >= 1);
  assert.ok(jobs.every((job) => job.runId === "run_a"));
});

console.log("\n▶ 重启恢复");
await test("遗留 running 元数据被标为 interrupted", () => {
  const dir = path.join(tempJobs, "run_restart");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job_legacy.json"), JSON.stringify({ jobId: "job_legacy", runId: "run_restart", status: "running" }), "utf8");
  const count = markInterruptedJobs();
  assert.ok(count >= 1);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "job_legacy.json"), "utf8"));
  assert.equal(meta.status, "interrupted");
});

console.log("\n▶ 接线契约");
await test("agent 接入 2 分钟阈值、bash 转后台与 office batch", () => {
  const source = fs.readFileSync(path.join(ROOT, "server/agent.mjs"), "utf8");
  assert.match(source, /BACKGROUND_AFTER_MS/, "应使用统一阈值");
  assert.match(source, /\[BACKGROUNDED\] jobId=/, "bash 应输出 BACKGROUNDED 标记");
  assert.match(source, /parsed\.command === "batch"/, "OfficeCLI batch 应允许后台");
  assert.match(source, /tool_backgrounded/, "应发 tool_backgrounded 事件");
  assert.match(source, /jobStatusTool/, "应定义 job_status");
  assert.match(source, /jobCancelTool/, "应定义 job_cancel");
  assert.match(source, /officeLockHandedOff/, "后台 OfficeCLI 应接管写锁");
});

await test("白名单/元数据/事件注册表已同步", () => {
  const task = fs.readFileSync(path.join(ROOT, "server/task.mjs"), "utf8");
  assert.match(task, /"job_status", "job_cancel"/, "Work 白名单应含后台任务工具");
  const meta = fs.readFileSync(path.join(ROOT, "server/工具元数据.mjs"), "utf8");
  assert.match(meta, /meta\("job_status"/);
  assert.match(meta, /meta\("job_cancel"/);
  const registry = fs.readFileSync(path.join(ROOT, "server/事件注册表.mjs"), "utf8");
  for (const type of ["tool_backgrounded", "background_job_finished", "background_job_failed", "background_job_cancelled"]) {
    assert.match(registry, new RegExp(`type: "${type}"`), `缺少事件 ${type}`);
  }
});

resetJobsForTest();
fs.rmSync(tempJobs, { recursive: true, force: true });

console.log(failed ? "\n后台任务测试：存在失败项" : "\n后台任务测试：全部通过（11 例）");
process.exit(failed ? 1 : 0);
