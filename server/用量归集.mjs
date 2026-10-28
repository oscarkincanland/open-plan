/**
 * 用量归集（H1-4）
 *
 * 事实来源：`.oaw/usage/用量.jsonl`（JSONL，不引入数据库）。
 * 设计约束：
 *   - 追加写 + 可选轮转；失败不阻断主 Run；
 *   - 取不到的字段写 null，绝不估算/伪造；
 *   - 与 stats 事件并存：usage 是计量事实，事件是实时展示事实。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace.mjs";
import { ensureDirectory } from "./持久化工具.mjs";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function usageFilePath() {
  return process.env.OAW_USAGE_FILE || path.join(PROJECT_DIR, ".oaw", "usage", "用量.jsonl");
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = numberOrNull(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

export function normalizeUsageRecord(input = {}) {
  const usage = input.usage && typeof input.usage === "object" ? input.usage : {};
  return {
    runId: input.runId ? String(input.runId) : null,
    turnId: input.turnId ?? null,
    actorKind: String(input.actorKind || "main"),
    actorId: input.actorId ? String(input.actorId) : "main",
    provider: input.provider ? String(input.provider) : null,
    model: input.model ? String(input.model) : null,
    querySource: String(input.querySource || "agent_step"),
    inputTokens: pickNumber(usage, ["inputTokens", "input", "input_tokens"]),
    outputTokens: pickNumber(usage, ["outputTokens", "output", "output_tokens"]),
    cacheReadTokens: pickNumber(usage, ["cacheReadTokens", "cacheRead", "cache_read", "cache_read_input_tokens"]),
    cacheWriteTokens: pickNumber(usage, ["cacheWriteTokens", "cacheWrite", "cache_write", "cache_creation_input_tokens"]),
    contextTokens: pickNumber(usage, ["contextTokens", "context", "context_tokens"]),
    totalTokens: pickNumber(usage, ["totalTokens", "total", "total_tokens"]),
    cost: numberOrNull(input.cost),
    durationMs: numberOrNull(input.durationMs),
    ttftMs: numberOrNull(input.ttftMs),
    toolCallCount: numberOrNull(input.toolCallCount),
    finishReason: input.finishReason ? String(input.finishReason) : null,
    at: input.at || new Date().toISOString(),
  };
}

export function appendUsageRecord(record, { file = usageFilePath(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const normalized = normalizeUsageRecord(record);
  try {
    ensureDirectory(path.dirname(file));
    rotateIfNeeded(file, maxBytes);
    fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`, "utf8");
    return { ok: true, record: normalized, file };
  } catch (error) {
    return { ok: false, error: error.message, record: normalized, file };
  }
}

export function recordUsage(input, options = {}) {
  return appendUsageRecord(input, options);
}

function rotateIfNeeded(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < maxBytes) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archived = file.replace(/\.jsonl$/i, `-${stamp}.jsonl`);
    fs.renameSync(file, archived);
    return true;
  } catch {
    return false;
  }
}

export function readUsageRecords({ file = usageFilePath(), runId = "", limit = 0 } = {}) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (runId && item.runId !== runId) continue;
      records.push(item);
    } catch {}
  }
  const capped = limit > 0 ? records.slice(-limit) : records;
  return capped;
}

export function sumBy(records = [], key = "actorKind") {
  const groups = new Map();
  for (const record of records) {
    const name = String(record?.[key] ?? "unknown");
    const item = groups.get(name) || {
      key: name,
      count: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 0,
      totalTokens: 0,
      cost: 0,
      durationMs: 0,
      toolCallCount: 0,
    };
    item.count += 1;
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "contextTokens", "totalTokens", "cost", "durationMs", "toolCallCount"]) {
      item[field] += Number(record?.[field]) || 0;
    }
    groups.set(name, item);
  }
  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function summarizeUsage(records = []) {
  const total = records.reduce((acc, record) => {
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "contextTokens", "totalTokens", "cost", "durationMs", "toolCallCount"]) {
      acc[field] += Number(record?.[field]) || 0;
    }
    acc.count += 1;
    return acc;
  }, {
    count: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    totalTokens: 0,
    cost: 0,
    durationMs: 0,
    toolCallCount: 0,
  });
  return {
    total,
    byActor: sumBy(records, "actorKind"),
    byQuerySource: sumBy(records, "querySource"),
    byModel: sumBy(records, "model"),
  };
}

export function usageSnapshotForRun(runId, options = {}) {
  const records = readUsageRecords({ ...options, runId, limit: 0 });
  return { runId, records, summary: summarizeUsage(records) };
}
