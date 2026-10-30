import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 规聚本地运行数据的安全持久化工具。
 * 先写同目录临时文件并尽力完成 fsync，再替换目标文件，避免服务异常时直接截断原文件。
 */
export function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function temporaryPath(file, suffix = "tmp") {
  return `${file}.${process.pid}.${crypto.randomUUID()}.${suffix}`;
}

function closeQuietly(fd) {
  try { if (fd !== undefined && fd !== null) fs.closeSync(fd); } catch {}
}

function replaceFile(temp, file) {
  try {
    fs.renameSync(temp, file);
    return;
  } catch (error) {
    // Windows 不允许 rename 覆盖已存在目标；先移动旧文件，失败时尽力恢复。
    if (!fs.existsSync(file) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
  const backup = temporaryPath(file, "bak");
  fs.renameSync(file, backup);
  try {
    fs.renameSync(temp, file);
    try { fs.rmSync(backup, { force: true }); } catch {}
  } catch (error) {
    try {
      if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file);
    } catch {}
    throw error;
  }
}

export function atomicWriteFile(file, data, encoding = "utf8") {
  const target = path.resolve(file);
  ensureDirectory(path.dirname(target));
  const temp = temporaryPath(target);
  let fd;
  try {
    fd = fs.openSync(temp, "w");
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding);
    fs.writeFileSync(fd, buffer);
    try { fs.fsyncSync(fd); } catch {}
    closeQuietly(fd);
    fd = undefined;
    replaceFile(temp, target);
  } catch (error) {
    closeQuietly(fd);
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  return target;
}

export function atomicWriteJson(file, value) {
  return atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * P2：事件流/用量日志的 fsync 批量合并。
 *
 * 每次追加都 fsync 是最稳的，但事件密集时（一轮几十个工具事件）会把磁盘同步
 * 开销全部压进事件循环。这里把 fsync 合并到最多每 250ms 一次：
 *   - 写入本身（write）仍然立即发生，读进程立刻可见；
 *   - 只有“掉电持久性”被放宽到最后一次 fsync，退出前会同步 flush；
 *   - `OAW_FSYNC_INTERVAL_MS=0` 可恢复逐条 fsync 的旧行为。
 */
const FSYNC_INTERVAL_MS = Math.max(0, Number(process.env.OAW_FSYNC_INTERVAL_MS ?? 250) || 0);
const fsyncState = new Map();
const fsyncStats = { writes: 0, syncs: 0, deferred: 0 };
let exitHookInstalled = false;

function syncFile(file) {
  try {
    const fd = fs.openSync(file, "a");
    try { fs.fsyncSync(fd); } finally { closeQuietly(fd); }
    fsyncStats.syncs += 1;
  } catch {}
}

function flushPendingFsyncs() {
  for (const [file, state] of fsyncState) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.dirty) {
      state.dirty = false;
      syncFile(file);
    }
  }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", flushPendingFsyncs);
}

function fsyncSoon(file) {
  const state = fsyncState.get(file) || { lastSyncAt: 0, timer: null, dirty: false };
  const now = Date.now();
  if (FSYNC_INTERVAL_MS === 0 || now - state.lastSyncAt >= FSYNC_INTERVAL_MS) {
    state.lastSyncAt = now;
    state.dirty = false;
    fsyncState.set(file, state);
    syncFile(file);
    return true;
  }
  state.dirty = true;
  fsyncStats.deferred += 1;
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!state.dirty) return;
      state.dirty = false;
      state.lastSyncAt = Date.now();
      syncFile(file);
    }, Math.max(20, FSYNC_INTERVAL_MS - (now - state.lastSyncAt)));
    state.timer.unref?.();
    installExitHook();
  }
  fsyncState.set(file, state);
  return false;
}

/** 测试/诊断用：fsync 合并计数与当前策略。 */
export function fsyncStatsSnapshot() {
  return { ...fsyncStats, intervalMs: FSYNC_INTERVAL_MS, pendingFiles: [...fsyncState.values()].filter((item) => item.dirty).length };
}

/** 显式 flush 所有待同步文件（关闭服务前可调用）。 */
export function flushPendingFsync() {
  flushPendingFsyncs();
}

/** 使用 O_APPEND 写入一条完整 JSONL；fsync 按 FSYNC_INTERVAL_MS 合并。 */
export function appendJsonLine(file, value) {
  const target = path.resolve(file);
  ensureDirectory(path.dirname(target));
  const fd = fs.openSync(target, "a");
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    fsyncStats.writes += 1;
    fsyncSoon(target);
  } finally {
    closeQuietly(fd);
  }
  return target;
}

export function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
