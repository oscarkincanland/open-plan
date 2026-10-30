/**
 * 记忆自动抽取调度（H2-2）
 *
 * 目标：回合结束后，由外围调度器判断“是否值得抽取”，而不是完全依赖模型自觉。
 * 约束：
 *   - 只产出“待审核建议”，绝不直接写 MEMORY.md；
 *   - 预算 5 轮；只读子会话为主；
 *   - 失败静默记录，不影响主 Run 终态；
 *   - 默认关闭（OAW_MEMORY_EXTRACT）。
 */

export const EXTRACTION_MAX_TURNS = 5;

export const EXTRACTION_CATEGORIES = Object.freeze({
  project_fact: "项目事实",
  work_rule: "工作规则",
  user_preference: "用户偏好",
  lesson: "经验教训",
  resource_index: "资料索引",
});

const CATEGORY_BY_LABEL = new Map(Object.entries(EXTRACTION_CATEGORIES).map(([key, label]) => [label, key]));

/** 中文按字、英文按词计数；用于“用户散文 ≥3 词”的确定性门槛。 */
export function countProseWords(text) {
  const source = String(text || "");
  const cjk = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (source.match(/[A-Za-z0-9_]+/g) || []).length;
  return cjk + latin;
}

/**
 * 是否触发抽取。
 * @returns {{ok:boolean, reason:string, words:number}}
 */
export function shouldExtract({ userText = "", hadDirectMemoryWrite = false, mode = "agent" } = {}) {
  const words = countProseWords(userText);
  if (mode !== "agent") return { ok: false, reason: "mode_not_work", words };
  if (hadDirectMemoryWrite) return { ok: false, reason: "direct_memory_write", words };
  if (words < 3) return { ok: false, reason: "user_text_too_short", words };
  return { ok: true, reason: "ok", words };
}

export function buildExtractionPrompt({ userText = "", assistantText = "", workspace = "", manifest = [] } = {}) {
  return [
    "你是记忆抽取器。只判断本轮是否产生了对后续任务仍有价值的稳定事实。",
    "规则：",
    "1. 一条记忆 = 一个原子事实；不记录临时状态、完整对话、敏感凭据、大段原文、代码结构、git 历史。",
    "2. 纯问答/一次性咨询不必抽取；没有值得记的内容就返回 nothing。",
    '3. 只输出 JSON：{"action":"save","category":"项目事实|工作规则|用户偏好|经验教训|资料索引","content":"不超过220字"}',
    '   或 {"action":"nothing","reason":"原因"}。不要输出其他内容。',
    `工作区：${workspace}`,
    manifest.length ? `已有记忆（避免重复）：\n${manifest.map((item) => `- ${item.file}: ${item.description}`).join("\n")}` : "已有记忆：（无）",
    `用户输入：\n${String(userText || "").slice(0, 4000)}`,
    `助手输出：\n${String(assistantText || "").slice(0, 6000)}`,
  ].join("\n");
}

function normalizeCategory(value) {
  const raw = String(value || "").trim();
  if (EXTRACTION_CATEGORIES[raw]) return raw;
  if (CATEGORY_BY_LABEL.has(raw)) return CATEGORY_BY_LABEL.get(raw);
  if (/项目/.test(raw)) return "project_fact";
  if (/规则|准则/.test(raw)) return "work_rule";
  if (/偏好/.test(raw)) return "user_preference";
  if (/资料|索引/.test(raw)) return "resource_index";
  if (/经验|教训/.test(raw)) return "lesson";
  return null;
}

/**
 * 解析抽取结果；只接受严格 JSON 或带 JSON 代码块的文本。
 * @returns {{action:"save", category:string, content:string}|{action:"nothing", reason:string}|{action:"invalid", reason:string, raw:string}}
 */
export function parseExtractionResult(text) {
  const source = String(text || "").trim();
  if (!source) return { action: "invalid", reason: "empty", raw: source };
  if (/^nothing\s*to\s*save\.?$/i.test(source)) return { action: "nothing", reason: "nothing_to_save" };
  const match = source.match(/\{[\s\S]*\}/);
  if (!match) return { action: "invalid", reason: "no_json", raw: source.slice(0, 500) };
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return { action: "invalid", reason: "invalid_json", raw: source.slice(0, 500) }; }
  if (String(parsed.action || "").toLowerCase() === "nothing") {
    return { action: "nothing", reason: String(parsed.reason || "nothing_to_save").slice(0, 200) };
  }
  const content = String(parsed.content || "").trim();
  const category = normalizeCategory(parsed.category);
  if (!content || !category) return { action: "invalid", reason: "missing_content_or_category", raw: source.slice(0, 500) };
  if (content.length > 220) return { action: "invalid", reason: "content_too_long", raw: content.slice(0, 220) };
  return { action: "save", category, content };
}

/**
 * 执行一次抽取。
 * @param {object} input
 * @param {(prompt:string, meta:object)=>Promise<string>} input.runTask 只读子会话执行器
 * @param {(candidate:object)=>object} input.createProposal 记忆建议创建函数
 */
export async function runMemoryExtraction({
  userText = "",
  assistantText = "",
  workspace = "",
  manifest = [],
  runId = null,
  threadId = null,
  clientId = null,
  runTask,
  createProposal,
} = {}) {
  if (typeof runTask !== "function") throw new Error("runMemoryExtraction 需要 runTask");
  const prompt = buildExtractionPrompt({ userText, assistantText, workspace, manifest });
  const text = await runTask(prompt, { maxTurns: EXTRACTION_MAX_TURNS, readOnly: true });
  const parsed = parseExtractionResult(text);
  if (parsed.action === "nothing") return { action: "nothing", parsed, text };
  if (parsed.action === "invalid") return { action: "invalid", parsed, text };
  const proposal = typeof createProposal === "function"
    ? createProposal({
      workspace,
      category: parsed.category,
      content: parsed.content,
      runId,
      threadId,
      clientId,
      source: { type: "agent", label: "自动抽取", runId, threadId, clientId },
    })
    : null;
  return { action: "save", parsed, proposal, text };
}
