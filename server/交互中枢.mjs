/**
 * 人机协作中枢（2026-11-08，D2；计划 2026-11-08-001 §11、ADR-0026）
 *
 * 把“需要人给一个输入”的交互统一为 Interaction：
 *   - kind：clarify（补充信息）/ confirm（高风险确认）/ review（草稿预览）/ approval（工具审批）
 *   - 状态：open → editing → submitting → settled(answered|skipped|assumed|denied|cancelled) | expired
 *   - 优先级：approval 30 > confirm 20 > clarify 10 > review 5
 *   - 存储：`.oaw/interactions.json`（活动 + 最近 200 条历史；可用 OAW_INTERACTIONS_FILE 覆盖）
 *
 * 约束：
 *   - 本模块只做“状态与存储”，不触发模型续跑；续跑仍由既有执行句柄负责；
 *   - legacy `pending-asks.json` 在迁移时只读，不改写；
 *   - 所有写入原子（临时文件 + rename），失败不破坏已有文件。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const INTERACTION_STATUSES = Object.freeze([
  "open", "editing", "submitting", "settled", "expired", "cancelled",
]);

const ACTIVE_STATUSES = new Set(["open", "editing", "submitting"]);
const SETTLED_REASONS = new Set(["answered", "skipped", "assumed", "denied", "cancelled"]);
const PRIORITY = { approval: 30, confirm: 20, clarify: 10, review: 5 };
const MAX_HISTORY = 200;

export function priorityOf(kind = "clarify") {
  return PRIORITY[String(kind || "clarify")] || PRIORITY.clarify;
}

export function interactionsFile() {
  const override = String(process.env.OAW_INTERACTIONS_FILE || "").trim();
  return override || path.join(process.cwd(), ".oaw", "interactions.json");
}

function readAll() {
  try {
    const items = JSON.parse(fs.readFileSync(interactionsFile(), "utf8"));
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

function writeAll(items) {
  const file = interactionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items.slice(-MAX_HISTORY), null, 2), "utf8");
  fs.renameSync(temp, file);
}

function newId(prefix = "itx") {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** 对外稳定快照（去掉内部字段）。 */
export function interactionView(record) {
  if (!record) return null;
  return {
    interactionId: record.id,
    kind: record.kind,
    status: record.status,
    clientId: record.clientId || "",
    threadId: record.threadId || "",
    runId: record.runId || null,
    priority: record.priority ?? priorityOf(record.kind),
    payload: record.payload || {},
    owner: record.owner || null,
    assumption: record.assumption || "",
    answer: record.answer ?? null,
    values: record.values ?? null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    expiresAt: record.expiresAt || null,
    settledAt: record.settledAt || null,
    settledReason: record.settledReason || null,
    legacy: record.legacy || null,
  };
}

/** 活动交互（按优先级、创建时间排序）。 */
export function listActiveInteractions({ clientId = "", threadId = "", kind = "" } = {}) {
  return readAll()
    .filter((item) => ACTIVE_STATUSES.has(item.status))
    .filter((item) => !clientId || item.clientId === clientId)
    .filter((item) => !threadId || !item.threadId || item.threadId === threadId)
    .filter((item) => !kind || item.kind === kind)
    .sort((left, right) =>
      (right.priority ?? priorityOf(right.kind)) - (left.priority ?? priorityOf(left.kind))
      || String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
    )
    .map(interactionView);
}

export function getInteraction(id = "") {
  const key = String(id || "").trim();
  if (!key) return null;
  return interactionView(readAll().find((item) => item.id === key) || null);
}

/**
 * 创建交互。
 * @param {{kind?:string, clientId:string, threadId?:string, runId?:string, payload?:object,
 *          owner?:object, expiresAt?:string|number, assumption?:string, legacy?:object}} input
 */
