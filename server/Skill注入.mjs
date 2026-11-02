/**
 * Skill 注入格式与预算（H2-4）
 * 纯函数，便于单测；agent.mjs 的 skills_read 调用本模块。
 */
import crypto from "node:crypto";
import { previewText } from "./工具结果外置.mjs";

export const DEFAULT_SKILL_MAX_BYTES = 20 * 1024;

// 常用技能短清单（H2-4 扩展）：按真实使用频次排序，提示词只注入最常用的少数几个，
// 不做全目录注入。冷启动（无使用记录）时回退到默认优先级 ∩ 实际目录。
export const TOP_SKILLS_IN_PROMPT = 8;
export const DEFAULT_SKILL_PRIORITIES = Object.freeze([
  "docx", "pptx", "xlsx", "lark-doc", "lark-sheets", "lark-base", "lark-im", "frontend-design",
]);

/** 清洗持久化的使用计数：仅保留正整数计数，键截断防膨胀。 */
export function normalizeSkillUsage(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const count = Number(value);
      if (key && Number.isFinite(count) && count > 0) out[String(key).slice(0, 128)] = Math.floor(count);
    }
  }
  return out;
}

/** 纯函数：返回计数 +1 后的新映射，不修改入参。 */
export function bumpSkillUsage(usage, name) {
  const key = String(name || "").trim();
  if (!key) return { ...(usage || {}) };
  const next = { ...(usage || {}) };
  next[key] = (Number(next[key]) || 0) + 1;
  return next;
}

/** 排序：使用次数降序，次数相同按名称升序（稳定、可复现）。 */
export function rankSkillsByUsage(skills, usage) {
  const counts = normalizeSkillUsage(usage);
  return [...(skills || [])].sort(
    (a, b) => (counts[b.name] || 0) - (counts[a.name] || 0) || String(a.name).localeCompare(String(b.name)),
  );
}

/** 挑选提示词短清单：优先真实使用频次；冷启动回退默认优先级 ∩ 目录。 */
export function pickTopSkills(skills, usage, { limit = TOP_SKILLS_IN_PROMPT, defaults = DEFAULT_SKILL_PRIORITIES } = {}) {
  const max = Math.max(1, Number(limit) || TOP_SKILLS_IN_PROMPT);
  const counts = normalizeSkillUsage(usage);
  const used = rankSkillsByUsage(skills || [], counts).filter((skill) => (counts[skill.name] || 0) > 0).slice(0, max);
  if (used.length) return used;
  const byName = new Map((skills || []).map((skill) => [skill.name, skill]));
  return (defaults || []).map((name) => byName.get(name)).filter(Boolean).slice(0, max);
}

export function buildSkillInjection({ name = "", raw = "", maxBytes = DEFAULT_SKILL_MAX_BYTES, source = "" } = {}) {
  const text = String(raw || "");
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_SKILL_MAX_BYTES);
  const content = previewText(text, limit, "head");
  const truncated = Buffer.byteLength(content, "utf8") < Buffer.byteLength(text, "utf8");
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  return {
    text: `<skill_content name="${String(name)}" hash="${hash}"${truncated ? ' truncated="true"' : ""}>\n${content}\n</skill_content>`,
    hash,
    truncated,
    bytes: Buffer.byteLength(content, "utf8"),
    fullBytes: Buffer.byteLength(text, "utf8"),
    source: source || null,
  };
}


