import crypto from "node:crypto";
import { RUNTIME_FLAGS, officeGateActiveFor } from "./运行开关.mjs";
import { estimateTaskComplexity, resolveSkillsRouting, resolveSkillDraftRouting } from "./任务复杂度.mjs";
import { matchTemplate } from "./office规范/模板匹配.mjs";
import { selectScene, sceneLabels, defaultScene } from "./office规范/场景选择.mjs";

const OFFICE_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc)$/i;
const DOCUMENT_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc|pdf|csv|json|md|markdown|txt|html|htm)$/i;
const CAD_EXTENSIONS = /\.(?:dxf|dwg)$/i;

/**
 * 工作台保留四种后端模式值。office 是历史兼容值，前端主入口展示
 * Chat / Work / Review；Office CLI 作为 Work 或 Review 的受控能力使用。
 */
export const TASK_MODES = Object.freeze(["chat", "office", "agent", "review"]);

// Chat 只读能力：只做查询、读取、分析总结，不落盘。
// 地图能力已收敛到 Work（用户决策 2026-11-07）：Chat 不再持有任何地图工具，
// 地图编辑/草稿/固化只在 Work 完成（模块入口也只在 Work 开放）。
const READ_ONLY_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "web_search", "web_fetch",
  // CAD 读取（cadAgent 开关，默认关）：Chat/Office 只读查看图纸，不声明修改工具。
  ...(RUNTIME_FLAGS.cadAgent ? ["cad_read"] : []),
]);
// Office 模式专注文档处理，不暴露地图工具（地图能力只在 Work 出现）。
const OFFICE_TOOLS = Object.freeze([
  ...READ_ONLY_TOOLS.filter((name) => !name.startsWith("map_")), "officecli",
]);
// Review 只依赖本地材料与规范库，不应因为通用 Agent 的工具集合而
// 暴露联网搜索能力；否则审查依据不可追溯，也会产生无关事件。
const REVIEW_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "officecli", "write", "edit", "review_copy", "review_source_apply", "todo",
  // 2026-11-04：Review 可创建只读专家团队（worker 由团队编排器降级为 scout，不会越权写文件）。
  "team_spawn", "team_send", "team_wait", "team_list", "team_task",
]);
const AGENT_TOOLS = Object.freeze([
  ...OFFICE_TOOLS,
  "bash", "write", "edit",
  // Work 模式持有全部地图工具：只读查询 + 草稿层 + 正式写。
  // 草稿层（map_draft_layer）不落正式库、免审批；固化/导入/改样式/删除/重置需审批。
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets", "map_layer_info",
  "map_draft_layer", "map_fixate_layer",
  "map_edit", "map_import", "map_save_analysis", "map_reset", "map_project_create",
  "memory_update", "todo",
  // 2026-11-04：后台任务（转后台的工具结果用 job_status 等待/读取，job_cancel 取消）
  "job_status", "job_cancel",
  // 2026-11-03：技能草稿（仅 Work；运行时还会检查复杂任务 + 项目设置开关）
  "skill_draft",
  // P2-A：编辑流水线（生成 Word/PPT 初稿的原生流水线，仅 Work 模式）
  "editorial_pipeline",
  // 2026-11-04：Agent Teams（Work 可写；Review 白名单另列，Chat 只读查看不提供工具）
  "team_spawn", "team_send", "team_wait", "team_list", "team_task",
  // 场景化分析模板（确定性编排，产出图层统计 + Word 报告；由 OAW_MAP_TEMPLATES 控制启用）
  "map_template",
  // CAD 白名单修改（cadAgent 开关，默认关）：仅 Work；落盘走统一审批与写入通道。
  ...(RUNTIME_FLAGS.cadAgent ? ["cad_edit"] : []),
  "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_back", "browser_close",
  "browser_wait_for", "browser_act", "browser_extract", "browser_select_option",
]);

