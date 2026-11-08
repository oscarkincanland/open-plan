/**
 * 写作路由技能目录裁剪（2026-11-08，D5；计划 2026-11-08-001 §6.1 D5）
 *
 * 写作路由每轮注入 8KB 全量技能目录对写作几乎无用（实测 66 个技能、约 8KB/轮）。
 * 这里用一个保守的关键词筛选，只保留写作/文档/排版/图表/审查相关技能，减少每轮上下文。
 * 纯函数，便于测试；不足 3 个命中时回退全量，避免把有用的技能裁掉。
 */

export const WRITING_SKILL_RE = /(写作|撰写|文档|报告|公文|排版|校对|审校|润色|改写|摘要|大纲|模板|编辑|word|docx|excel|xlsx|ppt|pptx|slide|deck|图表|chart|humaniz|doc-|office|report|writing)/i;

export const DEFAULT_WRITING_SKILL_LIMIT = 12;

/**
 * @param {Array<{name:string, description?:string, sourceScope?:string}>} skills
 * @param {{limit?:number, minHit?:number}} [options]
 * @returns {{skills:Array, filtered:boolean, matched:number}}
 */
export function selectWritingSkills(skills = [], { limit = DEFAULT_WRITING_SKILL_LIMIT, minHit = 3 } = {}) {
  const list = Array.isArray(skills) ? skills : [];
  const matched = list.filter((item) => WRITING_SKILL_RE.test(`${item?.name || ""} ${item?.description || ""}`));
  if (matched.length < Math.max(1, Number(minHit) || 3)) {
    return { skills: list, filtered: false, matched: matched.length };
  }
  const max = Math.max(1, Math.min(30, Number(limit) || DEFAULT_WRITING_SKILL_LIMIT));
  return { skills: matched.slice(0, max), filtered: true, matched: matched.length };
}
