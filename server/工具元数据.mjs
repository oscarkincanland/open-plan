/**
 * 工具能力元数据（H1-1）
 *
 * 定位：工具“能力事实”的唯一来源——只读/破坏性/副作用域/风险等级/是否需审批/结果预算。
 * 与 server/task.mjs 的关系：
 *   - task.mjs 仍负责“某模式能看到哪些工具”（可见性事实）；
 *   - 本模块负责“这些工具本身是什么属性”（能力事实）；
 *   - 两者由契约测试保证双向一致，避免成为两份漂移的白名单。
 *
 * 设计约束：
 *   - 不修改 Pi 内核；原生工具用静态表补齐。
 *   - concurrencySafe 先只作为审计字段：Pi 内核是否支持同层并行尚未确认，
 *     因此不把它当成调度承诺。
 *   - MCP 服务端 annotations 不可信；MCP 工具统一用保守默认值。
 */

import { RUNTIME_FLAGS } from "./运行开关.mjs";

const KB = 1024;

function budget(maxInlineBytes, direction = "head", strategy = "artifact") {
  return {
    maxInlineBytes,
    maxModelBytes: maxInlineBytes,
    strategy,
    preview: { direction },
  };
}

// ---- 展示元数据（verb/icon）----
// 会话流工具卡的"动词 + 图标"以前由前端两处各维护一份：ChatPanel.jsx 的 toolPhrase
// 与 事件展示.js 的 toolIdentity，新增工具会退化成「调用 xxx」或通用图标。
// 2026-11-06 收敛到本表：能力事实与展示用同一张登记，前端经 /api/harness/tools 取用，
// 取不到时才回落到前端的内置映射（离线/历史会话）。
const PRESENTATION_OVERRIDES = new Map([
  ["read", { verb: "读取文件", icon: "file" }],
  ["context_read", { verb: "读取上下文", icon: "file" }],
  ["write", { verb: "写入文件", icon: "edit" }],
  ["edit", { verb: "编辑文件", icon: "edit" }],
  ["bash", { verb: "执行命令", icon: "terminal" }],
  ["officecli", { verb: "操作 Office 文档", icon: "doc" }],
  ["grep", { verb: "搜索内容", icon: "search" }],
  ["find", { verb: "查找文件", icon: "search" }],
  ["ls", { verb: "查看文件列表", icon: "search" }],
  ["glob", { verb: "查找文件", icon: "search" }],
  ["kb_search", { verb: "搜索知识库", icon: "book" }],
  ["kb_read", { verb: "读取知识库", icon: "book" }],
  ["skills_search", { verb: "搜索 Skills", icon: "book" }],
  ["skills_read", { verb: "读取 Skill 说明", icon: "book" }],
  ["skill_draft", { verb: "生成技能草稿", icon: "book" }],
  ["todo", { verb: "更新任务清单", icon: "list" }],
  ["run_subagent", { verb: "子代理", icon: "flow" }],
  ["editorial_pipeline", { verb: "编辑流水线", icon: "flow" }],
  ["ask_user", { verb: "向你提问", icon: "comment" }],
  ["memory_update", { verb: "更新记忆", icon: "book" }],
  ["web_search", { verb: "联网搜索", icon: "search" }],
  ["web_fetch", { verb: "抓取网页", icon: "search" }],
  ["cad_read", { verb: "读取 CAD 图纸", icon: "doc" }],
  ["cad_edit", { verb: "修改 CAD 图纸", icon: "edit" }],
]);

const PRESENTATION_RULES = [
  [/^map_/, { verb: "地图操作", icon: "map" }],
  [/^browser_/, { verb: "浏览器操作", icon: "globe" }],
  [/^(job_|background_)/, { verb: "后台任务", icon: "history" }],
  [/^(team_|teamTask)/, { verb: "团队协作", icon: "flow" }],
  [/^(memory_|goal_)/, { verb: "记忆与目标", icon: "book" }],
  [/^(review_|reviewCopy)/, { verb: "规范审查", icon: "shield" }],
  [/^(terminal|shell)/, { verb: "执行命令", icon: "terminal" }],
];

