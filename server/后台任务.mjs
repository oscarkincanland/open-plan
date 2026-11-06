/**
 * 后台任务（Job）管理器（计划 2026-11-03-013 / 2026-11-04）
 *
 * 目标：工具执行超过阈值仍未完成时，把等待移出主流程——工具先返回
 * BACKGROUNDED，进程继续跑；模型可以继续做不依赖它的步骤，需要结果时
 * 用 job_status 等待/读取，完成后发事件并写任务中心。
 *
 * 约束：
 *   - 纯 Node + 文件，不引入数据库/队列；
 *   - 元数据与日志落在 .oaw/jobs/<runId>/，不进入用户工作区产物；
 *   - 只保存有界尾部输出，避免长任务日志无限增长；
 *   - 取消走 AbortController，由调用方把 abort 信号接到真实进程/CLI；
 *   - 服务重启不自动重跑：启动时把遗留 running 标为 interrupted（由调用方调用）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BACKGROUND_AFTER_MS = Math.max(
  10_000,
  Number.parseInt(process.env.OAW_BACKGROUND_AFTER_MS || "120000", 10) || 120_000,
);
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 64 * 1024;
const JOBS_ROOT = path.resolve(process.env.OAW_JOBS_DIR || path.join(process.cwd(), ".oaw", "jobs"));

const jobs = new Map(); // jobId -> job

function jobDir(runId) {
  const safeRun = String(runId || "run_unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.join(JOBS_ROOT, safeRun);
}

function metaPath(job) {
  return path.join(jobDir(job.runId), `${job.jobId}.json`);
}

function logPath(job) {
  return path.join(jobDir(job.runId), `${job.jobId}.log`);
}

function persist(job) {
  try {
    fs.mkdirSync(jobDir(job.runId), { recursive: true });
    fs.writeFileSync(metaPath(job), JSON.stringify(publicJob(job), null, 2), "utf8");
  } catch {}
}

/** 对外的稳定快照（不暴露 controller / promise）。 */
export function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    runId: job.runId,
    threadId: job.threadId,
    kind: job.kind,
    command: job.command,
    cwd: job.cwd,
    mutating: Boolean(job.mutating),
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode ?? null,
    outputBytes: job.outputBytes || 0,
    outputTruncated: Boolean(job.outputTruncated),
    error: job.error || "",
    summary: job.summary || "",
    logPath: job.logPath || "",
  };
}

export function getJob(jobId) {
  return jobs.get(String(jobId || "")) || null;
}

export function listJobs(runId = "") {
  return [...jobs.values()]
    .filter((job) => !runId || job.runId === runId)
    .map(publicJob);
}

/**
 * 创建 Job。调用方负责把 job.controller.signal 接到真实进程/CLI。
 * @param {{runId:string, threadId?:string, kind:string, command:string, cwd?:string, mutating?:boolean, onFinish?:Function}} input
 */
