/**
 * 工作流阶段日志与幂等重跑（H4-2 最小版）
 *
 * 定位：只记录“阶段开始/结束/产物/错误”，支持失败后从最后一个成功阶段重跑；
 * 不引入 TS 脚本引擎、不做 token 级缓存。
 * 约束：只有声明为幂等的阶段才允许重放；有副作用的阶段必须由调用方显式处理。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace.mjs";
import { ensureDirectory } from "./持久化工具.mjs";

export function journalDir() {
  return process.env.OAW_WORKFLOW_JOURNAL_DIR || path.join(PROJECT_DIR, ".oaw", "workflows");
}

function safeRunId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "run";
}

export function journalFile(runId) {
  return path.join(journalDir(), `${safeRunId(runId)}.jsonl`);
}

export function appendJournal(runId, entry = {}) {
  if (!runId) return { ok: false, error: "runId required" };
  const file = journalFile(runId);
  const record = {
    runId: String(runId),
    stage: String(entry.stage || ""),
    status: String(entry.status || "started"),
    statusLabel: String(entry.statusLabel || ""),
    artifacts: Array.isArray(entry.artifacts) ? entry.artifacts.map(String) : [],
    error: entry.error ? String(entry.error).slice(0, 1000) : null,
    idempotent: entry.idempotent !== false,
    at: entry.at || new Date().toISOString(),
  };
  try {
    ensureDirectory(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true, record, file };
  } catch (error) {
    return { ok: false, error: error.message, record, file };
  }
}

export function readJournal(runId) {
  const file = journalFile(runId);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

export function lastSuccessfulStage(runId) {
  const records = readJournal(runId);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].status === "completed") return records[i];
  }
  return null;
}

/**
 * 计算重放计划。
 * @param {string[]} stages 有序阶段名
 * @param {Array} journal 已记录的 journal
 * @returns {{startIndex:number, completed:string[], pending:string[], rerun:string[], skipped:string[]}}
 */
export function planReplay(stages = [], journal = []) {
  const list = (Array.isArray(stages) ? stages : []).map((item) => typeof item === "string" ? item : String(item?.id || item?.name || ""));
  const statusByStage = new Map();
  for (const record of Array.isArray(journal) ? journal : []) {
    if (!record?.stage) continue;
    const current = statusByStage.get(record.stage) || {};
    statusByStage.set(record.stage, { ...current, [record.status]: true, last: record });
  }
  const completed = [];
  const rerun = [];
  const skipped = [];
  let startIndex = list.length;
  for (let i = 0; i < list.length; i += 1) {
    const stage = list[i];
    const status = statusByStage.get(stage) || {};
    if (status.completed) {
      completed.push(stage);
      continue;
    }
    startIndex = i;
    break;
  }
  for (let i = startIndex; i < list.length; i += 1) {
    const stage = list[i];
    const status = statusByStage.get(stage) || {};
    const last = status.last;
    if (last && last.idempotent === false) skipped.push(stage);
    else rerun.push(stage);
  }
  return { startIndex, completed, pending: list.slice(startIndex), rerun, skipped };
}

export function clearJournal(runId) {
  try {
    fs.rmSync(journalFile(runId), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