/** 工具名 → { verb, icon }；未知工具给通用图标、verb 留空（前端回落「调用 <name>」）。 */
function presentationFor(name) {
  const key = String(name || "").trim();
  const override = PRESENTATION_OVERRIDES.get(key);
  if (override) return Object.freeze({ ...override });
  for (const [pattern, value] of PRESENTATION_RULES) {
    if (pattern.test(key)) return Object.freeze({ ...value });
  }
  return Object.freeze({ verb: null, icon: "tool" });
}

function meta(name, options = {}) {
  return Object.freeze({
    name,
    readOnly: options.readOnly === true,
    destructive: options.destructive === true,
    concurrentSafe: options.concurrentSafe === true,
    sideEffectScope: options.sideEffectScope || (options.readOnly ? "none" : "workspace"),
    riskLevel: options.riskLevel || (options.readOnly ? "low" : "medium"),
    needsApproval: options.needsApproval === true,
    // 强制确认：即使审批模式为 auto，也不得自动提升为 allow（正式写/破坏性操作）。
    forceConfirm: options.forceConfirm === true,
    permission: {
      patternSource: options.patternSource || (options.needsApproval ? "input" : "none"),
      denyPriority: Number(options.denyPriority || 0),
    },
    resultBudget: options.resultBudget || budget(30 * KB, "head", options.readOnly ? "truncate" : "artifact"),
    presentation: options.presentation || presentationFor(name),
    notes: options.notes || "",
  });
}

const READ = { readOnly: true, sideEffectScope: "none", riskLevel: "low" };

const METADATA = new Map();

function add(list) {
  for (const item of list) {
    if (METADATA.has(item.name)) throw new Error(`工具元数据重复：${item.name}`);
    METADATA.set(item.name, item);
  }
}

