/**
 * 任务复杂度估计（2026-11-03 / 计划 006 阶段 D）。
 *
 * 只用于选择「默认技能清单」还是「技能发现钩子」，不参与权限与工具白名单。
 * 目标是保守：单文件读取/单篇短文档默认 simple；多份材料、批量、工作流、
 * 审查、地图/图表组合才升级为 complex。
 */
export const COMPLEXITY_THRESHOLD = 3;

const COMPLEX_WORDS = /(多份|批量|完整|全流程|方案|研究|对比|汇总|综合|报告|规划|可研|工可|初设|汇报材料)/i;
const OUTPUT_WORDS = /(文档|报告|word|docx|excel|xlsx|ppt|pptx|演示|图表|地图|geojson|热力图|等时圈|od图|表格|pdf)/i;
const SKILL_REF = /[@#]技能\[[^\]]+\]/i;

export function estimateTaskComplexity({ text = "", task = {}, references = [], attachments = [] } = {}) {
  const source = `${text || ""} ${task?.goal || ""} ${task?.longTermGoal?.text || ""}`.trim();
  const reasons = [];
  let score = 0;
  const add = (points, reason) => { score += points; reasons.push(reason); };

  if (OUTPUT_WORDS.test(source)) add(2, "有明确产出物");
  if (COMPLEX_WORDS.test(source)) add(1, "出现复杂任务关键词");

  const attachmentCount = Math.min(2, Array.isArray(attachments) ? attachments.length : 0);
  if (attachmentCount) add(attachmentCount, `附件 ${attachmentCount} 个`);

  const referenceCount = Math.min(2, Array.isArray(references) ? references.length : 0);
  if (referenceCount) add(referenceCount, `引用 ${referenceCount} 项`);

  if (task?.workflowId) add(2, "指定了工作流");
  if (SKILL_REF.test(source)) add(1, "显式指定技能");
  if (String(task?.mode || "") === "review") add(1, "Review 审查任务");

  const level = score >= COMPLEXITY_THRESHOLD ? "complex" : "simple";
  return { level, score, threshold: COMPLEXITY_THRESHOLD, reasons };
}

export function resolveSkillsRouting({ complexity, task = {}, text = "" } = {}) {
  const settings = task?.projectSettings || {};
  const policy = ["auto", "always", "off"].includes(settings.skillsPolicy) ? settings.skillsPolicy : "auto";
  const explicit = Boolean(task?.workflowId) || SKILL_REF.test(String(text || ""));
  if (explicit) return "preflight";
  if (policy === "off") return "off";
  if (policy === "always") return "discover";
  return complexity?.level === "complex" ? "discover" : "default";
}

export function resolveSkillDraftRouting({ complexity, task = {} } = {}) {
  const allow = String(task?.projectSettings?.allowSkillDrafts || "off") === "complex";
  return allow && complexity?.level === "complex" ? "enabled" : "off";
}
