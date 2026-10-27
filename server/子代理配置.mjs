/**
 * 子代理 profile 快照（H3-2）
 * 纯函数：派发时冻结角色/工具/模型/预算；后续只能通过新事件变更，不静默改写。
 */

export function buildSubagentProfile({ childId = null, role = "scout", roleSpec = {}, model = null, budget = {}, frozenAt = null } = {}) {
  const spec = roleSpec && typeof roleSpec === "object" ? roleSpec : {};
  return {
    childId,
    role: String(role || "scout"),
    roleLabel: spec.label || String(role || "scout"),
    readOnly: spec.readOnly !== false,
    tools: Array.isArray(spec.tools) ? [...spec.tools] : [],
    model: model || null,
    budget: {
      timeoutMs: Number(budget.timeoutMs ?? spec.timeoutMs ?? 0) || null,
      maxTurns: Number(budget.maxTurns ?? 0) || null,
    },
    frozenAt: frozenAt || new Date().toISOString(),
  };
}

export function validateSubagentProfile(profile = {}) {
  const errors = [];
  if (!profile || typeof profile !== "object") return { ok: false, errors: ["profile 缺失"] };
  if (!profile.role) errors.push("缺少 role");
  if (!Array.isArray(profile.tools)) errors.push("缺少 tools");
  if (profile.readOnly !== true && profile.readOnly !== false) errors.push("缺少 readOnly");
  if (!profile.frozenAt) errors.push("缺少 frozenAt");
  return { ok: errors.length === 0, errors };
}

/** 判断变更是否需要显式事件（任何影响执行语义的字段变化）。 */
export function profileDiff(previous, next) {
  const fields = ["role", "readOnly", "model", "tools", "budget"];
  const changes = [];
  for (const field of fields) {
    if (JSON.stringify(previous?.[field]) !== JSON.stringify(next?.[field])) changes.push(field);
  }
  return changes;
}
