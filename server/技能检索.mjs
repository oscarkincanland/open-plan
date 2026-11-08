/**
 * 技能检索打分（2026-11-08，D0-2）
 *
 * 纯函数模块：输入技能目录 + 用户查询，输出带命中理由的排序结果。
 * 替代 `server/agent.mjs` 里原来的“空格切词 + 每词都必须命中 name+description”的 AND 词面匹配。
 *
 * 打分（单 token 取最高档）：
 *   100  名称/别名完全相等
 *   40   名称/别名包含查询词（或查询词包含名称）
 *   10   描述包含查询词
 * 汇总后再加：
 *   +20  所有 token 都有命中（鼓励“更完整命中”）
 *   +命中 token 数 × 2（小幅鼓励多词命中）
 * 排序：分数降序 → 使用频次降序 → 名称升序。
 */
import { expandQuery, normalizeQueryText } from "./技能别名.mjs";

/** 名称/别名归一化数组。 */
function skillNames(skill) {
  const entries = [skill?.name, ...(Array.isArray(skill?.aliases) ? skill.aliases : [])]
    .map((item) => normalizeQueryText(item))
    .filter(Boolean);
  return [...new Set(entries)];
}

/**
 * 给单个技能打分。
 * @returns {{score:number, matched:string[], missed:string[], reasons:string[]}|null} null = 完全未命中
 */
export function scoreSkill(skill, expanded = []) {
  if (!Array.isArray(expanded) || !expanded.length) return null;
  const names = skillNames(skill);
  const nameText = names.join(" ");
  const description = normalizeQueryText(skill?.description || "");
  const reasons = [];
  const matched = [];
  const missed = [];
  let total = 0;

  for (const { token, variants } of expanded) {
    let best = 0;
    let bestReason = "";
    for (const variant of variants) {
      if (!variant) continue;
      if (names.includes(variant)) {
        if (best < 100) { best = 100; bestReason = `名称命中：${variant}`; }
        continue;
      }
      if (nameText.includes(variant)) {
        if (best < 40) { best = 40; bestReason = `名称包含：${variant}`; }
        continue;
      }
      if (description.includes(variant)) {
        if (best < 10) { best = 10; bestReason = `描述命中：${variant}`; }
        continue;
      }
      // 反向包含：查询词是名称的一部分（如查询“ppt制作”，名称含 ppt）
      if (variant.length >= 2 && names.some((name) => name.length >= 2 && variant.includes(name))) {
        if (best < 40) { best = 40; bestReason = `名称包含：${name}`; }
      }
    }
    if (best > 0) {
      total += best;
      matched.push(token);
      if (bestReason && !reasons.includes(bestReason)) reasons.push(bestReason);
    } else {
      missed.push(token);
    }
  }

  if (!matched.length) return null;
  if (!missed.length) total += 20;
  total += matched.length * 2;
  return { score: total, matched, missed, reasons: reasons.slice(0, 3) };
}

/**
 * 检索技能。
 * @param {Array<{name:string, description?:string, aliases?:string[]}>} skills
 * @param {string} query
 * @param {{limit?:number, usage?:Record<string,number>}} [options]
 * @returns {Array<object & {score:number, matchReason:string, hitTerms:string[]}>}
 */
export function searchSkills(skills = [], query = "", { limit = 12, usage = {} } = {}) {
  const expanded = expandQuery(query);
  const max = Math.max(1, Math.min(30, Number(limit) || 12));
  if (!expanded.length) return [];
  const hits = [];
  for (const skill of skills) {
    const result = scoreSkill(skill, expanded);
    if (!result) continue;
    hits.push({
      ...skill,
      score: result.score,
      matchReason: result.reasons.join("；") || "关键词命中",
      hitTerms: result.matched,
      _usage: Number(usage?.[skill?.name] || 0),
    });
  }
  hits.sort((left, right) =>
    right.score - left.score
    || right._usage - left._usage
    || String(left.name || "").localeCompare(String(right.name || "")),
  );
  return hits.slice(0, max).map(({ _usage, ...rest }) => rest);
}

/** 空查询时的排序：按使用频次降序、名称升序（保持既有行为）。 */
export function rankSkills(skills = [], usage = {}, limit = 12) {
  const max = Math.max(1, Math.min(30, Number(limit) || 12));
  return [...skills]
    .sort((left, right) =>
      Number(usage?.[right?.name] || 0) - Number(usage?.[left?.name] || 0)
      || String(left?.name || "").localeCompare(String(right?.name || "")),
    )
    .slice(0, max);
}
