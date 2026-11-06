/**
 * Office CLI 调用规约（计划 2026-11-05-017）。
 *
 * 唯一判定源：模式 × 路由 × 命令 × 流水线状态。
 * 能力计划、系统提示词、执行闸门与测试都从这里读取，避免三套规则漂移。
 */

/** 明确只读：不改变文档内容，也不落盘。unknown 命令一律按写处理。 */
export const READONLY_OFFICECLI = Object.freeze(new Set([
  "view", "get", "query", "validate", "dump", "help", "watch", "unwatch",
]));

/** 明确写命令，仅用于文档/测试与可读性；判定以 READONLY 白名单为准。 */
export const MUTATING_OFFICECLI = Object.freeze(new Set([
  "create", "add", "set", "batch", "import", "remove", "move", "swap", "delete", "save", "close",
]));

export function officecliCommand(args) {
  const text = String(args || "").trim();
  if (!text) return "";
  return text.split(/\s+/)[0].toLowerCase();
}

/** 未知子命令按写处理：不能因为新命令没登记就默认放行。 */
export function isMutatingOfficecli(args) {
  const command = officecliCommand(args);
  if (!command) return false;
  return !READONLY_OFFICECLI.has(command);
}

export function isMarkdownImport(args) {
  return /\badd\b[\s\S]*--type\s+markdown\b/i.test(String(args || ""));
}

function decision({ visible = true, preflight = "none", command = "", allowed = true, code = null, reason = "", suggestion = "" } = {}) {
  const readOnly = Boolean(command) && READONLY_OFFICECLI.has(command);
  const mutating = Boolean(command) && !readOnly;
  return {
    visible,
    preflight,
    command,
    readOnly,
    mutating,
    allowed,
    code,
    reason,
    suggestion,
  };
}

function block(code, reason, suggestion = "", extra = {}) {
  return decision({ allowed: false, code, reason, suggestion, ...extra });
}

/**
 * @param {object} input
 * @param {string} input.mode  chat / office / agent / review
 * @param {string} input.route read / edit / template / generate
 * @param {string} [input.command] officecli 子命令（view/get/set/...）
 * @param {string} [input.args] 完整参数（用于识别 add --type markdown）
 * @param {boolean} [input.pipelineProduced]
 * @param {object|null} [input.clarificationPending]
 * @param {boolean} [input.manualAllowed] 用户明确要求脚本/手工生成
 * @returns {{visible:boolean,preflight:"blocking"|"lazy"|"none",command:string,readOnly:boolean,mutating:boolean,allowed:boolean,code:string|null,reason:string,suggestion:string}}
 */
export function officeCliPolicy({
  mode = "agent",
  route = "read",
  command = "",
  args = "",
  pipelineProduced = false,
  clarificationPending = null,
  manualAllowed = false,
} = {}) {
  const normalizedMode = String(mode || "agent").trim();
  const normalizedRoute = String(route || "read").trim();
  const cmd = String(command || "").trim().toLowerCase();

  // Chat 不暴露 officecli；即使被误调用也拒绝。
  if (normalizedMode === "chat") {
    return block("OFFICE_TOOL_UNAVAILABLE", "Chat 只读模式不提供 Office CLI。", "需要处理 Office 文档请切换到 Work。", {
      visible: false,
      preflight: "none",
      command: cmd,
    });
  }

  // Review 使用 officecli 做批注/副本；原文写回由 assertReviewWriteAllowed 单独把关。
  if (normalizedMode === "review") {
    return decision({ visible: true, preflight: "none", command: cmd });
  }

  // 用户明确要求“脚本/手工生成”时放行写操作（逃逸阀；仍走写锁与审批）。
  if (manualAllowed) {
    return decision({ visible: true, preflight: "none", command: cmd });
  }

  if (normalizedRoute === "edit") {
    return decision({ visible: true, preflight: "blocking", command: cmd });
  }

  if (normalizedRoute === "template" || normalizedRoute === "generate") {
    const preflight = "lazy";
    if (!isMutatingOfficecli(args) && !isMutatingOfficecli(cmd)) {
      return decision({ visible: true, preflight, command: cmd });
    }
    if (clarificationPending) {
      const question = clarificationPending?.question?.text || "请先确认文档类型、篇幅、受众等关键信息";
      const options = Array.isArray(clarificationPending?.question?.options) ? clarificationPending.question.options : [];
      return block("CLARIFICATION_REQUIRED", `本轮关键信息不足，必须先调用 ask_user 提问：${question}`, options.length ? `可选：${options.join(" / ")}` : "收到用户回答后再继续写操作。", {
        visible: true,
        preflight,
        command: cmd,
      });
    }
    if (isMarkdownImport(args)) {
      return block("OFFICE_PIPELINE_REQUIRED", "写作路由下禁止用 officecli add --type markdown 转换后手工调样式。", "已有 Markdown 时请用 editorial_pipeline 的 sourceMarkdown，让管线统一排版与验收。", {
        visible: true,
        preflight,
        command: cmd,
      });
    }
    if (!pipelineProduced) {
      return block("OFFICE_PIPELINE_REQUIRED", "文档尚未由编辑流水线生成，禁止直接用 officecli 创建或改样式。", "先调用 editorial_pipeline 生成初稿；生成后再用 officecli 做精修。", {
        visible: true,
        preflight,
        command: cmd,
      });
    }
    return decision({ visible: true, preflight, command: cmd });
  }

  // read / 未知路由：只读放行，写拒绝。未知路由按 read 处理，避免无约束写入。
  if (isMutatingOfficecli(args) || isMutatingOfficecli(cmd)) {
    return block("OFFICE_READONLY_ONLY", "当前是只读查看；写命令需要明确的编辑意图和既有 Office 文件。", "要修改请明确说“修改/编辑/替换/删除/批注”，系统会切到 edit 路由。", {
      visible: true,
      preflight: "none",
      command: cmd,
    });
  }
  return decision({ visible: true, preflight: "none", command: cmd });
}