add([
  // ---- 工作区读取 ----
  meta("read", { ...READ, resultBudget: budget(30 * KB, "head", "truncate") }),
  meta("grep", { ...READ, resultBudget: budget(30 * KB, "head", "truncate") }),
  meta("find", { ...READ, resultBudget: budget(30 * KB, "head", "truncate") }),
  meta("ls", { ...READ, resultBudget: budget(30 * KB, "head", "truncate") }),
  // 注：曾登记过 glob，但项目与 Pi SDK 都没有该工具实现，也不在任何模式白名单里，
  // 属于"有元数据却调不到"的遗留条目，已移除（2026-11-01 收敛）。

  // ---- 交互 ----
  meta("ask_user", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "userInteraction",
    riskLevel: "low",
    needsApproval: false,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),

  // ---- 知识库 / 上下文 / 技能 ----
  meta("kb_search", { ...READ }),
  meta("kb_read", { ...READ }),
  meta("context_read", { ...READ }),
  meta("skills_search", { ...READ }),
  meta("skills_read", {
    ...READ,
    resultBudget: budget(20 * KB, "head", "truncate"),
    notes: "H2-4 开启时由调用方包 <skill_content> 并执行预算",
  }),
  // 2026-11-03：只写工作区 .oaw/skill-drafts，不写技能库；安装由用户确认。
  meta("skill_draft", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
    resultBudget: budget(4 * KB, "head", "truncate"),
    notes: "技能草稿；运行时按复杂任务与项目设置动态放行，安装需用户确认",
  }),

  // ---- 联网 ----
  meta("web_search", {
    ...READ,
    sideEffectScope: "network",
    resultBudget: budget(30 * KB, "head", "artifact"),
  }),
  meta("web_fetch", {
    ...READ,
    sideEffectScope: "network",
    resultBudget: budget(30 * KB, "head", "artifact"),
  }),

  // ---- 地图只读 ----
  meta("map_read", { ...READ }),
  meta("map_analyze", { ...READ, resultBudget: budget(30 * KB, "head", "artifact") }),
  meta("map_clear_analysis", { ...READ, sideEffectScope: "session" }),
  meta("map_datasets", { ...READ }),
  // 图层工程信息：只读（读图层注册表与工程元数据）。
  meta("map_layer_info", { ...READ, resultBudget: budget(30 * KB, "head", "artifact") }),

  // ---- 地图草稿层（2026-11-07 新流程）----
  // 草稿不进入正式库（layers/style/tiles/config），可随项目草稿目录丢弃，免审批。
  meta("map_draft_layer", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
    forceConfirm: false,
    patternSource: "input",
    resultBudget: budget(8 * KB, "head", "truncate"),
    notes: "生成/更新/删除草稿图层；只写 agent/drafts，不落正式库；正式固化需 map_fixate_layer",
  }),
  // 固化：草稿转正式图层（写 layers/tiles/config/style + 日志），必须逐次确认。
  meta("map_fixate_layer", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "input",
    denyPriority: 90,
    resultBudget: budget(8 * KB, "head", "truncate"),
    notes: "草稿固化为正式图层；auto 模式不得自动批准；共享数据集禁止写入",
  }),

  // ---- CAD（cadAgent 开关，默认关；关闭时不在任何模式白名单中）----
  meta("cad_read", { ...READ, resultBudget: budget(30 * KB, "head", "truncate") }),
  meta("cad_edit", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    patternSource: "path",
    denyPriority: 100,
    resultBudget: budget(4 * KB, "head", "truncate"),
    notes: "DXF/DWG 白名单修改；落盘前走 write 审批并记录写入清单",
  }),

  // ---- 文档 ----
  meta("officecli", {
    readOnly: false,
    destructive: true,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    patternSource: "command",
    denyPriority: 90,
    resultBudget: budget(30 * KB, "head", "artifact"),
    notes: "写类子命令默认 ask；读类子命令由规则表放行",
  }),

  // ---- 写入 ----
  meta("write", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    patternSource: "path",
    denyPriority: 100,
    resultBudget: budget(4 * KB, "head", "truncate"),
  }),
  meta("edit", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    patternSource: "path",
    denyPriority: 100,
    resultBudget: budget(4 * KB, "head", "truncate"),
  }),
  meta("review_copy", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    patternSource: "path",
    denyPriority: 100,
    resultBudget: budget(4 * KB, "head", "truncate"),
  }),
  meta("review_source_apply", {
    readOnly: false,
    destructive: true,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    patternSource: "path",
    denyPriority: 110,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),

  // ---- 命令 ----
  meta("bash", {
    readOnly: false,
    destructive: true,
    sideEffectScope: "system",
    riskLevel: "critical",
    needsApproval: true,
    patternSource: "command",
    denyPriority: 100,
    resultBudget: budget(30 * KB, "tail", "artifact"),
    notes: "无沙箱；删除/破坏类命令默认 ask",
  }),

  meta("map_template", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "input",
    resultBudget: budget(16 * KB, "head", "truncate"),
    notes: "生成 Word 报告并落盘，与 officecli create 同级需确认",
  }),

  // ---- 地图写入 ----
  meta("map_edit", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "input",
    denyPriority: 80,
    resultBudget: budget(8 * KB, "head", "truncate"),
    notes: "共享数据集改样式需确认；auto 模式不自动批准共享写入",
  }),
  meta("map_import", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "path",
    denyPriority: 90,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),
  meta("map_save_analysis", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "input",
    denyPriority: 90,
    resultBudget: budget(8 * KB, "head", "truncate"),
    notes: "兼容工具：保存分析为正式图层；新流程推荐 map_fixate_layer",
  }),
  // 重置图层树：level=baseline 会把基线后新增的正式层移入回收站，属破坏性写操作。
  meta("map_reset", {
    readOnly: false,
    destructive: true,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "input",
    denyPriority: 90,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),
  // 新建地图项目：写操作，需用户审批。
  meta("map_project_create", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    forceConfirm: true,
    patternSource: "input",
    denyPriority: 70,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),
  // 地图截图导出（2026-11-11-004）：写 agent/exports 产物文件，需用户审批；非破坏性。
  meta("map_export", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    forceConfirm: false,
    patternSource: "input",
    denyPriority: 70,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),

  // ---- 任务与记忆 ----
  meta("todo", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),
  meta("memory_update", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    resultBudget: budget(8 * KB, "head", "truncate"),
    notes: "只创建待审核建议，不直接写 MEMORY.md",
  }),
  meta("job_status", {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    resultBudget: budget(16 * KB, "head", "truncate"),
    notes: "读取后台任务状态/日志尾部；wait=true 时等待完成",
  }),
  meta("job_cancel", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "process",
    riskLevel: "medium",
    resultBudget: budget(4 * KB, "head", "truncate"),
    notes: "取消一个后台任务并终止其进程/CLI",
  }),

  // ---- 编排 ----
  meta("run_subagent", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
    resultBudget: budget(30 * KB, "head", "artifact"),
  }),
  // ---- Agent Teams（Team Lite，2026-11-04）----
  meta("team_list", {
    readOnly: true,
    destructive: false,
    sideEffectScope: "none",
    riskLevel: "low",
    resultBudget: budget(16 * KB, "head", "truncate"),
    notes: "只读团队 roster/任务板摘要",
  }),
  meta("team_wait", {
    readOnly: true,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    resultBudget: budget(16 * KB, "head", "truncate"),
    notes: "边沿触发等待团队变化；不修改团队",
  }),
  meta("team_spawn", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
    resultBudget: budget(16 * KB, "head", "truncate"),
    notes: "创建具名队友；队友写文件仍走各自审批",
  }),
  meta("team_send", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
    resultBudget: budget(8 * KB, "head", "truncate"),
    notes: "向队友投递消息；运行中排队、空闲时唤醒",
  }),
  meta("team_task", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
    resultBudget: budget(16 * KB, "head", "truncate"),
    notes: "共享任务板 CAS；仅内存状态，不写工作区文件",
  }),
  meta("editorial_pipeline", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
    patternSource: "input",
    denyPriority: 90,
    resultBudget: budget(16 * KB, "head", "truncate"),
  }),

  // ---- 创作画布（2026-11-09，仅 Work；开关 OAW_CREATIVE_CANVAS，默认关）----
  // 开关关闭时工具不进任何白名单，元数据也不登记（与反向覆盖测试一致）；
  // 开启后能力事实可追溯。cad_read/cad_edit 采用同样的门控约定。
  ...(RUNTIME_FLAGS.creativeCanvas
    ? [
      meta("canvas_read", {
        readOnly: true,
        sideEffectScope: "none",
        riskLevel: "low",
        resultBudget: budget(30 * KB, "head", "truncate"),
        notes: "只读画布索引/板/列表，不写工作区",
      }),
      meta("canvas_write", {
        readOnly: false,
        destructive: false,
        sideEffectScope: "workspace",
        riskLevel: "medium",
        needsApproval: false,
        resultBudget: budget(16 * KB, "head", "truncate"),
        notes: "写 designs/<slug> 画布文件（与 write 同类，受工作区边界与写锁约束）",
      }),
      meta("canvas_delete", {
        readOnly: false,
        destructive: true,
        sideEffectScope: "workspace",
        riskLevel: "high",
        needsApproval: true,
        forceConfirm: true,
        patternSource: "input",
        denyPriority: 90,
        resultBudget: budget(8 * KB, "head", "truncate"),
        notes: "软删除画布/画板到 .trash；auto 模式不得自动批准",
      }),
      meta("canvas_import", {
        readOnly: false,
        destructive: false,
        sideEffectScope: "workspace",
        riskLevel: "medium",
        needsApproval: true,
        patternSource: "path",
        denyPriority: 70,
        resultBudget: budget(8 * KB, "head", "truncate"),
        notes: "从工作区内已有 .dc.html 画布目录复制导入",
      }),
      meta("canvas_export", {
        readOnly: false,
        destructive: false,
        sideEffectScope: "workspace",
        riskLevel: "medium",
        needsApproval: true,
        patternSource: "input",
        denyPriority: 60,
        resultBudget: budget(8 * KB, "head", "truncate"),
        notes: "导出 SVG/PNG/PDF/PPTX 到 designs/<slug>/exports",
      }),
    ]
    : []),

  // ---- 内置浏览器 ----
  meta("browser_open", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "medium", resultBudget: budget(16 * KB, "head", "truncate") }),
  meta("browser_snapshot", { readOnly: true, sideEffectScope: "none", riskLevel: "low", resultBudget: budget(30 * KB, "head", "artifact") }),
  meta("browser_click", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "medium" }),
  meta("browser_type", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "medium" }),
  meta("browser_press", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "medium" }),
  meta("browser_scroll", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "low" }),
  meta("browser_screenshot", { readOnly: true, sideEffectScope: "none", riskLevel: "low", resultBudget: budget(16 * KB, "head", "truncate") }),
  meta("browser_tabs", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "low" }),
  meta("browser_back", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "low" }),
  meta("browser_close", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "low" }),
  // ---- 内置浏览器原子工具族（Proma 对标 opt-in）----
  // browser_wait_for：只观察页面状态，不执行脚本，不改页面。
  meta("browser_wait_for", { readOnly: true, sideEffectScope: "none", riskLevel: "low", resultBudget: budget(16 * KB, "head", "truncate") }),
  // browser_act：点击并等待，与 browser_click 同语义。
  meta("browser_act", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "medium" }),
  // browser_extract：抽取页面正文/区域文本，与 browser_snapshot 同语义。
  meta("browser_extract", { readOnly: true, sideEffectScope: "none", riskLevel: "low", resultBudget: budget(16 * KB, "head", "truncate") }),
  // browser_select_option：操作原生 select，与 browser_click 同语义。
  meta("browser_select_option", { readOnly: false, destructive: false, sideEffectScope: "network", riskLevel: "medium" }),
]);

