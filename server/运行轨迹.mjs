/**
 * 运行完成语义：把“模型回答结束”与“任务真正完成”区分开。
 *
 * 2026-11-03 起不再有显式完成声明工具（complete_task 已移除）：
 * 完成状态一律由 Run 终态推断，标记 source:"inferred"，不伪装成显式验收成功；
 * 结论文本取模型最终答复（finalText），而不是另起一套声明流程。
 */

export const COMPLETION_STATUSES = Object.freeze(["success", "partial", "blocked", "failed"]);

const STATUS_LABELS = Object.freeze({
  success: "已完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失败",
  cancelled: "已取消",
});

export function completionStatusLabel(status) {
  return STATUS_LABELS[status] || "已结束";
}

/**
 * 客观结果降级：完成结论可以被客观结果下调，但绝不能被上调。
 * - 取消 / 运行失败 → 终态即 cancelled / failed；
 * - 产物验收失败 → success 最多降为 partial，并记录 downgradeReason；
 * 返回新对象（不改入参），无变化时补齐 verificationStatus。
 */
export function applyObjectiveDowngrade(completion, { runStatus = "completed", verificationStatus = "not_checked" } = {}) {
  if (!completion || typeof completion !== "object" || !completion.status) return completion;
  let status = String(completion.status);
  const reasons = [];
  if (runStatus === "cancelled" || runStatus === "aborted") {
    if (status !== "cancelled") { status = "cancelled"; reasons.push(runStatus === "aborted" ? "运行已中断" : "运行已取消"); }
  } else if (runStatus === "failed") {
    if (status !== "failed") { status = "failed"; reasons.push("运行失败"); }
  } else if (verificationStatus === "failed" && status === "success") {
    status = "partial";
    reasons.push("产物验收失败");
  }
  const next = { ...completion, verificationStatus };
  if (status === completion.status) return next;
  return {
    ...next,
    status,
    objectiveStatus: runStatus,
    downgradedFrom: completion.status,
    downgradeReason: reasons.join("；") || "客观结果下调",
  };
}

/**
 * 把模型最终答复洗成一行可读摘要（用于会话列表 / 任务中心标题）。
 * 只做保守清洗：去 Markdown 标题、列表符号与代码围栏，折叠空白，取前 400 字。
 */
export function summarizeFinalText(finalText) {
  const text = String(finalText || "").trim();
  if (!text) return "";
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > 400 ? `${cleaned.slice(0, 400)}…` : cleaned;
}

/**
 * 按 Run 终态推断完成状态。
 * 结论文本优先取模型最终答复（finalText）；没有终稿时回退到通用描述。
 */
export function inferCompletion({ runStatus = "completed", artifacts = 0, validations = [], finalText = "" } = {}) {
  const failedValidation = Array.isArray(validations) && validations.some((item) => item?.status === "failed");
  const finalSummary = summarizeFinalText(finalText);
  let status = "success";
  let summary = "";
  if (runStatus === "cancelled" || runStatus === "aborted") {
    status = "cancelled";
    summary = "任务在完成前被中断";
  } else if (runStatus === "failed") {
    status = "failed";
    summary = "任务执行失败";
  } else if (failedValidation) {
    status = "partial";
    summary = "任务结束，但部分产物未通过校验";
  } else if (finalSummary) {
    summary = finalSummary;
  } else {
    summary = artifacts ? `任务结束，产生 ${artifacts} 项文件变更` : "任务结束，未检测到文件变更";
  }
  return {
    status,
    source: "inferred",
    summary,
    incomplete: [],
    blockers: [],
    verification: failedValidation ? "failed" : null,
    at: new Date().toISOString(),
  };
}
