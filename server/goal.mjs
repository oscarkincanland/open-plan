import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { appendEvent } from "./事件存储.mjs";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";

/**
 * v0.13.0：会话级长期目标（Goal）。
 *
 * Goal 是项目 Harness 的能力，不是 Pi 原生能力：它只做跨轮目标、预算与状态记录，
 * 不改变 Run 的生命周期，也不改写 Pi 会话文件。持久化使用本地 JSON（不使用数据库）。
 */
const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const GOAL_DIR = path.resolve(process.env.OAW_GOAL_DIR || path.join(PROJECT_DIR, ".oaw", "goals"));
const GOAL_VERSION = 1;
const MAX_TEXT = 4000;

export const GOAL_STATUSES = Object.freeze(["active", "paused", "blocked", "max_turns", "budget_limited", "complete"]);

export function goalStatusLabel(status) {
  return ({
    active: "进行中",
    paused: "已暂停",
    blocked: "受阻",
    max_turns: "达轮次上限",
    budget_limited: "达预算上限",
    complete: "已完成",
  })[status] || String(status || "");
}

export function goalFileFor(sessionId) {
  const key = String(sessionId || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (!key) return "";
  return path.join(GOAL_DIR, `${key}.json`);
}

function normalizeInt(value, fallback = 0) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeGoal(sessionId, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!GOAL_STATUSES.includes(raw.status)) return null;
  return {
    version: GOAL_VERSION,
    goalId: String(raw.goalId || `goal_${crypto.randomUUID()}`),
    sessionId: String(raw.sessionId || sessionId),
    text: String(raw.text || "").slice(0, MAX_TEXT),
    status: raw.status,
    budgetTokens: normalizeInt(raw.budgetTokens, 0),
    maxTurns: normalizeInt(raw.maxTurns, 0),
    usedTokens: normalizeInt(raw.usedTokens, 0),
    turns: normalizeInt(raw.turns, 0),
    activeMs: normalizeInt(raw.activeMs, 0),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    completedAt: raw.completedAt || null,
    lastRunId: raw.lastRunId || null,
  };
}

export function readGoal(sessionId) {
  const file = goalFileFor(sessionId);
  if (!file) return null;
  const raw = readJsonFile(file, null);
  return normalizeGoal(sessionId, raw);
}

function writeGoal(goal) {
  const file = goalFileFor(goal.sessionId);
  if (!file) throw new Error("goal sessionId required");
  ensureDirectory(GOAL_DIR);
  atomicWriteJson(file, goal);
  return goal;
}

function emitGoalEvent(type, goal, extra = {}) {
  try {
    appendEvent({
      clientId: extra.clientId || null,
      threadId: extra.threadId || goal.sessionId,
      type,
      data: {
        goalId: goal.goalId,
        sessionId: goal.sessionId,
        text: goal.text,
        status: goal.status,
        turns: goal.turns,
        usedTokens: goal.usedTokens,
        budgetTokens: goal.budgetTokens,
        ...(extra.action ? { action: extra.action } : {}),
      },
    });
  } catch (error) {
    console.warn("[goal] 事件写入失败：", error?.message || error);
  }
}

function fail(status, code, error) {
  return { ok: false, status, code, error };
}

export function setGoal(sessionId, payload = {}, context = {}) {
  const key = String(sessionId || "").trim();
  if (!key) return fail(400, "SESSION_NOT_FOUND", "sessionId required");
  const text = String(payload.text || "").trim();
  if (!text) return fail(400, "GOAL_TEXT_REQUIRED", "目标文本不能为空");
  if (text.length > MAX_TEXT) return fail(400, "GOAL_TEXT_TOO_LONG", `目标文本不能超过 ${MAX_TEXT} 字`);
  const existing = readGoal(key);
  const now = new Date().toISOString();
  const goal = {
    version: GOAL_VERSION,
    goalId: existing?.goalId || `goal_${crypto.randomUUID()}`,
    sessionId: key,
    text,
    status: "active",
    budgetTokens: normalizeInt(payload.budgetTokens, existing?.budgetTokens || 0),
    maxTurns: normalizeInt(payload.maxTurns, existing?.maxTurns || 0),
    usedTokens: existing?.usedTokens || 0,
    turns: existing?.turns || 0,
    activeMs: existing?.activeMs || 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    completedAt: null,
    lastRunId: existing?.lastRunId || null,
  };
  try {
    writeGoal(goal);
  } catch (error) {
    return fail(500, "GOAL_WRITE_FAILED", error?.message || "目标写入失败");
  }
  emitGoalEvent(existing ? "goal_updated" : "goal_created", goal, { ...context, action: existing ? "replace" : "create" });
  return { ok: true, goal };
}

const ALLOWED_ACTIONS = new Set(["pause", "resume", "continue", "complete", "edit", "budget"]);