export function createInteraction({
  id = "",
  kind = "clarify",
  clientId = "",
  threadId = "",
  runId = "",
  payload = {},
  owner = null,
  expiresAt = null,
  assumption = "",
  legacy = null,
} = {}) {
  const finalKind = ["clarify", "confirm", "review", "approval"].includes(kind) ? kind : "clarify";
  const now = new Date().toISOString();
  const record = {
    id: String(id || "").trim() || newId(finalKind === "approval" ? "itx_ap" : "itx"),
    kind: finalKind,
    status: "open",
    priority: priorityOf(finalKind),
    clientId: String(clientId || ""),
    threadId: String(threadId || ""),
    runId: runId ? String(runId) : null,
    payload: payload && typeof payload === "object" ? payload : {},
    owner: owner && typeof owner === "object" ? owner : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    assumption: String(assumption || ""),
    createdAt: now,
    updatedAt: now,
    settledAt: null,
    settledReason: null,
    answer: null,
    values: null,
    legacy: legacy && typeof legacy === "object" ? legacy : null,
  };
  const items = readAll();
  // 同一 runId 同时最多 1 个 clarify（计划 §11.2）。
  if (finalKind === "clarify" && record.runId) {
    const duplicate = items.find((item) => item.kind === "clarify" && item.runId === record.runId && ACTIVE_STATUSES.has(item.status));
    if (duplicate) return { ok: false, code: "INTERACTION_CLARIFY_EXISTS", interaction: interactionView(duplicate) };
  }
  items.push(record);
  writeAll(items);
  return { ok: true, interaction: interactionView(record) };
}

/** 更新填写中状态（editing/submitting）；只对活动记录生效。 */
export function touchInteraction(id = "", status = "editing") {
  if (!["editing", "submitting"].includes(status)) return { ok: false, code: "INTERACTION_STATUS_INVALID" };
  const items = readAll();
  const record = items.find((item) => item.id === id);
  if (!record) return { ok: false, code: "INTERACTION_NOT_FOUND" };
  if (!ACTIVE_STATUSES.has(record.status)) return { ok: false, code: "INTERACTION_NOT_ACTIVE", interaction: interactionView(record) };
  record.status = status;
  record.updatedAt = new Date().toISOString();
  writeAll(items);
  return { ok: true, interaction: interactionView(record) };
}

/**
 * 结算交互（幂等：已结算的重复调用返回第一次结果）。
 * @param {string} id
 * @param {{reason?:string, answer?:string, values?:object, assumption?:string}} input
 */
export function settleInteraction(id = "", { reason = "answered", answer = null, values = null, assumption = "" } = {}) {
  const finalReason = SETTLED_REASONS.has(reason) ? reason : "answered";
  const items = readAll();
  const record = items.find((item) => item.id === id);
  if (!record) return { ok: false, code: "INTERACTION_NOT_FOUND" };
  if (record.status === "settled" || record.status === "expired" || record.status === "cancelled") {
    return { ok: true, idempotent: true, interaction: interactionView(record) };
  }
  record.status = finalReason === "cancelled" ? "cancelled" : "settled";
  record.settledReason = finalReason;
  record.settledAt = new Date().toISOString();
  record.updatedAt = record.settledAt;
  if (answer !== null && answer !== undefined) record.answer = String(answer);
  if (values && typeof values === "object") record.values = values;
  if (assumption) record.assumption = String(assumption);
  writeAll(items);
  return { ok: true, interaction: interactionView(record) };
}

/** 超时：settle 为 assumed（有假设）或 expired（confirm 不假设）。 */
export function expireInteraction(id = "", { assumption = "" } = {}) {
  const items = readAll();
  const record = items.find((item) => item.id === id);
  if (!record) return { ok: false, code: "INTERACTION_NOT_FOUND" };
  if (record.status !== "open" && record.status !== "editing" && record.status !== "submitting") {
    return { ok: true, idempotent: true, interaction: interactionView(record) };
  }
  const hasAssumption = Boolean(assumption || record.assumption);
  record.status = hasAssumption ? "settled" : "expired";
  record.settledReason = hasAssumption ? "assumed" : "expired";
  record.settledAt = new Date().toISOString();
  record.updatedAt = record.settledAt;
  if (assumption) record.assumption = String(assumption);
  writeAll(items);
  return { ok: true, interaction: interactionView(record) };
}