/** Office/写作意图词（O-01）：覆盖中文最自然的说法，避免"写个文档"完全空转。 */
const OFFICE_INTENT_WORDS = Object.freeze([
  "officecli", "word", "excel", "ppt", "docx", "xlsx", "pptx", "表格", "文档排版", "修改文档",
  "文档", "报告", "汇报", "方案", "材料", "公文", "合同", "论文", "简历", "试卷", "文案", "纪要", "通知",
]);
/** 输出/写作意图词（O-01）。用双字词降低"做/拟"这类单字的误命中。 */
const OUTPUT_WORDS = Object.freeze([
  "生成", "创建", "导出", "写入", "制作", "做个", "做一份", "修改", "编辑", "排版", "整理", "输出",
  "写", "撰写", "起草", "编制", "拟一份", "拟定", "帮我写", "出一份",
]);
/** 编辑意图词：与"是否有既有文件"共同决定编辑路由。 */
const EDIT_WORDS = Object.freeze([
  "修改", "编辑", "调整", "润色", "替换", "删除", "批注", "标注", "补充",
  "改一下", "改成", "改为", "改短", "改长", "改写", "改错",
]);
/** 模板意图词：显式要求按模板写。 */
const TEMPLATE_INTENT_WORDS = Object.freeze(["按模板", "照着模板", "参考模板", "套模板", "模板写"]);

/** 澄清最小信息集（O-23）。 */
const MIN_INFO_FIELDS = Object.freeze([
  {
    id: "type",
    label: "文档类型",
    question: "这份文档要写成哪种类型？",
    options: () => sceneLabels().map((item) => item.label),
  },
  {
    id: "length",
    label: "篇幅",
    question: "期望的篇幅大概多少？",
    options: () => ["1-3 页", "5-10 页", "10-20 页", "20 页以上"],
  },
  {
    id: "audience",
    label: "受众",
    question: "这份材料主要给谁看？",
    options: () => ["主管部门", "行业专家", "投资方", "内部团队", "公众"],
  },
  {
    id: "source",
    label: "素材/数据来源",
    question: "素材和数据从哪里来？",
    options: () => ["使用当前工作区已有资料", "我稍后提供附件", "按公开资料撰写"],
  },
  {
    id: "style",
    label: "风格",
    question: "希望用什么风格写？",
    options: () => ["正式严谨", "简洁直接", "学术规范", "通俗易懂"],
  },
]);

export function normalizeTaskMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  return TASK_MODES.includes(value) ? value : "agent";
}

export function modeLabel(mode) {
  return {
    chat: "Chat",
    office: "Office",
    agent: "Agent",
    review: "Review",
  }[normalizeTaskMode(mode)];
}

export function modeDescription(mode) {
  return {
    chat: "只读检索知识库、Skills 和工作区资料，不修改文件",
    office: "通过 Office CLI 精准编辑 Office 文档，不开放通用脚本写入",
    agent: "可调用完整工具链，执行分析、修改并生成工作产物",
    review: "依据知识库规范审查材料，生成报告和副本；确认后才写回原文",
  }[normalizeTaskMode(mode)];
}

export function toolPolicyForMode(mode) {
  const normalized = normalizeTaskMode(mode);
  const tools = normalized === "chat"
    ? READ_ONLY_TOOLS
    : normalized === "office"
      ? OFFICE_TOOLS
      : normalized === "review"
        ? REVIEW_TOOLS
      : AGENT_TOOLS;
  return {
    mode: normalized,
    label: modeLabel(normalized),
    description: modeDescription(normalized),
    tools: [...tools],
  };
}

/**
 * 全部模式的工具并集（会话可激活工具全集）。
 *
 * 用途：Pi 会话创建时需要一次性注册所有模式的工具（按轮次再由
 * toolPolicyForMode 裁剪可见性）。此前这段清单在 server/agent.mjs 里
 * 硬编码了一份，与本文件的白名单形成两份事实来源，已发生漂移
 * （map_template 定义了却不在任何白名单，Work 模式调不到）。
 * 现在统一从这里派生，agent.mjs 只保留 run_subagent 与 MCP/扩展的动态追加。
 */
export function allModeToolNames() {
  const names = new Set();
  for (const mode of TASK_MODES) {
    for (const name of toolPolicyForMode(mode).tools) names.add(name);
  }
  return [...names];
}

function containsAny(text, words) {
  return words.some((word) => text.includes(String(word).toLowerCase()));
}

/**
 * 去掉前端自动拼接的上下文前缀，只保留用户原始意图。
 *
 * 背景：ChatPanel 会把 `[当前打开文件: ...]`、地图视图、附件、检索上下文等
 * 拼进发给 Pi 的 text；这些前缀不能参与能力规划，否则“可行性研究.docx”
 * 会让任何一句“继续”都命中模板路由。旧客户端没有 intentText 时用本函数兜底。
 */
