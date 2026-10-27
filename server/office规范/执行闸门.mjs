/**
 * Office 执行闸门（计划 008 / P0-1、P0-2）。
 *
 * 目的：把"必须走编辑流水线、必须先澄清"从提示词建议变成工具边界的硬约束。
 * 只在 OAW_OFFICE_FORMAT 开启、且当前 Run 的路由是 template/generate 时生效；
 * 关闭开关或非写作路由时完全放行，行为与基线一致。
 */

const OFFICE_BINARY = /\.(?:docx|pptx)$/i;
const SCRIPT_FILE = /\.(?:mjs|cjs|js|py)$/i;
const READONLY_OFFICECLI = new Set(["view", "get", "query", "validate", "dump", "help", "watch", "unwatch", "save", "close", "refresh"]);
const MUTATING_OFFICECLI = new Set(["create", "add", "set", "batch", "import", "remove", "move", "swap", "delete"]);

/** bash 只读特征：允许这些命令在写作路由下读取文档。 */
const READONLY_BASH = [
  /^\s*(?:ls|dir|cat|type|head|tail|wc|grep|rg|find|where|which|pwd|echo)\b/i,
  /\bunzip\s+(?:-p|-l)\b/i,
  /\bnode\s+-e\s+["'][^"']*(?:readFile|JSZip|loadAsync|console\.log)[^"']*["']/i,
  /\bpython\s+-c\s+["'][^"']*(?:zipfile|print)[^"']*["']/i,
];

/** bash 文档生成特征：命中即视为绕过管线。 */
const DOCX_GENERATION = [
  /\bnode\b[^\n]*\b[\w./-]+\.(?:mjs|cjs|js)\b/i,
  /\bpython3?\b[^\n]*\b[\w./-]+\.py\b/i,
  /\bnode\s+-e\b[\s\S]*(?:pptxgenjs|Packer|Presentation|writeFileSync|createWriteStream)/i,
  /\bpython3?\s+-c\b[\s\S]*(?:from\s+pptx|import\s+pptx|docx\.Document|Presentation\s*\()/i,
  /\bpython\b[^\n]*\bdocx\b/i,
  /\bpandoc\b[^\n]*\.(?:docx|pptx)/i,
  /\b(?:soffice|libreoffice)\b[^\n]*(?:--convert|--headless)/i,
  /(?:^|[^|])(?:>|>>)\s*[^\n]*\.(?:docx|pptx)\b/i,
  /\b(?:cp|copy|mv|move|zip|tar)\b[^\n]*\.(?:docx|pptx)\b/i,
  /\bunzip\b(?!\s+(?:-p|-l))/i,
  /\bofficecli\b/i,
];

function allow(sanitizedInput) {
  return sanitizedInput ? { blocked: false, sanitizedInput } : { blocked: false };
}

function block(code, reason, suggestion) {
  return { blocked: true, code, reason, suggestion };
}

/** 去掉逃逸标记（--allow-manual / # allow-manual）。 */
export function stripAllowManual(text) {
  return String(text || "")
    .replace(/--allow-manual\b/g, "")
    .replace(/#\s*allow-manual\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hasAllowManual(text) {
  return /--allow-manual\b|#\s*allow-manual\b/i.test(String(text || ""));
}

/** 写文件特征：重定向、writeFile、Packer、generateAsync、save()。 */
const WRITE_INDICATORS = /(?:^|\s)>{1,2}\s*[^\s|&]|writeFile|writeFileSync|Packer|generateAsync|createWriteStream|\.save\s*\(/i;

export function isReadonlyBash(command) {
  const text = String(command || "").trim();
  if (!text) return true;
  if (isDocxGenerationCommand(text)) return false;
  if (WRITE_INDICATORS.test(text)) return false;
  return READONLY_BASH.some((pattern) => pattern.test(text));
}

export function isDocxGenerationCommand(command) {
  const text = String(command || "");
  if (!text.trim()) return false;
  // 写 Office 二进制（重定向/写文件 API）+ 目标 .docx/.pptx
  if (WRITE_INDICATORS.test(text) && OFFICE_BINARY.test(text)) return true;
  return DOCX_GENERATION.some((pattern) => pattern.test(text));
}

function officecliCommand(args) {
  const text = String(args || "").trim();
  if (!text) return "";
  return text.split(/\s+/)[0].toLowerCase();
}

export function isMutatingOfficecli(args) {
  const command = officecliCommand(args);
  return MUTATING_OFFICECLI.has(command);
}

function isMarkdownImport(args) {
  return /\badd\b[\s\S]*--type\s+markdown\b/i.test(String(args || ""));
}

function isWriteTool(tool, input = {}) {
  if (tool === "write" || tool === "edit") return true;
  if (tool === "editorial_pipeline") return true;
  if (tool === "officecli") return isMutatingOfficecli(input.args);
  if (tool === "bash") return !isReadonlyBash(input.command);
  return false;
}

/**
 * 工具调用分类。
 * @param {object} input
 * @param {"bash"|"officecli"|"write"|"edit"|"editorial_pipeline"|"ask_user"|string} input.tool
 * @param {object} [input.input] 工具入参（bash: {command}；officecli: {args}；write/edit: {path}）
 * @param {object} [input.context] { route, officeFormat, pipelineProduced, clarificationPending, mode }
 * @returns {{blocked:boolean, code?:string, reason?:string, suggestion?:string, sanitizedInput?:object}}
 */
export function classifyToolCall({ tool = "", input = {}, context = {} } = {}) {
  const { route, officeFormat, pipelineProduced = false, clarificationPending = null, mode = "agent", manualAllowed = false } = context;

  // 开关关闭 / 非写作路由 / Chat / Review：完全放行
  if (!officeFormat) return allow();
  if (mode === "chat" || mode === "review") return allow();
  if (route !== "template" && route !== "generate" && route !== "edit") return allow();

  // 澄清前置（P0-2）：先问再写；只读工具与 ask_user 不受影响
  if (clarificationPending && isWriteTool(tool, input)) {
    const question = clarificationPending.question?.text || "请先确认文档类型、篇幅、受众等关键信息";
    const options = Array.isArray(clarificationPending.question?.options) ? clarificationPending.question.options : [];
    return block(
      "CLARIFICATION_REQUIRED",
      `本轮关键信息不足，必须先调用 ask_user 提问：${question}`,
      options.length ? `可选：${options.join(" / ")}` : "收到用户回答后再继续写操作。",
    );
  }

  // 用户明确要求"脚本/手工生成"时放行（逃逸阀）
  if (manualAllowed) return allow();

  // 编辑路由不强制管线（保留 OfficeCLI 精确定位）
  if (route === "edit") return allow();

  // P0-1：模板/生成路由强制走编辑流水线
  if (tool === "bash") {
    const command = String(input.command || "");
    if (hasAllowManual(command)) return allow({ command: stripAllowManual(command) });
    if (isDocxGenerationCommand(command)) {
      return block(
        "OFFICE_PIPELINE_REQUIRED",
        "写作路由下禁止用 bash 生成/转换 Office 文档（node 生成脚本、python-docx、pandoc、重定向、officecli）。",
        "请改用 editorial_pipeline：它会按模板/场景直写 docx，并自动做目录、页码与规则闸门。",
      );
    }
    return allow();
  }

  if (tool === "officecli") {
    const args = String(input.args || "");
    if (hasAllowManual(args)) return allow({ args: stripAllowManual(args) });
    if (isMarkdownImport(args)) {
      return block(
        "OFFICE_PIPELINE_REQUIRED",
        "写作路由下禁止用 officecli add --type markdown 转换后手工调样式。",
        "已有 Markdown 时请用 editorial_pipeline 的 sourceMarkdown，让管线统一排版与验收。",
      );
    }
    if (isMutatingOfficecli(args) && !pipelineProduced) {
      return block(
        "OFFICE_PIPELINE_REQUIRED",
        "文档尚未由编辑流水线生成，禁止直接用 officecli 创建或改样式。",
        "先调用 editorial_pipeline 生成初稿；生成后再用 officecli 做精修。",
      );
    }
    return allow();
  }

  if (tool === "write" || tool === "edit") {
    const file = String(input.path || "");
    if (OFFICE_BINARY.test(file)) {
      return block(
        "OFFICE_PIPELINE_REQUIRED",
        "禁止直接写 Office 二进制文件。",
        "请用 editorial_pipeline 生成 docx/pptx。",
      );
    }
    if (SCRIPT_FILE.test(file)) {
      return block(
        "OFFICE_PIPELINE_REQUIRED",
        "写作路由下禁止写文档生成脚本（.mjs/.cjs/.js/.py）。",
        "请改用 editorial_pipeline；如确需脚本，请在需求中明确写“脚本/手工生成”以启用逃逸。",
      );
    }
  }

  return allow();
}

export const GATE_CODES = Object.freeze({
  PIPELINE_REQUIRED: "OFFICE_PIPELINE_REQUIRED",
  CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
});
