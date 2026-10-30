/**
 * 上下文分段契约（H2-3）
 *
 * 目标：把每轮 prompt 的拼接从“散落在 agent.mjs 的字符串加法”收敛为固定段落：
 *   1 内核基础提示词（只读，不归本模块）
 *   2 工作区准则（AGENTS.md）
 *   3 工具使用规则（按模式裁剪）
 *   4 动态上下文（工作区/当前文件/记忆）
 *   5 任务摘要 + 引用摘要
 *   6 恢复的用户回答
 *   7 用户本轮输入
 *
 * 每段标注 injectionTarget（system/prompt）、cacheHint（stable/dynamic）、budgetChars。
 * 本模块只做纯函数组装，不读文件、不改内核。
 */
import { previewText } from "./工具结果外置.mjs";

export const SECTION_ORDER = Object.freeze([
  "kernel",
  "workspace-rules",
  "tool-rules",
  "dynamic-context",
  "task-references",
  "recovered-answers",
  "user-input",
]);

const DEFAULTS = Object.freeze({
  kernel: { label: "内核基础提示词", target: "system", cacheHint: "stable", budgetChars: 0 },
  "workspace-rules": { label: "工作区准则", target: "system", cacheHint: "stable", budgetChars: 4000 },
  "tool-rules": { label: "工具使用规则", target: "system", cacheHint: "stable", budgetChars: 6000 },
  "dynamic-context": { label: "动态上下文", target: "prompt", cacheHint: "dynamic", budgetChars: 6000 },
  "task-references": { label: "任务与引用", target: "prompt", cacheHint: "dynamic", budgetChars: 3000 },
  "recovered-answers": { label: "恢复的用户回答", target: "prompt", cacheHint: "dynamic", budgetChars: 2000 },
  "user-input": { label: "用户本轮输入", target: "prompt", cacheHint: "dynamic", budgetChars: 20000 },
});

function section(id, content = "", overrides = {}) {
  const spec = DEFAULTS[id];
  const budget = Math.max(0, Number(overrides.budgetChars ?? spec.budgetChars) || 0);
  const raw = String(content || "");
  const text = budget > 0 ? previewText(raw, budget, "head") : raw;
  return {
    id,
    label: spec.label,
    target: overrides.target || spec.target,
    cacheHint: overrides.cacheHint || spec.cacheHint,
    budgetChars: budget,
    content: text.trim(),
    truncated: Boolean(budget > 0 && Buffer.byteLength(raw, "utf8") > Buffer.byteLength(text, "utf8")),
  };
}

/**
 * 构建段落数组。kernel 段只占位，内容由 Pi 内核提供。
 */
export function buildContextSections({
  workspaceRules = "",
  toolRules = "",
  dynamicContext = "",
  taskSummary = "",
  referencesSummary = "",
  recoveredAnswers = [],
  userText = "",
} = {}) {
  const recovered = Array.isArray(recoveredAnswers) && recoveredAnswers.length
    ? `## 恢复的用户回答\n${recoveredAnswers.map((item) => `- ${item.question}: ${item.answer}`).join("\n")}\n请把这些回答视为对上次中断提问的确认，并继续原任务。`
    : "";
  const taskAndRefs = [String(taskSummary || "").trim(), String(referencesSummary || "").trim()].filter(Boolean).join("\n\n");
  return [
    section("kernel", "", { budgetChars: 0 }),
    section("workspace-rules", workspaceRules),
    section("tool-rules", toolRules),
    section("dynamic-context", dynamicContext),
    section("task-references", taskAndRefs),
    section("recovered-answers", recovered),
    section("user-input", userText),
  ];
}

/** 只拼接非空段落；kernel 段不参与拼接。 */
export function renderContextSections(sections = []) {
  return sections
    .filter((item) => item && item.id !== "kernel" && String(item.content || "").trim())
    .map((item) => String(item.content).trim())
    .join("\n\n");
}

/** 校验顺序与预算；返回缺失/越界/顺序错误。 */
export function validateContextSections(sections = []) {
  const ids = sections.map((item) => item?.id);
  const expected = SECTION_ORDER.filter((id) => ids.includes(id));
  const orderOk = JSON.stringify(ids) === JSON.stringify(expected);
  const errors = [];
  if (!orderOk) errors.push(`段落顺序错误：${ids.join(" → ")}`);
  for (const item of sections) {
    if (!item || !SECTION_ORDER.includes(item.id)) { errors.push(`未知段落：${item?.id}`); continue; }
    const spec = DEFAULTS[item.id];
    if (!item.target) errors.push(`${item.id}: 缺少 injectionTarget`);
    if (!item.cacheHint) errors.push(`${item.id}: 缺少 cacheHint`);
    if (Number(item.budgetChars) < 0) errors.push(`${item.id}: budgetChars 不能为负`);
    if (item.id !== "kernel" && spec.budgetChars > 0 && Buffer.byteLength(String(item.content || ""), "utf8") > spec.budgetChars * 4) {
      // budgetChars 是字符预算；这里只做粗略越界提示，精确截断由 section() 负责。
      errors.push(`${item.id}: 内容可能超出预算`);
    }
  }
  return { ok: errors.length === 0, errors, order: ids };
}

export function sectionSummary(sections = []) {
  return sections.map((item) => ({
    id: item.id,
    target: item.target,
    cacheHint: item.cacheHint,
    budgetChars: item.budgetChars,
    bytes: Buffer.byteLength(String(item.content || ""), "utf8"),
    truncated: Boolean(item.truncated),
  }));
}
