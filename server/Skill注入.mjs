/**
 * Skill 注入格式与预算（H2-4）
 * 纯函数，便于单测；agent.mjs 的 skills_read 调用本模块。
 */
import crypto from "node:crypto";
import { previewText } from "./工具结果外置.mjs";

export const DEFAULT_SKILL_MAX_BYTES = 20 * 1024;

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

/**
 * 每轮注入的技能目录（2026-11-04 去硬编码）。
 *
 * 不按“简单/复杂任务”裁剪，也不固定 top-8；按
 *   workspace > project > user，再按使用频次/名称排序
 * 生成 name + 截断 description 的清单。预算用完后降级为“只给名称”，
 * 保证模型仍知道技能存在，但不会为了目录挤爆上下文。
 */
export const DEFAULT_SKILL_CATALOG_BUDGET = 8 * 1024;

export function buildSkillCatalog({
  skills = [],
  usage = {},
  budgetBytes = DEFAULT_SKILL_CATALOG_BUDGET,
  maxDescription = 120,
} = {}) {
  const counts = normalizeSkillUsage(usage);
  const scopeRank = { workspace: 0, project: 1, user: 2 };
  const ranked = [...(skills || [])].sort((left, right) => {
    const scope = (scopeRank[left?.sourceScope] ?? 3) - (scopeRank[right?.sourceScope] ?? 3);
    if (scope) return scope;
    const frequent = (counts[right?.name] || 0) - (counts[left?.name] || 0);
    if (frequent) return frequent;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
  const limit = Math.max(256, Number(budgetBytes) || DEFAULT_SKILL_CATALOG_BUDGET);
  const header = [
    "<available_skills>",
    "以下是当前可用技能目录（workspace/project 优先；目录可能因预算被截断）：",
  ].join("\n");
  const footer = [
    "使用规则：用户点名技能，或任务明显匹配某条 description 时，先调用 skills_read(name) 读取全文再动手；",
    "目录被截断或不确定技能是否存在时，先用 skills_search 搜索；不要根据摘要脑补技能正文。",
    "</available_skills>",
  ].join("\n");
  const lines = [];
  let bytes = Buffer.byteLength(`${header}\n${footer}`, "utf8");
  let truncated = false;
  let included = 0;
  for (const skill of ranked) {
    const name = String(skill?.name || "").trim();
    if (!name) continue;
    const scope = skill?.sourceScope === "workspace" ? "workspace" : skill?.sourceScope === "project" ? "project" : "user";
    const description = String(skill?.description || "").replace(/\s+/g, " ").trim();
    const clipped = description.length > maxDescription ? `${description.slice(0, maxDescription)}…` : description;
    const full = `- \`${name}\` [${scope}]${clipped ? `：${clipped}` : ""}`;
    const nameOnly = `- \`${name}\` [${scope}]`;
    const line = bytes + Buffer.byteLength(`\n${full}`, "utf8") <= limit ? full : nameOnly;
    if (bytes + Buffer.byteLength(`\n${line}`, "utf8") > limit) { truncated = true; break; }
    lines.push(line);
    bytes += Buffer.byteLength(`\n${line}`, "utf8");
    included += 1;
  }
  if (included < ranked.length) truncated = true;
  const text = `${header}\n${lines.join("\n")}${lines.length ? "\n" : ""}${footer}`;
  return { text, count: ranked.length, included, truncated, bytes: Buffer.byteLength(text, "utf8") };
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
