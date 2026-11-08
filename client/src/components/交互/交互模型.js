/**
 * 人机协作中枢前端模型（2026-11-08，D2；计划 2026-11-08-001 §11、ADR-0026）
 *
 * 纯函数：只做排序 / 文案 / 倒计时 / 事件合并，不发起请求、不依赖 React。
 * 服务端 `/api/interactions` 与 `interaction_*` 事件是唯一事实源，这里只做投影。
 */

/** 交互类型文案（DESIGN §6.4：标题随语义变化，不再一律写"需要你确认"）。 */
export const KIND_LABELS = Object.freeze({
  clarify: "需要你补充",
  confirm: "请确认",
  review: "草稿已就绪",
  approval: "需要审批",
});

/** 优先级：approval 30 > confirm 20 > clarify 10 > review 5（与服务端一致）。 */
export const KIND_PRIORITY = Object.freeze({
  approval: 30,
  confirm: 20,
  clarify: 10,
  review: 5,
});

/** 类型 → 既有语义图标名（Icon.jsx 已注册，不新增字形）。 */
export const KIND_ICONS = Object.freeze({
  clarify: "comment",
  confirm: "warning",
  review: "eye",
  approval: "shield",
});

/** 状态文案。 */
export const STATUS_LABELS = Object.freeze({
  open: "待处理",
  editing: "填写中",
  submitting: "提交中",
  settled: "已结算",
  expired: "已超时",
  cancelled: "已取消",
});

/** 结算原因文案：已决交互回执用。 */
export const SETTLED_REASON_LABELS = Object.freeze({
  answered: "已回答",
  skipped: "已跳过",
  assumed: "已按假设继续",
  denied: "已拒绝",
  cancelled: "已取消",
  expired: "已超时",
});

/** 倒计时只在最后 5 分钟出现（DESIGN §6.4 / §7，不做常驻噪声）。 */
export const COUNTDOWN_WINDOW_MS = 5 * 60 * 1000;

/** 交互坞最多摘要条数（DESIGN §7：最多 3 条）。 */
export const DOCK_LIMIT = 3;

/** 活动状态（其余视为已决，折叠为回执）。 */
export const ACTIVE_STATUSES = Object.freeze(["open", "editing", "submitting"]);

const ACTIVE_SET = new Set(ACTIVE_STATUSES);
const SETTLED_REASONS = new Set(Object.keys(SETTLED_REASON_LABELS));

/** 类型文案；未知类型按 clarify 处理。 */
export function kindLabel(kind = "") {
  return KIND_LABELS[String(kind || "")] || KIND_LABELS.clarify;
}

/** 类型优先级；未知类型按 clarify 处理。 */
export function priorityOf(kind = "") {
  return KIND_PRIORITY[String(kind || "")] || KIND_PRIORITY.clarify;
}

/** 是否活动交互（未结算/未超时/未取消）。 */
export function isActiveInteraction(interaction) {
  return Boolean(interaction) && ACTIVE_SET.has(String(interaction.status || "open"));
}

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

/**
 * 把服务端 `/api/interactions` 快照或事件载荷统一成前端交互项。
 * 服务端字段：{ interactionId, kind, status, payload:{question,options,fields?,previewFile?}, ... }
 * 事件字段：{ interactionId, kind, runId, threadId, expiresAt, priority, assumption?, reason?, answer? }
 */
export function normalizeInteraction(input) {
  const source = input && typeof input === "object" ? input : {};
  const payload = source.payload && typeof source.payload === "object" ? source.payload : {};
  const kind = String(source.kind || "") || "clarify";
  const status = String(source.status || "open");
  const fields = list(payload.fields ?? source.fields).map((field) => ({
    id: String(field?.id || ""),
    label: String(field?.label || field?.id || ""),
    type: ["text", "select", "radio", "checkbox", "file"].includes(field?.type) ? field.type : "text",
    required: Boolean(field?.required),
    options: list(field?.options).map(String),
    placeholder: String(field?.placeholder || ""),
    ...(field?.accept ? { accept: String(field.accept) } : {}),
  })).filter((field) => field.id && field.label);
  const settledReason = String(source.settledReason || source.reason || "");
  return {
    interactionId: String(source.interactionId || source.id || ""),
    kind,
    status,
    priority: Number(source.priority) || priorityOf(kind),
    runId: source.runId ? String(source.runId) : "",
    threadId: source.threadId ? String(source.threadId) : "",
    question: text(payload.question ?? source.question),
    options: list(payload.options ?? source.options).map(String),
    fields,
    previewFile: String(payload.previewFile || source.previewFile || ""),
    assumption: String(source.assumption || ""),
    owner: source.owner && typeof source.owner === "object" ? source.owner : null,
    answer: source.answer === null || source.answer === undefined ? "" : String(source.answer),
    values: source.values && typeof source.values === "object" ? source.values : null,
    settledReason: SETTLED_REASONS.has(settledReason) ? settledReason : "",
    createdAt: parseTime(source.createdAt),
    updatedAt: parseTime(source.updatedAt),
    settledAt: parseTime(source.settledAt),
    expiresAt: parseTime(source.expiresAt),
  };
}

/** 批量归一化。 */
export function normalizeInteractions(items) {
  return list(items).map(normalizeInteraction).filter((item) => item.interactionId);
}

/** 稳定排序：priority 降序 → createdAt 升序 → interactionId。 */
export function sortInteractions(items) {
  return list(items).slice().sort((left, right) => (
    (priorityOf(right.kind) || 0) - (priorityOf(left.kind) || 0)
    || (left.createdAt || 0) - (right.createdAt || 0)
    || String(left.interactionId).localeCompare(String(right.interactionId))
  ));
}