/** 用户修改/撤销假设（不改变已结算状态，只更新可追溯文本）。 */
export function assumeInteraction(id = "", assumption = "") {
  const text = String(assumption || "").trim().slice(0, 500);
  if (!text) return { ok: false, code: "INTERACTION_ASSUMPTION_REQUIRED" };
  const items = readAll();
  const record = items.find((item) => item.id === id);
  if (!record) return { ok: false, code: "INTERACTION_NOT_FOUND" };
  record.assumption = text;
  record.updatedAt = new Date().toISOString();
  writeAll(items);
  return { ok: true, interaction: interactionView(record) };
}

/** 取消一个客户端的所有活动交互（取消 Run / 新指令作废旧提问）。 */
export function cancelClientInteractions(clientId = "", reason = "cancelled") {
  if (!clientId) return { ok: false, updated: 0 };
  const items = readAll();
  let updated = 0;
  for (const record of items) {
    if (record.clientId !== clientId || !ACTIVE_STATUSES.has(record.status)) continue;
    record.status = "cancelled";
    record.settledReason = String(reason || "cancelled");
    record.settledAt = new Date().toISOString();
    record.updatedAt = record.settledAt;
    updated += 1;
  }
  if (updated) writeAll(items);
  return { ok: true, updated };
}

/** 清理超过 expiresAt 的活动交互（启动/读取时调用）。 */
export function expireStaleInteractions(now = Date.now()) {
  const items = readAll();
  let updated = 0;
  for (const record of items) {
    if (!ACTIVE_STATUSES.has(record.status)) continue;
    const expires = Date.parse(record.expiresAt || "");
    if (!Number.isFinite(expires) || expires >= now) continue;
    const hasAssumption = Boolean(record.assumption) && record.kind !== "confirm";
    record.status = hasAssumption ? "settled" : "expired";
    record.settledReason = hasAssumption ? "assumed" : "expired";
    record.settledAt = new Date().toISOString();
    record.updatedAt = record.settledAt;
    updated += 1;
  }
  if (updated) writeAll(items);
  return { ok: true, updated };
}

/**
 * 把 legacy `pending-asks.json` 的 open 记录迁移为 Interaction（纯函数，便于测试）。
 * @param {Array} asks
 * @returns {{created:number, skipped:number}}
 */
export function migrateLegacyAsks(asks = []) {
  const items = readAll();
  let created = 0;
  let skipped = 0;
  for (const ask of Array.isArray(asks) ? asks : []) {
    if (!ask || ask.status !== "pending" || !ask.id) { skipped += 1; continue; }
    if (items.some((item) => item.legacy?.id === ask.id || item.id === ask.id)) { skipped += 1; continue; }
    const expires = Date.parse(ask.expiresAt || "");
    if (Number.isFinite(expires) && expires < Date.now()) { skipped += 1; continue; }
    const kind = ask.intent === "confirm" ? "confirm" : ask.previewFile ? "review" : "clarify";
    items.push({
      id: `itx_${String(ask.id).replace(/^ask_/, "")}`,
      kind,
      status: "open",
      priority: priorityOf(kind),
      clientId: String(ask.clientId || ""),
      threadId: "",
      runId: ask.runId || null,
      payload: {
        question: ask.question || "",
        options: Array.isArray(ask.options) ? ask.options : [],
        ...(Array.isArray(ask.fields) && ask.fields.length ? { fields: ask.fields } : {}),
        ...(ask.previewFile ? { previewFile: ask.previewFile } : {}),
      },
      owner: null,
      expiresAt: ask.expiresAt || null,
      assumption: ask.assumption || "",
      createdAt: ask.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settledAt: null,
      settledReason: null,
      answer: null,
      values: null,
      legacy: { source: "pending-asks", id: ask.id },
    });
    created += 1;
  }
  if (created) writeAll(items);
  return { created, skipped };
}

/** 测试/诊断：清空存储。 */
export function resetInteractions() {
  writeAll([]);
  return { ok: true };
}