const UNKNOWN = Object.freeze({
  name: "unknown",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  sideEffectScope: "userInteraction",
  riskLevel: "high",
  needsApproval: true,
  permission: { patternSource: "input", denyPriority: 100 },
  resultBudget: budget(30 * KB, "head", "artifact"),
  notes: "未知工具按最保守策略处理",
  unknown: true,
});

export const TOOL_NAMES = Object.freeze([...METADATA.keys()]);

export function getToolMetadata(name) {
  return METADATA.get(String(name || "")) || { ...UNKNOWN, name: String(name || "unknown") };
}

export function listToolMetadata() {
  return [...METADATA.values()];
}

/**
 * 校验工具名集合与元数据是否一致。
 * @param {string[]} toolNames 模式白名单/动态工具名
 * @returns {{ok:boolean, missing:string[], extra:string[], errors:string[]}}
 */
export function validateToolMetadata(toolNames = []) {
  const names = [...new Set((Array.isArray(toolNames) ? toolNames : []).map(String).filter(Boolean))];
  const known = new Set(TOOL_NAMES);
  const missing = names.filter((name) => !known.has(name) && !name.startsWith("mcp_"));
  // MCP 工具是动态的，不要求在静态表里；但必须有保守默认值。
  const extra = TOOL_NAMES.filter((name) => !names.includes(name));
  const errors = [];
  for (const item of METADATA.values()) {
    if (!item.sideEffectScope) errors.push(`${item.name}: 缺少 sideEffectScope`);
    if (!item.riskLevel) errors.push(`${item.name}: 缺少 riskLevel`);
    if (!item.resultBudget || !Number.isFinite(item.resultBudget.maxInlineBytes)) errors.push(`${item.name}: 缺少 resultBudget`);
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, extra, errors };
}

export function metadataCoverageReport(toolNames = []) {
  const result = validateToolMetadata(toolNames);
  return {
    ...result,
    total: TOOL_NAMES.length,
    covered: (Array.isArray(toolNames) ? toolNames : []).filter((name) => METADATA.has(String(name))).length,
  };
}

/** 读取某工具的结果预算；未知工具用保守默认值。 */
export function resultBudgetFor(name) {
  return getToolMetadata(name).resultBudget;
}