export function actOnGoal(sessionId, action, payload = {}, context = {}) {
  const key = String(sessionId || "").trim();
  const current = readGoal(key);
  if (!current) return fail(404, "GOAL_NOT_FOUND", "当前会话没有长期目标");
  const name = String(action || "").trim();
  if (!ALLOWED_ACTIONS.has(name)) return fail(400, "GOAL_ACTION_INVALID", `不支持的目标操作：${name || "（空）"}`);
  if (current.status === "complete") return fail(409, "GOAL_INVALID_STATE", "目标已完成，不能再操作");
  const now = new Date().toISOString();
  const next = { ...current, updatedAt: now };

  if (name === "pause") {
    if (current.status !== "active") return fail(409, "GOAL_INVALID_STATE", "只有进行中的目标可以暂停");
    next.status = "paused";
  } else if (name === "resume") {
    if (!["paused", "blocked"].includes(current.status)) return fail(409, "GOAL_INVALID_STATE", "只有已暂停或受阻的目标可以恢复");
    next.status = "active";
  } else if (name === "continue") {
    if (current.status !== "max_turns") return fail(409, "GOAL_INVALID_STATE", "只有达到轮次上限的目标可以继续");
    // 继续不重置统计，只把上限提高一轮，避免立刻再次撞线。
    next.status = "active";
    next.maxTurns = Math.max(current.maxTurns || 0, current.turns + 1);
  } else if (name === "complete") {
    next.status = "complete";
    next.completedAt = now;
  } else if (name === "edit") {
    const text = String(payload.text || "").trim();
    if (!text) return fail(400, "GOAL_TEXT_REQUIRED", "目标文本不能为空");
    if (text.length > MAX_TEXT) return fail(400, "GOAL_TEXT_TOO_LONG", `目标文本不能超过 ${MAX_TEXT} 字`);
    next.text = text;
    if (current.status !== "active") next.status = "active";
    next.completedAt = null;
  } else if (name === "budget") {
    const budgetTokens = normalizeInt(payload.budgetTokens, current.budgetTokens);
    if (payload.budgetTokens !== undefined && (!Number.isFinite(Number(payload.budgetTokens)) || Number(payload.budgetTokens) < 0)) {
      return fail(400, "GOAL_BUDGET_INVALID", "Token 预算必须是非负整数");
    }
    next.budgetTokens = budgetTokens;
    if (payload.maxTurns !== undefined) next.maxTurns = normalizeInt(payload.maxTurns, current.maxTurns);
    if (current.status === "budget_limited" && (budgetTokens === 0 || budgetTokens > current.usedTokens)) next.status = "active";
    if (current.status === "max_turns" && (next.maxTurns === 0 || next.maxTurns > current.turns)) next.status = "active";
  }

  try {
    writeGoal(next);
  } catch (error) {
    return fail(500, "GOAL_WRITE_FAILED", error?.message || "目标写入失败");
  }
  emitGoalEvent("goal_updated", next, { ...context, action: name });
  return { ok: true, goal: next };
}

export function clearGoal(sessionId, context = {}) {
  const key = String(sessionId || "").trim();
  const current = readGoal(key);
  if (!current) return fail(404, "GOAL_NOT_FOUND", "当前会话没有长期目标");
  const file = goalFileFor(key);
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    return fail(500, "GOAL_WRITE_FAILED", error?.message || "目标清除失败");
  }
  emitGoalEvent("goal_cleared", { ...current, status: "cleared" }, { ...context, action: "clear" });
  return { ok: true, goal: null };
}

/** Prompt 注入：只返回跨轮目标摘要，不改变 task.goal（本轮任务描述）。 */
export function goalPromptContext(sessionId) {
  const goal = readGoal(sessionId);
  if (!goal || goal.status === "complete") return null;
  return {
    text: goal.text,
    status: goal.status,
    statusLabel: goalStatusLabel(goal.status),
    turns: goal.turns,
    usedTokens: goal.usedTokens,
    budgetTokens: goal.budgetTokens,
    maxTurns: goal.maxTurns,
  };
}

function runTokens(events = []) {
  let total = 0;
  for (const event of events) {
    if (!event || (event.type !== "stats" && event.type !== "usage")) continue;
    const data = event.data || {};
    total += Number(data.totalTokens || 0)
      || (Number(data.input ?? data.inputTokens ?? 0)
        + Number(data.output ?? data.outputTokens ?? 0)
        + Number(data.cacheRead ?? data.cacheReadTokens ?? 0)
        + Number(data.cacheWrite ?? data.cacheWriteTokens ?? 0));
  }
  return total;
}

/**
 * Run 收口后累计统计并检查 Goal 预算/轮次。失败/取消也计入已消耗，但不改写 Run 终态。
 */
export function recordRunFinished({ sessionId, threadId = "", runId = "", status = "completed", completionStatus = "", startedAt = null, finishedAt = null, events = [] } = {}) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  const goal = readGoal(key);
  if (!goal || goal.status === "complete") return null;
  if (goal.status !== "active") {
    // 暂停/受阻期间不累计轮次与 Token，但记录最近一次 Run 便于诊断。
    if (!goal.lastRunId) {
      try { writeGoal({ ...goal, lastRunId: runId || goal.lastRunId, updatedAt: new Date().toISOString() }); } catch {}
    }
    return goal;
  }
  const started = Date.parse(startedAt || "") || 0;
  const finished = Date.parse(finishedAt || "") || Date.now();
  const elapsed = started ? Math.max(0, finished - started) : 0;
  const next = {
    ...goal,
    turns: (goal.turns || 0) + 1,
    usedTokens: (goal.usedTokens || 0) + runTokens(events),
    activeMs: (goal.activeMs || 0) + elapsed,
    lastRunId: runId || goal.lastRunId,
    updatedAt: new Date().toISOString(),
  };
  if (String(completionStatus || status || "") === "blocked") next.status = "blocked";
  else if (next.budgetTokens > 0 && next.usedTokens >= next.budgetTokens) next.status = "budget_limited";
  else if (next.maxTurns > 0 && next.turns >= next.maxTurns) next.status = "max_turns";
  try {
    writeGoal(next);
  } catch (error) {
    console.warn("[goal] 统计写入失败：", error?.message || error);
    return goal;
  }
  emitGoalEvent("goal_updated", next, { threadId: threadId || key, action: "run_finished" });
  return next;
}
