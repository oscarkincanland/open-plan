import crypto from "node:crypto";
import { RUNTIME_FLAGS } from "./运行开关.mjs";
import { matchTemplate } from "./office规范/模板匹配.mjs";
import { selectScene, sceneLabels, defaultScene } from "./office规范/场景选择.mjs";

const OFFICE_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc)$/i;
const DOCUMENT_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc|pdf|csv|json|md|markdown|txt|html|htm)$/i;

/**
 * 工作台保留四种后端模式值。office 是历史兼容值，前端主入口展示
 * Chat / Work / Review；Office CLI 作为 Work 或 Review 的受控能力使用。
 */
export const TASK_MODES = Object.freeze(["chat", "office", "agent", "review"]);

// Chat 只读能力：只做查询、读取、分析总结，不落盘。
// 地图的只读四件套也在此列——查询数据集、生成临时可视化、清除临时结果、
// 列出可用数据。写操作（map_edit / map_import / map_save_analysis）只在 Work，
// 用户明确要求"新增图层"时切到 Work 模式执行。
const READ_ONLY_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "web_search", "web_fetch",
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets",
]);
// Office 模式专注文档处理，不暴露地图工具（地图能力只在 Chat 与 Work 出现）。
const OFFICE_TOOLS = Object.freeze([
  ...READ_ONLY_TOOLS.filter((name) => !name.startsWith("map_")), "officecli",
]);
// Review 只依赖本地材料与规范库，不应因为通用 Agent 的工具集合而
// 暴露联网搜索能力；否则审查依据不可追溯，也会产生无关事件。
const REVIEW_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "officecli", "write", "edit", "review_copy", "review_source_apply", "todo", "complete_task",
]);
const AGENT_TOOLS = Object.freeze([
  ...OFFICE_TOOLS,
  "bash", "write", "edit",
  // Work 模式持有全部地图工具（含只读四件套与三个写工具）。
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets",
  "map_edit", "map_import", "map_save_analysis",
  "memory_update", "todo", "complete_task",
  // P2-A：编辑流水线（生成 Word/PPT 初稿的原生流水线，仅 Work 模式）
  "editorial_pipeline",
  "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_back", "browser_close",
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

function containsAny(text, words) {
  return words.some((word) => text.includes(String(word).toLowerCase()));
}

function collectContext({ text = "", task = {}, references = [], attachments = [] } = {}) {
  const mode = normalizeTaskMode(task.mode);
  const source = String(text || "").toLowerCase();
  const refList = Array.isArray(references) ? references : [];
  const attachmentNames = (Array.isArray(attachments) ? attachments : []).map((item) => String(item?.name || item || ""));
  const refTargets = refList.map((item) => String(item?.target || "")).join(" ");
  const files = [String(task.currentFile || ""), refTargets, ...attachmentNames].join(" ").trim();
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
export function routeTaskIntent({ text = "", task = {}, references = [], attachments = [] } = {}) {
  const ctx = collectContext({ text, task, references, attachments });
  const scene = selectScene(text);
  const template = ctx.mode === "chat" ? null : matchTemplate({ text, references: ctx.refList });

  if (ctx.mode === "chat") {
    return { route: "read", reason: "Chat 只读：不触发 Office 写入", template: null, scene, needsFile: false };
  }
  if (ctx.mode === "review") {
    return { route: "read", reason: "Review 只读审查：不生成或改写用户文档", template: null, scene, needsFile: false };
  }
  if (template && (ctx.templateIntent || ctx.output || ctx.officeRefExists)) {
    return {
      route: "template",
      reason: `命中模板 ${template.file}（${template.source === "explicit" ? "显式引用" : "文体关键词"}）`,
      template,
      scene,
      needsFile: false,
    };
  }
  if (ctx.officeRefExists && ctx.editIntent) {
    return { route: "edit", reason: "既有 Office 文件 + 编辑意图：走 CLI 精确定位", template: null, scene, needsFile: false };
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
export function planTaskCapabilities({ text = "", task = {}, references = [], attachments = [] } = {}) {
  const ctx = collectContext({ text, task, references, attachments });
  const intent = routeTaskIntent({ text, task, references, attachments });
  const clarification = assessClarification({ text, route: intent.route, template: intent.template, scene: intent.scene });
  const { mode, source, refList, document, output } = ctx;
  const knowledge = refList.some((item) => ["knowledge", "knowledge_dir"].includes(item.kind)) || containsAny(source, ["知识库", "知识库搜索", "知识检索", "参考资料"]);
  const map = containsAny(source, ["地图", "图层", "geojson", "等时圈", "热力图", "od图", "空间分析"]) || /(?:^|[\\/])maps(?:[\\/]|$)/i.test(ctx.files);
  const workflow = Boolean(task.workflowId) || /@工作流\[|@技能\[|工作流|skill|workflow/i.test(String(text || ""));
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
  }
  if (mode === "review") capabilities.push({ id: "reviewEvidence", label: "规范依据台账", status: "required", required: true, provider: "native", reason: "每条审查结论必须绑定实际读取的规范文件" });
  // 子代理能力只在 Chat 与 Work 声明；与 toolPolicyForMode 的 run_subagent 白名单保持一致，
  // 避免"声明了却调不到"（Office / Review 不暴露 run_subagent）。
  if (mode === "chat" || mode === "agent") capabilities.push({ id: "subagent", label: "子代理", status: "available", required: false, provider: "pi", reason: "可派发隔离的只读子 Agent 并行处理资料阅读/审阅" });
  // 地图能力只在 Chat（只读）与 Work（可写）声明；Office 专注文档、Review 依赖本地材料，
  // 两者的工具白名单里都没有地图工具，声明了就成了"说得到做不到"（X1 的同类问题）。
  const mapAvailable = map && (mode === "chat" || mode === "agent");
  if (mapAvailable) {
    const mapWritable = mode !== "chat" && mode !== "review";
    capabilities.push({
      id: "map",
      label: "地图工具",
      status: "ready",
      required: false,
      provider: "native",
      reason: mapWritable
        ? "地图查询、分析与图层写入（写操作需审批）"
        : "地图只读查询与临时可视化（不落盘；保存图层需切到 Work 模式）",
    });
  }
  if (workflow) capabilities.push({ id: "skills", label: "Skills / 工作流", status: "planned", required: Boolean(task.workflowId), provider: "native", reason: task.workflowId ? `工作流 ${task.workflowId} 声明了技能依赖` : "本轮出现工作流或技能意图" });
  return {
    version: 3,
    mode,
    route: intent.route,
    routeReason: intent.reason,
    template: intent.template ? { relPath: intent.template.relPath, title: intent.template.title, source: intent.template.source } : null,
    scene: intent.scene ? { id: intent.scene.scene, label: intent.scene.label, confidence: intent.scene.confidence } : null,
    clarification,
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
      // 规范层开关：默认关；只有模板/生成路由且开关打开时才生效。
      officeFormat: RUNTIME_FLAGS.officeFormat && (intent.route === "template" || intent.route === "generate") ? "auto" : "off",
      documentRead: document ? "enabled" : "not_needed",
      knowledge: knowledge ? "enabled" : "not_needed",
      // read_only / read_write：让前端与提示词都能区分"能不能落盘"。
      // 仅当上面真的声明了地图能力时才启用（与 capabilities 严格一致）。
      map: mapAvailable ? (mode === "chat" ? "read_only" : "read_write") : "not_needed",
      skills: workflow ? "preflight" : "available_on_demand",
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
  return [
    "当前任务",
    `目标：${task.goal || "（未提供）"}`,
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
 * 地图能力边界（阶段 3）：只在"本轮确实涉及地图"时注入，避免每轮都占用上下文。
 * 目的是让模型知道当前模式能做什么、不能做什么——而不是等到失败后才发现权限不足。
 */
function mapCapabilityHint(task = {}) {
  const plan = task.capabilityPlan;
  const routing = plan?.routing?.map;
  if (routing !== "read_only" && routing !== "read_write") return "";
  if (routing === "read_write") {
    return "地图能力：可查询数据集与图层、生成临时可视化，并可将结果保存为正式图层（写操作需用户审批）。";
  }
  return [
    "地图能力（只读）：可查询数据集与图层、生成临时可视化（如热力图 / OD 流向 / 等时圈）、清除临时结果。",
    "不可执行：新增、修改、删除图层，或把分析结果保存为正式图层——这些需要用户切换到 Work 模式。",
    "当用户要求写操作时，明确说明需要切到 Work 模式，不要尝试绕过，也不要假装已完成。",
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
    return `写作路由：模板优先（${template}${scene ? `；场景：${scene}` : ""}）。先读取模板，按其章节骨架、必备图表与格式规则写作。`;
  }
  if (route === "edit") {
    return "写作路由：编辑既有文档。先 view 确认内容，再 get 取真实路径，最后 set/add；保留未触及的格式。";
  }
  if (route === "generate") {
    return `写作路由：生成新文档（场景：${scene || "report"}）。按场景参数生成，完成后走规则闸门。`;
  }
  return "";
}

export { defaultScene, MIN_INFO_FIELDS };