export function createJob({
  runId = "",
  threadId = "",
  kind = "bash",
  command = "",
  cwd = "",
  mutating = false,
  onFinish = null,
} = {}) {
  const jobId = `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const job = {
    jobId,
    runId: String(runId || ""),
    threadId: String(threadId || ""),
    kind: String(kind || "bash"),
    command: String(command || "").slice(0, 1000),
    cwd: String(cwd || ""),
    mutating: Boolean(mutating),
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    outputBytes: 0,
    outputTruncated: false,
    error: "",
    summary: "",
    logPath: logPath({ runId, jobId }),
    controller: new AbortController(),
    onFinish: typeof onFinish === "function" ? onFinish : null,
    waiters: new Set(),
    result: null,
    output: "",
  };
  jobs.set(jobId, job);
  try { fs.mkdirSync(jobDir(job.runId), { recursive: true }); } catch {}
  persist(job);
  return job;
}

/** 追加输出：内存只保留尾部，日志文件按上限追加。 */
export function appendJobOutput(job, chunk) {
  if (!job || job.status !== "running") return;
  const text = String(chunk ?? "");
  if (!text) return;
  job.outputBytes += Buffer.byteLength(text, "utf8");
  job.output = `${job.output}${text}`;
  if (job.output.length > MAX_RESULT_CHARS) job.output = job.output.slice(-MAX_RESULT_CHARS);
  if (!job.outputTruncated && job.outputBytes <= MAX_LOG_BYTES) {
    try { fs.appendFileSync(job.logPath, text, "utf8"); } catch {}
  } else {
    job.outputTruncated = true;
  }
}

function settleWaiters(job) {
  for (const resolve of job.waiters) {
    try { resolve(publicJob(job)); } catch {}
  }
  job.waiters.clear();
}

/** 结算 Job；重复调用只生效一次。 */
export function finishJob(job, { status = "completed", exitCode = null, error = "", summary = "", result = null } = {}) {
  if (!job || job.status !== "running") return publicJob(job);
  job.status = ["completed", "failed", "cancelled", "interrupted"].includes(status) ? status : "completed";
  job.endedAt = new Date().toISOString();
  job.exitCode = exitCode ?? null;
  job.error = String(error || "").slice(0, 2000);
  job.summary = String(summary || "").slice(0, 8000);
  job.result = result;
  if (job.status === "completed" && exitCode !== null && Number(exitCode) !== 0) job.status = "failed";
  persist(job);
  // 无论完成/失败/取消，都释放调用方持有的锁等资源。
  try {
    const finish = job.onFinish;
    job.onFinish = null;
    finish?.();
  } catch {}
  settleWaiters(job);
  return publicJob(job);
}

/** 取消 Job：abort 信号 + onCancel（释放锁等）。 */
export function cancelJob(jobId, reason = "用户取消后台任务") {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: "job_not_found" };
  if (job.status !== "running") return { ok: true, job: publicJob(job) };
  try { job.controller.abort(); } catch {}
  finishJob(job, { status: "cancelled", error: String(reason || "") });
  return { ok: true, job: publicJob(job) };
}

export function cancelRunJobs(runId, reason = "Run 已取消", onCancelled = null) {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.runId !== runId || job.status !== "running") continue;
    const result = cancelJob(job.jobId, reason);
    if (result.ok) {
      count += 1;
      try { onCancelled?.(result.job, reason); } catch {}
    }
  }
  return count;
}

/** 等 Job 结束（有超时；超时返回当前快照，不取消 Job）。 */
export function waitForJob(jobId, timeoutMs = 30_000) {
  const job = getJob(jobId);
  if (!job) return Promise.resolve(null);
  if (job.status !== "running") return Promise.resolve(publicJob(job));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      job.waiters.delete(done);
      resolve({ ...publicJob(job), waitedOut: true });
    }, Math.max(1000, Number(timeoutMs) || 30_000));
    const done = (snapshot) => {
      clearTimeout(timer);
      resolve(snapshot);
    };
    job.waiters.add(done);
  });
}

/** 服务启动时：把遗留 running 标为 interrupted（不自动重跑）。 */
export function markInterruptedJobs() {
  let count = 0;
  try {
    if (!fs.existsSync(JOBS_ROOT)) return 0;
    for (const runDir of fs.readdirSync(JOBS_ROOT)) {
      const dir = path.join(JOBS_ROOT, runDir);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const full = path.join(dir, file);
        try {
          const meta = JSON.parse(fs.readFileSync(full, "utf8"));
          if (meta.status !== "running") continue;
          meta.status = "interrupted";
          meta.endedAt = new Date().toISOString();
          meta.error = "服务重启，后台任务已中断（不会自动重跑）";
          fs.writeFileSync(full, JSON.stringify(meta, null, 2), "utf8");
          count += 1;
        } catch {}
      }
    }
  } catch {}
  return count;
}

/** 任务中心读取日志尾部。 */
export function readJobLog(jobId, maxChars = 16_000) {
  const job = getJob(jobId);
  if (!job) return "";
  if (job.output) return job.output.slice(-maxChars);
  try { return fs.readFileSync(job.logPath, "utf8").slice(-maxChars); } catch { return ""; }
}

/** 测试用：清空内存表（不删除磁盘日志）。 */
export function resetJobsForTest() {
  jobs.clear();
}