/** 按 interactionId 去重合并；后到的非空字段覆盖先到的。 */
export function dedupeInteractions(items) {
  const merged = new Map();
  for (const raw of list(items)) {
    const next = normalizeInteraction(raw);
    if (!next.interactionId) continue;
    const existing = merged.get(next.interactionId);
    if (!existing) {
      merged.set(next.interactionId, next);
      continue;
    }
    merged.set(next.interactionId, {
      ...existing,
      ...next,
      question: next.question || existing.question,
      options: next.options.length ? next.options : existing.options,
      fields: next.fields.length ? next.fields : existing.fields,
      previewFile: next.previewFile || existing.previewFile,
      assumption: next.assumption || existing.assumption,
      threadId: next.threadId || existing.threadId,
      runId: next.runId || existing.runId,
      createdAt: next.createdAt || existing.createdAt,
      expiresAt: next.expiresAt || existing.expiresAt,
      owner: next.owner || existing.owner,
    });
  }
  return Array.from(merged.values());
}

/**
 * SSE `interaction_*` 事件 → 交互列表。
 * - open：新增/合并（事件不带 payload 时保留本地已拉到的载荷）；
 * - settled/expired：改为已决状态并写入回执字段（是否保留由调用方决定）；
 * - assumption：只更新假设文本。
 */
export function mergeInteractionEvent(items = [], event = {}) {
  const type = String(event?.type || "");
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const interactionId = String(data.interactionId || "");
  if (!interactionId) return list(items);
  const current = dedupeInteractions(items);
  const existing = current.find((item) => item.interactionId === interactionId) || null;
  if (type === "interaction_open") {
    const next = normalizeInteraction({ ...existing, ...data, status: data.status || existing?.status || "open", payload: data.payload || existing?.payload });
    if (!existing) return [...current, next];
    return current.map((item) => (item.interactionId === interactionId ? { ...item, ...next } : item));
  }
  if (type === "interaction_settled") {
    const reason = SETTLED_REASONS.has(String(data.reason || "")) ? String(data.reason) : "answered";
    return current.map((item) => (item.interactionId === interactionId
      ? {
        ...item,
        status: reason === "cancelled" ? "cancelled" : "settled",
        settledReason: reason,
        answer: data.answer !== undefined ? String(data.answer || "") : item.answer,
        assumption: data.assumption !== undefined ? String(data.assumption || "") : item.assumption,
      }
      : item));
  }
  if (type === "interaction_expired") {
    const assumed = Boolean(data.assumed);
    return current.map((item) => (item.interactionId === interactionId
      ? {
        ...item,
        status: assumed ? "settled" : "expired",
        settledReason: assumed ? "assumed" : "expired",
        assumption: data.assumption !== undefined ? String(data.assumption || "") : item.assumption,
      }
      : item));
  }
  if (type === "interaction_assumption") {
    return current.map((item) => (item.interactionId === interactionId
      ? { ...item, assumption: String(data.assumption || "") }
      : item));
  }
  return current;
}

/** 剩余时间（毫秒）；无 expiresAt 返回 Infinity（不显示倒计时）。 */
export function remainingMs(interaction, now = Date.now()) {
  const expiresAt = Number(interaction?.expiresAt || 0);
  if (!expiresAt) return Number.POSITIVE_INFINITY;
  return expiresAt - Number(now || Date.now());
}

/**
 * 倒计时文案：只在最后 5 分钟内返回，否则返回空串。
 * 已超时返回空串（状态文案负责表达"已超时"，避免重复）。
 */
export function countdownText(interaction, now = Date.now()) {
  if (!isActiveInteraction(interaction)) return "";
  const remain = remainingMs(interaction, now);
  if (remain <= 0) return "";
  if (remain > COUNTDOWN_WINDOW_MS) return "";
  const totalSeconds = Math.max(1, Math.floor(remain / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `还剩 ${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 问题摘要；事件先到、载荷未到时给类型兜底文案。 */
export function questionText(interaction) {
  const question = text(interaction?.question);
  if (question) return question;
  const kind = String(interaction?.kind || "");
  if (kind === "review") return "草稿已生成，请预览后确认是否继续";
  if (kind === "approval") return "有工具调用需要审批";
  if (kind === "confirm") return "有一项高风险操作需要你确认";
  return "Agent 需要你补充一个信息";
}

/** 主按钮文案：Dock 点击后定位到消息流中的交互卡片。 */
export function primaryActionLabel(interaction) {
  const kind = String(interaction?.kind || "");
  if (kind === "approval") return "去审批";
  if (kind === "review") return "查看草稿";
  if (kind === "confirm") return "去确认";
  return "去补充";
}

/** 回执：已回答 / 已跳过 / 已按假设继续 / 已超时 / 已拒绝 / 已取消。 */
export function receiptText(interaction) {
  const status = String(interaction?.status || "");
  if (status !== "settled" && status !== "expired" && status !== "cancelled") return "";
  const reason = String(interaction?.settledReason || (status === "expired" ? "expired" : status === "cancelled" ? "cancelled" : "answered"));
  const label = SETTLED_REASON_LABELS[reason] || SETTLED_REASON_LABELS.answered;
  const detail = reason === "assumed"
    ? text(interaction?.assumption)
    : reason === "expired" || reason === "cancelled"
      ? ""
      : text(interaction?.answer);
  if (reason === "expired") return "已超时（未继续）";
  return detail ? `${label}：${detail}` : label;
}

/** Dock 摘要：最多 DOCK_LIMIT 条；返回总数用于"第 n/m 个"。 */
export function dockSummary(interactions, limit = DOCK_LIMIT) {
  const items = sortInteractions(dedupeInteractions(interactions).filter(isActiveInteraction));
  return {
    items: items.slice(0, Math.max(0, Number(limit) || DOCK_LIMIT)),
    total: items.length,
  };
}