export function stripAutoContextPrefix(text = "") {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inInjectedBlock = false;
  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();
    if (/^##\s*(当前检索上下文|已注入上下文)\s*$/.test(trimmed)) {
      inInjectedBlock = true;
      continue;
    }
    if (inInjectedBlock) {
      if (/^##\s+/.test(trimmed)) inInjectedBlock = false;
      else continue;
    }
    if (/^\[(?:当前打开文件|当前地图项目|当前地图视图|已上传附件):/.test(trimmed)) continue;
    const mention = trimmed.match(/^@智能体\[[^\]]+\]\s*([\s\S]*)$/);
    if (mention) {
      if (mention[1].trim()) out.push(mention[1]);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function collectContext({ text = "", task = {}, references = [], attachments = [] } = {}) {
  const mode = normalizeTaskMode(task.mode);
  const source = String(text || "").toLowerCase();
  const refList = Array.isArray(references) ? references : [];
  const attachmentNames = (Array.isArray(attachments) ? attachments : []).map((item) => String(item?.name || item || ""));
  const refTargets = refList.map((item) => String(item?.target || "")).join(" ");
  const files = [String(task.currentFile || ""), refTargets, ...attachmentNames]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" ");
  const officeRefExists = OFFICE_EXTENSIONS.test(files);
  const document = DOCUMENT_EXTENSIONS.test(files) || refList.some((item) => item.kind === "file" || item.kind === "template");
  const office = officeRefExists || containsAny(source, OFFICE_INTENT_WORDS);
  const output = containsAny(source, OUTPUT_WORDS);
  const editIntent = containsAny(source, EDIT_WORDS);
  const templateIntent = containsAny(source, TEMPLATE_INTENT_WORDS) || /@模板\[/.test(String(text || ""));
  return { mode, source, refList, files, officeRefExists, document, office, output, editIntent, templateIntent };
}

/**
 * 四路由判定（O-02）：template / edit / generate / read。
 * @returns {{route:"template"|"edit"|"generate"|"read", reason:string, template:object|null, scene:object, needsFile:boolean}}
 */
export function routeTaskIntent({ text = "", task = {}, references = [], attachments = [], previousRoute = null } = {}) {
  const ctx = collectContext({ text, task, references, attachments });
  const scene = selectScene(text);
  const template = ctx.mode === "chat" ? null : matchTemplate({ text, references: ctx.refList });

  if (ctx.mode === "chat") {
    return { route: "read", reason: "Chat 只读：不触发 Office 写入", template: null, scene, needsFile: false };
  }
  if (ctx.mode === "review") {
    return { route: "read", reason: "Review 只读审查：不生成或改写用户文档", template: null, scene, needsFile: false };
  }

  // 短句延续：当前文件是 Office、上一轮是写作路由时，“继续/继续修改”沿用上一轮，
  // 不再重新按文件名匹配模板。服务重启后 previousRoute 可由最近 Run 恢复。
  const followUp = /^(继续|接着|往下|继续修改|继续完成|接着改|继续做完|继续处理)/.test(String(text || "").trim());
  if (followUp && ctx.officeRefExists && ["edit", "template", "generate"].includes(String(previousRoute || ""))) {
    return {
      route: previousRoute,
      reason: `延续上一轮写作路由（${previousRoute}）`,
      template: previousRoute === "template" ? template : null,
      scene,
      needsFile: false,
    };
  }

  // 编辑优先：既有 Office 文件 + 编辑意图，即使文本命中模板关键词也走 edit。
  // 这是“可研报告.docx + 继续修改”被误判成模板生成的主修复。
  if (ctx.officeRefExists && ctx.editIntent) {
    return { route: "edit", reason: "既有 Office 文件 + 编辑意图：走 CLI 精确定位", template: null, scene, needsFile: false };
  }

  const explicitTemplate = Boolean(template && template.source === "explicit");
  if (explicitTemplate && (ctx.templateIntent || ctx.output || ctx.officeRefExists)) {
    return {
      route: "template",
      reason: `显式引用模板 ${template.file}（${template.file}）`,
      template,
      scene,
      needsFile: false,
    };
  }
  // 模板关键词只在“没有既有 Office 文件”时用于新建；有既有文件时优先 edit。
  if (template && !ctx.officeRefExists && (ctx.templateIntent || ctx.output)) {
    return {
      route: "template",
      reason: `命中模板 ${template.file}（文体关键词，新建文档）`,
      template,
      scene,
      needsFile: false,
    };
  }
  if (ctx.editIntent && !ctx.officeRefExists) {
    return { route: "read", reason: "编辑意图但未指定文件：先向用户确认目标文件", template: null, scene, needsFile: true };
  }
  if (ctx.output && (ctx.office || template)) {
    return { route: "generate", reason: "生成意图且无模板/既有文件：走原生生成", template: null, scene, needsFile: false };
  }
  return { route: "read", reason: "未命中写入意图：按只读处理", template: null, scene, needsFile: false };
}

/** 判断最小信息集里哪些字段缺失（O-23）。 */
export function missingInfoFields({ text = "", route = "read", template = null, scene = null } = {}) {
  if (route !== "template" && route !== "generate") return [];
  const source = String(text || "");
  const missing = [];
  const hasType = Boolean(template) || Number(scene?.confidence) > 0 || /(文档|报告|汇报|方案|公文|合同|论文|简历|试卷|文案|纪要|通知)/.test(source);
  if (!hasType) missing.push("type");
  if (!/(\d+\s*(页|字|章|节)|篇幅|字数|不少于|不超过|控制在)/.test(source)) missing.push("length");
  if (!/(受众|读者|给|面向|领导|专家|群众|客户|投资人|主管部门)/.test(source)) missing.push("audience");
  if (!/(数据|资料|素材|附件|引用|调研|统计|问卷|已有|工作区)/.test(source)) missing.push("source");
  if (!/(风格|正式|简洁|学术|口语|严谨|通俗|专业)/.test(source)) missing.push("style");
  return missing;
}

/**
 * 澄清闸门（O-23）：缺 ≥2 项才问，只问最阻塞的一项。
 * @returns {{shouldAsk:boolean, missing:string[], question:{field:string,label:string,text:string,options:string[]}|null, assumption:string}}
 */
export function assessClarification({ text = "", route = "read", template = null, scene = null } = {}) {
  const missing = missingInfoFields({ text, route, template, scene });
  // 用户显式授权"你看着办"时不再追问，直接按默认值并在产物里标注。
  if (/(你看着办|随便|按你的判断|你决定|都行)/.test(String(text || ""))) {
    return { shouldAsk: false, missing, question: null, assumption: "用户授权按默认值处理，产物中标注假设" };
  }
  if (missing.length < 2) {
    return {
      shouldAsk: false,
      missing,
      question: null,
      assumption: missing.length === 1 ? `按默认值补齐「${MIN_INFO_FIELDS.find((f) => f.id === missing[0])?.label || missing[0]}」并在产物中标注` : "",
    };
  }
  const field = MIN_INFO_FIELDS.find((item) => item.id === missing[0]) || MIN_INFO_FIELDS[0];
  return {
    shouldAsk: true,
    missing,
    question: { field: field.id, label: field.label, text: field.question, options: field.options() },
    assumption: "",
  };
}

/** 根据输入和引用生成可解释的本轮能力计划，供 Run、前端和 Pi prompt 共用。 */
export function planTaskCapabilities({ text = "", task = {}, references = [], attachments = [], previousRoute = null } = {}) {
  const ctx = collectContext({ text, task, references, attachments });
  const intent = routeTaskIntent({ text, task, references, attachments, previousRoute });
  const clarification = assessClarification({ text, route: intent.route, template: intent.template, scene: intent.scene });
  const { mode, source, refList, document, output } = ctx;
  // Chat 模式下识别到写作意图时，前端提示切换到 Work（不改变只读边界）。
  const hint = mode === "chat" && ctx.output && ctx.office
    ? { code: "MODE_SWITCH_REQUIRED", message: "当前是 Chat 只读模式；生成文档请切换到 Work。" }
    : null;
  const knowledge = refList.some((item) => ["knowledge", "knowledge_dir"].includes(item.kind)) || containsAny(source, ["知识库", "知识库搜索", "知识检索", "参考资料"]);
  const map = containsAny(source, ["地图", "图层", "geojson", "等时圈", "热力图", "od图", "空间分析"]) || /(?:^|[\\/])maps(?:[\\/]|$)/i.test(ctx.files);
  // CAD 意图：文件扩展名或话术命中（cad 读取/修改能力，cadPreview/cadAgent 开关族）
  const cad = CAD_EXTENSIONS.test(ctx.files) || containsAny(source, ["dxf", "dwg", "cad", "图纸", "红线图", "总平面"]);
  const workflow = Boolean(task.workflowId) || /@工作流\[|@技能\[|#技能\[|工作流|skill|workflow/i.test(String(text || ""));
  // 2026-11-03：复杂度只影响“默认技能清单 / 技能发现 / 草稿钩子”，不改变工具权限。
  const complexity = estimateTaskComplexity({ text, task, references, attachments });
  const skillsRouting = resolveSkillsRouting({ complexity, task, text });
  const skillDraftsRouting = resolveSkillDraftRouting({ complexity, task });
  const officeGenerate = (intent.route === "generate" || intent.route === "template") && mode !== "chat" && mode !== "review";
  const capabilities = [
    mode === "chat"
      ? { id: "chat", label: "Chat 检索", status: "ready", required: true, provider: "pi", reason: "只读检索知识库、Skills 和工作区资料" }
      : mode === "office"
        ? { id: "office", label: "Office 对话", status: "ready", required: true, provider: "pi", reason: "通过 Office CLI 精准处理 Office 文档" }
        : mode === "review"
          ? { id: "review", label: "Review 审查", status: "ready", required: true, provider: "pi", reason: "依据规范生成审查报告和安全副本" }
        : { id: "agent", label: "Agent 对话", status: "ready", required: true, provider: "pi", reason: "处理本轮任务并保持会话上下文" },
  ];
  // provider 表示该能力由谁实现：native=工作台原生代码，officecli=外部 Office CLI 二进制，pi=Pi Agent 运行时。
  // 契约 v3 把"路由建议"升级为四路由（template/edit/generate/read）与澄清闸门。
  if (document) capabilities.push({ id: "document", label: "文档读取", status: "planned", required: true, provider: "native", reason: "本轮存在文档、文件引用或附件" });
  if (knowledge) capabilities.push({ id: "knowledge", label: "知识库检索", status: "planned", required: false, provider: "native", reason: "本轮出现知识库引用或检索意图" });
  if (intent.route === "template") {
    capabilities.push({
      id: "template",
      label: "模板写作",
      status: "preferred",
      required: true,
      provider: "native",
      reason: `命中既有模板 ${intent.template.file}，按其章节与规则写作`,
    });
  }
  // Chat 只负责检索与解释，即使用户提到 docx/xlsx，也不能触发 Office CLI
  // 预检或写入路由；Office CLI 仅作为 Office 兼容模式或 Agent 内部能力使用。
  if ((intent.route === "edit" || intent.route === "generate" || intent.route === "template") && mode !== "chat") {
    capabilities.push({
      id: "officecli",
      label: "Office CLI",
      // 编辑类 preferred；模板/生成类原生直写优先，CLI 只兜底高级操作。
      status: intent.route === "edit" ? "preferred" : "fallback",
      required: intent.route === "edit" && Boolean(output),
      provider: "officecli",
      reason: intent.route === "edit"
        ? "本轮涉及编辑既有 Office 文档，需要 CLI 精确定位能力"
        : "模板/生成类任务优先原生直写，Office CLI 仅兜底高级操作",
    });
  }
  // 原生 Office 生成能力（§5.4/§5.5）：新建 Word/Excel/PPT 走工作台内置 OOXML 引擎。
  if (officeGenerate) {
    capabilities.push({ id: "office_generate", label: "Office 原生生成", status: "preferred", required: false, provider: "native", reason: "新建文档由内置 OOXML 引擎直写，无需外部二进制预检" });
    // 编辑流水线（计划 2026-10-31-003 / N-03）：写作路由的预设成文主链。
    // 此前它是隐式工具——白名单里有但能力计划不声明，模型无从知道该走它，
    // 实测因此退化成 officecli 裸命令试探（20 次失败）。这里显式声明为 preferred。
    capabilities.push({
      id: "editorial_pipeline",
      label: "编辑流水线",
      status: "preferred",
      required: false,
      provider: "native",
      reason: "成文走 Planner→Writer→Formatter 原生直写→Evaluator 确定性管线；已有 Markdown 可 sourceMarkdown 直通",
    });
  }
  if (mode === "review") capabilities.push({ id: "reviewEvidence", label: "规范依据台账", status: "required", required: true, provider: "native", reason: "每条审查结论必须绑定实际读取的规范文件" });
  // 子代理能力只在 Chat 与 Work 声明；与 toolPolicyForMode 的 run_subagent 白名单保持一致，
  // 避免"声明了却调不到"（Office / Review 不暴露 run_subagent）。
  if (mode === "chat" || mode === "agent") capabilities.push({ id: "subagent", label: "子代理", status: "available", required: false, provider: "pi", reason: "可派发隔离的只读子 Agent 并行处理资料阅读/审阅" });
  // Agent Teams：Work / Review 可创建（Review 只读），Chat 只能查看历史团队，不能创建。
  if (mode === "agent" || mode === "review") {
    capabilities.push({
      id: "team",
      label: "专家团队",
      status: "available",
      required: false,
      provider: "pi",
      reason: mode === "review"
        ? "可创建只读审阅团队（Lead + 最多 2 名队友），共享任务板；不越权写文件"
        : "可创建 Lead + 最多 2 名队友的专家小组，共享任务板与消息；写操作仍逐次审批",
    });
  }
  // 地图能力只在 Work 声明（用户决策 2026-11-07：地图模块不保留 Chat）。
  // Chat/Office/Review 的工具白名单里都没有地图工具，声明了就成了"说得到做不到"。
  const mapAvailable = map && mode === "agent";
  if (mapAvailable) {
    const mapWritable = mode === "agent";
    capabilities.push({
      id: "map",
      label: "地图工具",
      status: "ready",
      required: false,
      provider: "native",
      reason: mapWritable
        ? "地图草稿层生成、查询、分析与用户确认后固化（正式写需审批）"
        : "地图仅在 Work 模式可用",
    });
  }
  // CAD 能力（cadAgent 开关，默认关）：关闭时不声明，编排/遥测与基线一致。
  // cad 恒 preferred（解析内置于工作台，无外部二进制）；cad_dwg 的实际可用性取决于
  // 外部转换工具（ODA/LibreDWG），计划期不做同步探测，以 cad_read/cad_edit 返回为准。
  if (RUNTIME_FLAGS.cadAgent && cad && (mode === "chat" || mode === "agent")) {
    capabilities.push({ id: "cad", label: "CAD 读取", status: "ready", required: false, provider: "native", reason: "DXF/DWG 结构化读取（cad_read/context_read），解析内置于工作台" });
    capabilities.push({ id: "cad_edit", label: "CAD 白名单修改", status: mode === "agent" ? "ready" : "not_available", required: false, provider: "native", reason: mode === "agent" ? "DXF 实体级白名单修改（cad_edit，写入走审批）；DWG 经 DXF 往返" : "Chat 只读，不声明修改能力" });
    capabilities.push({ id: "cad_dwg", label: "CAD DWG 转换", status: "planned", required: false, provider: "external", reason: "DWG 依赖外部转换工具（ODA/LibreDWG），未装时自动降级 DXF 另存" });
  }
  if (workflow) capabilities.push({ id: "skills", label: "Skills / 工作流", status: "planned", required: Boolean(task.workflowId), provider: "native", reason: task.workflowId ? `工作流 ${task.workflowId} 声明了技能依赖` : "本轮出现工作流或技能意图" });
  else if (skillsRouting === "preflight" || skillsRouting === "catalog") capabilities.push({ id: "skills", label: "Skills 目录", status: "available", required: false, provider: "native", reason: "每轮注入技能目录，模型按任务匹配读取" });
  if (skillDraftsRouting === "enabled") capabilities.push({ id: "skill_drafts", label: "技能草稿", status: "available", required: false, provider: "native", reason: "项目允许生成草稿；安装需用户确认" });
  return {
    version: 3,
    mode,
    route: intent.route,
    routeReason: intent.reason,
    template: intent.template ? { relPath: intent.template.relPath, title: intent.template.title, source: intent.template.source } : null,
    scene: intent.scene ? { id: intent.scene.scene, label: intent.scene.label, confidence: intent.scene.confidence } : null,
    clarification,
    hint,
    complexity,
    capabilities,
    routing: {
      // preferred=编辑既有文档（admission 阻塞预检）；lazy=生成类任务（原生直写优先，
      // 预检后台惰性执行，不阻塞 admission）；not_needed=无 Office 意图。
      officecli: intent.route === "edit"
        ? "preferred"
        : (intent.route === "generate" || intent.route === "template") && mode !== "chat"
          ? "lazy"
          : "not_needed",
      template: intent.route === "template" ? "preferred" : "not_needed",
      // 规范层开关（ADR 0012）：写作路由（模板/生成）自动生效；OAW_OFFICE_FORMAT=off 退出。
      officeFormat: officeGateActiveFor(intent.route, mode) ? "auto" : "off",
      documentRead: document ? "enabled" : "not_needed",
      knowledge: knowledge ? "enabled" : "not_needed",
      // read_only / read_write：让前端与提示词都能区分"能不能落盘"。
      // 仅当上面真的声明了地图能力时才启用（与 capabilities 严格一致）。
      map: mapAvailable ? "read_write" : "not_needed",
      skills: skillsRouting,
      skillDrafts: skillDraftsRouting,
    },
    output: { expected: mode !== "chat" && output, saveToWorkspace: mode !== "chat" && task.output?.saveToWorkspace !== false },
  };
}

export function createTaskEnvelope(input = {}) {
  const references = Array.isArray(input.references) ? input.references : [];
  const mode = normalizeTaskMode(input.mode);
  return {
    version: 1,
    id: input.id || `task_${crypto.randomUUID()}`,
    goal: String(input.goal || input.text || "").trim(),
    // v0.13.0：跨轮长期目标（Harness 层），与 task.goal（本轮任务描述）严格分层。
    longTermGoal: input.longTermGoal || null,
    mode,
    modeLabel: modeLabel(input.mode),
    modeDescription: modeDescription(input.mode),
    workflowId: input.workflowId || null,
    recoveryOf: input.recoveryOf || null,
    recoveryAction: input.recoveryAction || null,
    projectId: input.projectId || null,
    mapProject: input.mapProject || null,
    agentProfile: input.agentProfile || "通用 Agent",
    projectSettings: input.projectSettings || null,
    profilePolicy: input.profilePolicy || input.projectSettings?.profilePolicy || null,
    workspaceId: input.workspaceId || null,
    threadId: input.threadId || null,
    currentFile: input.currentFile || null,
    references: references.map((r) => ({ id: r.id, kind: r.kind, target: r.target, status: r.status })),
    capabilityPlan: input.capabilityPlan || null,
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    output: {
      format: input.output?.format || "markdown",
      saveToWorkspace: mode !== "chat" && input.output?.saveToWorkspace !== false,
      requireSources: input.output?.requireSources !== false,
    },
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function taskSummary(task) {
  if (!task) return "";
  const longTerm = task.longTermGoal;
  return [
    "当前任务",
    `目标：${task.goal || "（未提供）"}`,
    longTerm?.text ? `长期目标：${longTerm.text}` : "",
    longTerm?.text ? `目标状态：${longTerm.statusLabel || longTerm.status}；轮次 ${Number(longTerm.turns) || 0}；Token ${Number(longTerm.usedTokens) || 0}${Number(longTerm.budgetTokens) > 0 ? `/${longTerm.budgetTokens}` : ""}` : "",
    `模式：${task.modeLabel || modeLabel(task.mode)}`,
    task.workflowId ? `工作流：${task.workflowId}` : "",
    task.currentFile ? `当前文件：${task.currentFile}` : "",
    task.mapProject ? `当前地图项目：${task.mapProject}` : "",
    mapCapabilityHint(task),
    officeWritingHint(task),
    task.references?.length ? `引用：${task.references.length} 项` : "",
    task.mode === "chat" ? "边界：只读检索，不修改文件。" : "边界：按任务执行工具，面向用户直接给出结论；过程与产物详情留在任务记录中，按需说明。",
  ].filter(Boolean).join("\n");
}

/**
 * 地图能力边界（2026-11-07 修订）：地图只在 Work 模式可用。
 * 目的是让模型知道草稿层与固化的边界——而不是等到失败后才发现权限不足。
 */
function mapCapabilityHint(task = {}) {
  const plan = task.capabilityPlan;
  const routing = plan?.routing?.map;
  if (routing !== "read_write") return "";
  return [
    "地图能力（Work）：可查询数据集与图层、生成点/线/面草稿层（不落正式库、免审批）、分析出图。",
    "草稿层由 map_draft_layer 生成，用户在地图面板确认后才固化；固走 map_fixate_layer（需用户审批）。",
    "正式写入（固化 / 导入 / 改样式 / 删除 / 重置 / 新建项目）都需要审批；共享数据集只读，锁定图层禁止写入。",
    "演示数据必须在结果中明确标注，不得静默写成正式图层。",
  ].join("\n");
}

/**
 * 写作工具书（计划 2026-10-31-003 / N-02）：写作路由注入提示词的标准流程。
 *
 * 背景：实测 run_05198175 里模型不知道存在编辑流水线与模板，只能用 officecli 裸命令试探，
 * 57 次调用中 15 次在读 help、约 15 次在探针文件上试错，20 次失败。这段提示把
 * "预设流程"直接讲清楚，让模型走既定主链而不是自由发挥。
 */
function officeWritingPlaybook() {
  return [
    "写作流程（按序执行）:",
    "1) 先 read 模板与配套规范，确认章节骨架、必备图表清单和格式规则；",
    "2) 成文优先用 editorial_pipeline 工具（Planner→Writer→Formatter 原生直写→Evaluator 确定性验收）；",
    "   已有成稿 Markdown 时用它的 sourceMarkdown 直通，跳过 Planner/Writer；",
    "3) 需要逐章增量写入时，用 write 写一章、紧接 add <file> / --type markdown --prop src=<章节.md>（write→add 成对出现，不要攒批）；",
    "4) 样式：create 新建文档已预置 Normal/Heading1-4/Title/TOC/页眉页脚，直接用，不要用 raw-set 改 styles.xml；",
    "5) 自检：validate <file> 与 view <file> issues；",
    "6) 收尾：直接给用户最终答复，写清产物路径与未完成项。",
    "禁止：不要用 bash 写生成脚本；不要手写 styles.xml；不要把 JSON 塞进命令行参数。",
    "常用命令速查（覆盖绝大多数文档操作，不要再跑 help / --help 去探索）：",
    "  create <f>.docx            新建文档（已预置样式）；create <f>.docx --force 覆盖已有文件",
    "  add <f> / --type markdown --prop src=<章节.md>   导入写好的章节",
    "  set <f> /body/p[N] --prop style=Heading2         给段落套标题样式",
    "  add <f> /body/p[N] --type table                  插入表格",
    "  add <f> /body/p[N] --type image --prop image=<路径> 插入图片",
    "  view <f> text|outline|stats|issues               回读校验",
    "命令失败时：读错误信息、改同一命令再试一次——不要用 help 代替调整（这最浪费回合）。",
  ].join("\n");
}

/**
 * 写作路由提示（O-05）：只从能力计划读取，避免提示词另写一份路由事实。
 * 仅在 template/edit/generate 路由下注入，read 不占上下文。
 */
function officeWritingHint(task = {}) {
  const plan = task.capabilityPlan;
  const route = plan?.route;
  if (!route || route === "read") return "";
  const scene = plan?.scene?.label || plan?.scene?.id || "";
  const template = plan?.template?.relPath || "";
  if (route === "template") {
    return `写作路由：模板优先（${template}${scene ? `；场景：${scene}` : ""}）。先读取模板，按其章节骨架、必备图表与格式规则写作。\n` + officeWritingPlaybook();
  }
  if (route === "edit") {
    return "写作路由：编辑既有文档。先 view 确认内容，再 get 取真实路径，最后 set/add；保留未触及的格式。";
  }
  if (route === "generate") {
    return `写作路由：生成新文档（场景：${scene || "report"}）。按场景参数生成，完成后走规则闸门。\n` + officeWritingPlaybook();
  }
  return "";
}

export { defaultScene, MIN_INFO_FIELDS };
