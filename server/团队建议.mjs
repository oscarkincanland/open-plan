/**
 * 专家团队建议器（2026-11-09，计划 2026-11-09-001 §5.2）
 *
 * 纯函数：根据本轮任务文本/引用/附件/复杂度，判断是否建议使用专家团队。
 * 只做“建议”，不创建团队、不调用模型；是否采用仍由模型决定（决策 D1）。
 *
 * 规则（用户 2026-11-09 拍板）：
 *   - 正向信号命中 ≥ 2 个才建议；
 *   - 显式点名 run_subagent 且未提团队时不建议；
 *   - Chat 模式不建议（没有 team_* 工具）；
 *   - 单文件/单步/短文本无引用不建议。
 */
export const TEAM_SUGGEST_THRESHOLD = 2;
export const TEAM_SUGGEST_MIN_TASKS = 2;

const WRITING_WORDS = /(写|撰写|起草|编制|生成|润色|改写|整理)[^，。；;\\n]{0,8}(报告|材料|文档|汇报|方案|规划|可研|工可|文章|稿子|稿|书|总结)/i;
const REVIEW_WORDS = /(审阅|审查|复核|核验|校对|评审|检查|把关|批注)/i;
const NEGATIVE_TASK = /(读一下|看一下|解释一下|讲一下|是什么|怎么用|单文件|改个|改一下|一句话|随便|闲聊|你好|谢谢)/i;
const MULTI_MATERIAL = /(多份|这几份|这三份|几份材料|批量材料|多篇|若干份)/i;
const MULTI_CHAPTER = /(多章节|分章|逐章|整本|长文|上万字|多页|多章节|章节较多)/i;
const BATCH_REVIEW = /(批量|逐条|全量|逐项|完整检查|通读)/i;

/**
 * @param {object} input
 * @param {string} [input.text] 任务文本
 * @param {string} [input.mode] chat|agent|review
 * @param {string} [input.route] template|edit|generate|read
 * @param {Array} [input.references]
 * @param {Array} [input.attachments]
 * @param {object} [input.complexity] estimateTaskComplexity 结果
 * @param {boolean} [input.hasCurrentFile]
 * @param {number} [input.threshold]
 * @returns {{suggested:boolean, score:number, reasons:string[], signals:string[], minTasks:number, negative:string}}
 */
export function shouldSuggestTeam({
  text = "",
  mode = "agent",
  route = "",
  references = [],
  attachments = [],
  complexity = null,
  hasCurrentFile = false,
  threshold = TEAM_SUGGEST_THRESHOLD,
} = {}) {
  const source = String(text || "");
  const modeName = String(mode || "agent");
  const refCount = (Array.isArray(references) ? references.length : 0) + (Array.isArray(attachments) ? attachments.length : 0);
  const writing = WRITING_WORDS.test(source);
  const review = REVIEW_WORDS.test(source);
  const signals = [];
  const reasons = [];

  const addSignal = (id, reason) => {
    signals.push(id);
    if (reasons.length < 3) reasons.push(reason);
  };

  // 负向：Chat 无团队工具
  if (modeName === "chat") {
    return { suggested: false, score: 0, reasons: [], signals: [], minTasks: TEAM_SUGGEST_MIN_TASKS, negative: "chat_mode" };
  }
  // 负向：显式只要子代理、未提团队
  if (/run_subagent|子代理|子 Agent/i.test(source) && !/团队|team/i.test(source)) {
    return { suggested: false, score: 0, reasons: [], signals: [], minTasks: TEAM_SUGGEST_MIN_TASKS, negative: "explicit_subagent" };
  }
  // 负向：单步/短文本且无引用、无复杂度
  if (NEGATIVE_TASK.test(source) && refCount === 0 && !(complexity?.score >= 3)) {
    return { suggested: false, score: 0, reasons: [], signals: [], minTasks: TEAM_SUGGEST_MIN_TASKS, negative: "single_step" };
  }

  // 正向信号
  if (refCount >= 2 || MULTI_MATERIAL.test(source)) addSignal("multi_material", "多份材料需要并行阅读与汇总");
  if (MULTI_CHAPTER.test(source) || (Number(complexity?.score) >= 4 && /(报告|规划|可研|工可|汇报材料)/.test(source))) addSignal("multi_chapter", "多章节/长文适合分章起草再统一审校");
  if (writing && review) addSignal("write_review_loop", "同时存在写作与审阅要求，适合撰写—审阅—核验闭环");
  if (modeName === "review" && (refCount >= 1 || hasCurrentFile) && BATCH_REVIEW.test(source)) addSignal("batch_review", "Review 批量检查适合 Lead + 审阅分工");
  if (complexity?.level === "complex" && Array.isArray(complexity?.reasons) && complexity.reasons.length >= 2) addSignal("complex_task", "任务复杂度较高，适合多角色分工");
  if (modeName === "review" && /(规划|工可|可研|报告|材料|文档)/.test(source) && (refCount >= 1 || hasCurrentFile)) addSignal("review_document", "Review 长材料适合 Lead + 审阅协作");

  const score = signals.length;
  const suggested = score >= Math.max(1, Number(threshold) || TEAM_SUGGEST_THRESHOLD);
  return {
    suggested,
    score,
    reasons,
    signals,
    minTasks: TEAM_SUGGEST_MIN_TASKS,
    negative: "",
  };
}
