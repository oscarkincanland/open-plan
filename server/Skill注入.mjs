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
  // 2026-11-08 D0-4：预算不足时先保证“所有技能名至少出现一次”，再补描述。
  // 旧实现按排名逐条丢弃，导致 11/66 个技能（含 powerpoint）整条消失。
  const describe = (skill) => {
    const name = String(skill?.name || "").trim();
    if (!name) return null;
    const scope = skill?.sourceScope === "workspace" ? "workspace" : skill?.sourceScope === "project" ? "project" : "user";
    const description = String(skill?.description || "").replace(/\s+/g, " ").trim();
    const clipped = description.length > maxDescription ? `${description.slice(0, maxDescription)}…` : description;
    return `- \`${name}\` [${scope}]${clipped ? `：${clipped}` : ""}`;
  };
  const nameOnlyLine = (skill) => {
    const name = String(skill?.name || "").trim();
    if (!name) return null;
    const scope = skill?.sourceScope === "workspace" ? "workspace" : skill?.sourceScope === "project" ? "project" : "user";
    return `- \`${name}\` [${scope}]`;
  };
  const entries = ranked.map((skill) => ({ skill, full: describe(skill), short: nameOnlyLine(skill) })).filter((entry) => entry.full);
  const selected = new Array(entries.length).fill(null);
  let bytes = Buffer.byteLength(`${header}\n${footer}`, "utf8");
  let truncated = false;
  // 第一遍：先保证“所有技能名至少出现一次”（name-only），这是可发现性的底线。
  const nameCosts = entries.map((entry) => Buffer.byteLength(`\n${entry.short}`, "utf8"));
  for (let index = 0; index < entries.length; index += 1) {
    if (bytes + nameCosts[index] > limit) { truncated = true; continue; }
    selected[index] = entries[index].short;
    bytes += nameCosts[index];
  }
  // 第二遍：用剩余预算把 name-only 逐条升级为“名称 + 描述”，直到预算用尽。
  let nameOnlyCount = selected.filter((line) => line !== null).length;
  for (let index = 0; index < entries.length; index += 1) {
    if (!selected[index]) continue;
    const extra = Buffer.byteLength(`\n${entries[index].full}`, "utf8") - nameCosts[index];
    if (extra <= 0) { selected[index] = entries[index].full; nameOnlyCount -= 1; continue; }
    if (bytes + extra > limit) continue;
    selected[index] = entries[index].full;
    bytes += extra;
    nameOnlyCount -= 1;
  }
  if (nameOnlyCount > 0 || selected.some((line) => line === null)) truncated = true;
  const lines = selected.filter(Boolean);
  const text = `${header}\n${lines.join("\n")}${lines.length ? "\n" : ""}${footer}`;
  return {
    text,
    count: ranked.length,
    included: lines.length,
    nameOnlyCount,
    truncated,
    bytes: Buffer.byteLength(text, "utf8"),
  };
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

/** skills_read 单次全文上限（2026-11-08 D0-3）：≥此值才降级为“结构目录 + 分段提示”。 */
export const DEFAULT_SKILL_READ_MAX_CHARS = 64 * 1024;

/**
 * 构造 skills_read 的返回内容。
 *
 * PPT master 的 SKILL.md 约 26KB/440 行，旧实现按 16000 字符（头 72% + 尾 28%）
 * 截断，正好切掉 Step 2–6，模型拿到半份说明书。现在 ≤64KB 一律全文返回；
 * 超过时才给“名称 + 章节目录 + 头部摘要 + 分段读取提示”。
 */
export function buildSkillReadPayload({ name = "", raw = "", maxChars = DEFAULT_SKILL_READ_MAX_CHARS } = {}) {
  const text = String(raw || "");
  const limit = Math.max(2000, Number(maxChars) || DEFAULT_SKILL_READ_MAX_CHARS);
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  const fullBytes = Buffer.byteLength(text, "utf8");
  const header = `# ${String(name)}\n\n`;
  if (text.length <= limit) {
    return {
      text: `${header}${text}`,
      truncated: false,
      outline: [],
      chars: text.length,
      bytes: fullBytes,
      fullBytes,
      hash,
    };
  }
  const outline = text
    .split(/\r?\n/)
    .filter((line) => /^#{1,3} \S/.test(line))
    .slice(0, 60);
  const head = text.slice(0, limit);
  const note = [
    "",
    `...[SKILL.md 共 ${text.length} 字符（${fullBytes} 字节），超过单次读取上限 ${limit} 字符。`,
    "以下先给出章节目录与前半部分；剩余内容请用 read 工具读取该技能目录下的 SKILL.md 分段获取，不要根据摘要脑补步骤。]...",
    "",
  ].join("\n");
  return {
    text: `${header}## SKILL.md 章节目录\n${outline.length ? outline.join("\n") : "（未检测到 Markdown 标题）"}\n${note}\n${head}`,
    truncated: true,
    outline,
    chars: text.length,
    bytes: Buffer.byteLength(head, "utf8"),
    fullBytes,
    hash,
  };
}

