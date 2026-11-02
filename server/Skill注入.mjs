/**
 * Skill 注入格式与预算（H2-4）
 * 纯函数，便于单测；agent.mjs 的 skills_read 调用本模块。
 */
import crypto from "node:crypto";
import { previewText } from "./工具结果外置.mjs";

export const DEFAULT_SKILL_MAX_BYTES = 20 * 1024;

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

/* ===== 常用技能优先（远程 2026-10-30 线，实现补齐）=====
   远程 agent.mjs 已按下列契约调用，但实现未随仓库提交（干净克隆会因
   "does not provide an export" 直接启服失败）。这里按 changelog 口径补齐纯函数。 */

/** 冷启动默认优先级：docx / pptx / xlsx / lark-* / frontend-design（与实际目录求交集）。 */
const COLD_START_PRIORITY = [/^docx$/i, /^pptx$/i, /^xlsx$/i, /^lark-/i, /^frontend-design$/i];

/** 清洗计数表：只保留非空名称与正整数计数，丢弃损坏/负数/字符串脏值。 */
export function normalizeSkillUsage(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || "").trim();
    if (!name) continue;
    const count = Math.floor(Number(value));
    if (Number.isFinite(count) && count > 0) out[name] = count;
  }
  return out;
}

/** 技能读取计数 +1（返回新对象，不修改入参）。 */
export function bumpSkillUsage(usage = {}, name = "") {
  const next = normalizeSkillUsage(usage);
  const key = String(name || "").trim();
  if (!key) return next;
  next[key] = (next[key] || 0) + 1;
  return next;
}

/** 频次降序 → 名称升序；无频次时保持原顺序的稳定排序。 */
export function rankSkillsByUsage(skills = [], usage = {}) {
  const counts = normalizeSkillUsage(usage);
  return [...(Array.isArray(skills) ? skills : [])]
    .map((skill, index) => ({ skill, index }))
    .sort((a, b) => {
      const delta = (counts[String(b.skill?.name || "").trim()] || 0) - (counts[String(a.skill?.name || "").trim()] || 0);
      if (delta) return delta;
      const byName = String(a.skill?.name || "").localeCompare(String(b.skill?.name || ""), "zh-Hans-CN");
      return byName || a.index - b.index;
    })
    .map((item) => item.skill);
}

/** 频次取前 N；冷启动（无任何频次）回退默认优先级与实际目录的交集。 */
export function pickTopSkills(catalog = [], usage = {}, limit = 8) {
  const list = Array.isArray(catalog) ? catalog.filter((skill) => skill && String(skill.name || "").trim()) : [];
  if (!list.length) return [];
  const max = Math.max(1, Math.floor(Number(limit)) || 8);
  const counts = normalizeSkillUsage(usage);
  const used = list.filter((skill) => (counts[String(skill.name).trim()] || 0) > 0);
  if (used.length) return rankSkillsByUsage(used, counts).slice(0, max);
  return list.filter((skill) => COLD_START_PRIORITY.some((pattern) => pattern.test(String(skill.name).trim()))).slice(0, max);
}
