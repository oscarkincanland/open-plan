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

const KB = 1024;

function budget(maxInlineBytes, direction = "head", strategy = "artifact") {
  return {
    maxInlineBytes,
    maxModelBytes: maxInlineBytes,
    strategy,
    preview: { direction },
  };
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
    permission: {
      patternSource: options.patternSource || (options.needsApproval ? "input" : "none"),
      denyPriority: Number(options.denyPriority || 0),
    },
    resultBudget: options.resultBudget || budget(30 * KB, "head", options.readOnly ? "truncate" : "artifact"),
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

  meta("map_template", { readOnly: false, destructive: false, sideEffectScope: "session", riskLevel: "low", resultBudget: budget(16 * KB, "head", "truncate") }),

  // ---- 地图写入 ----
  meta("map_edit", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    patternSource: "input",
    denyPriority: 80,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),
  meta("map_import", {
    readOnly: false,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
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
    patternSource: "input",
    denyPriority: 90,
    resultBudget: budget(8 * KB, "head", "truncate"),
  }),
  // 重置图层树：level=baseline 会把基线后新增的正式层移入回收站，属破坏性写操作。
  meta("map_reset", {
    readOnly: false,
    destructive: true,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
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
