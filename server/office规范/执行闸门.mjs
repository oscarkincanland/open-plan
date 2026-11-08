/**
 * Office 执行闸门（计划 008 / P0-1、P0-2；2026-11-05-017 收敛）。
 *
 * 目的：把“必须走编辑流水线、必须先澄清、read 路由只读”从提示词建议变成
 * 工具边界的硬约束。Office CLI 的命令级判定统一由 OfficeCLI调用规约.mjs 提供。
 */
import { officeCliPolicy, isMutatingOfficecli, officecliCommand } from "./OfficeCLI调用规约.mjs";

const OFFICE_BINARY = /\.(?:docx|pptx)$/i;
const SCRIPT_FILE = /\.(?:mjs|cjs|js|py)$/i;

export { isMutatingOfficecli } from "./OfficeCLI调用规约.mjs";

/** bash 只读命令白名单（逐段判定，见 bashSegmentIsReadonly）。 */
const READONLY_BASH_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "rg", "find",
  "where", "which", "pwd", "echo", "diff", "cmp", "stat", "file",
  "sha256sum", "md5sum", "uniq", "cut", "tr", "jq",
  "realpath", "basename", "dirname",
]);

/** 明确的写命令：出现在命令链里就不能按只读处理。 */
const MUTATING_BASH_COMMANDS = new Set([
  "rm", "del", "erase", "rmdir", "rd", "mv", "move", "cp", "copy", "mkdir", "md",
  "touch", "chmod", "chown", "ln", "dd", "truncate", "tee", "sed", "awk", "tar",
  "zip", "python", "python3", "node", "npm", "npx", "pnpm", "yarn", "git",
  "curl", "wget", "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "xargs",
  "install", "apt", "apt-get", "yum", "choco", "setx", "reg", "attrib", "icacls",
  "mklink", "rename", "cpio", "rsync", "scp", "sftp", "make",
]);

/**
 * git 只读子命令白名单（2026-11-04 并发写锁修复）。
 *
 * 背景：git/node/python 此前一律按写命令处理，连 `git --version`、`git status`、
 * `command -v git` 都会去抢工作区写锁；并发任务持锁时这些纯查询要白等 20 秒后
 * 被「写入范围与其他任务冲突」拒绝，用户侧表现为“并行时什么命令都跑不动”。
 * 这里按子命令细分：只读查询直接放行，其余（clone/push/pull/commit/…）仍按写
 * 处理，由写锁推导（server/bash写锁.mjs）锁到真实目标。
 */
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "rev-list", "describe", "shortlog",
  "blame", "ls-files", "ls-remote", "cat-file", "name-rev", "for-each-ref", "grep",
  "--version", "version",
]);

/** 透明前缀：本身不改文件，跳过后看真正的命令。 */
const BASH_COMMAND_PREFIXES = new Set(["sudo", "env", "command", "nohup", "time", "nice", "stdbuf"]);

/**
 * 把命令链按管道/逻辑连接符拆成若干段，逐段判定首命令。
 * 目的：避免 `ls; rm -rf x`、`cat a | tee b` 这类"只读命令在前、写命令在后"的组合
 * 被整体当成只读。无法解析时返回 null（按写处理）。
 */
export function bashCommandSegments(command) {
  const text = String(command || "").trim();
  if (!text) return [];
  // 先剥掉引号内的连接符，避免把字符串内容当成命令分隔符。
  const masked = text
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
  return masked
    .split(/\|\||&&|\||;|\n|&/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 取一段命令的首个有效命令名（跳过环境变量赋值与透明前缀）。 */
export function bashSegmentCommand(segment) {
  let text = String(segment || "").trim();
  if (!text) return null;
  const tokens = text.split(/\s+/);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    if (BASH_COMMAND_PREFIXES.has(token.toLowerCase())) { index += 1; continue; }
    break;
  }
  const command = tokens[index];
  if (!command) return null;
  return command.replace(/^["']|["']$/g, "").toLowerCase();
}

/**
 * 命令链里是否出现明确的写命令。
 * 只看首命令无法覆盖 `ls; rm -rf x` 这类写法，因此逐段检查。
 */
export function bashChainHasMutatingCommand(command) {
  for (const segment of bashCommandSegments(command)) {
    if (!bashSegmentIsReadonly(segment)) return true;
  }
  return false;
}

/**
 * 单段命令是否只读。
 *
 * 判定口径（保守优先）：
 *   - 明确只读命令 → 只读；
 *   - 明确写命令 → 写；
 *   - 其余（无法确认）→ 按写处理。
 * 宁可多占一次工作区锁（并发稍慢），不可把写命令当成只读（并发写冲突）。
 */
function bashSegmentIsReadonly(segment) {
  const text = String(segment || "");
  // bash 内建只读查询：command -v X / command -V X（透明前缀会在 bashSegmentCommand
  // 里被跳过，导致误把 -v 当成命令名，这里先单独识别）。
  if (/^\s*(?:sudo\s+|env\s+)*command\s+-[vV]\s+\S+/.test(text)) return true;
  const name = bashSegmentCommand(segment);
  if (!name) return false; // 解析不了 → 按写处理
  // 内联只读脚本（node -e 只读 / python -c 只读）沿用既有放行口径。
  if (isInlineReadonlyScript(segment)) return true;
  // git 只读子命令：status/log/diff/show/rev-parse/… 与 --version 直接放行。
  if (name === "git") {
    const sub = text.match(/^\s*(?:sudo\s+|env\s+)*git\s+([A-Za-z-]+)/)?.[1]?.toLowerCase() || "";
    return GIT_READONLY_SUBCOMMANDS.has(sub);
  }
  // node / python 的纯版本查询（不执行脚本）。
  if (name === "node" || name === "nodejs") {
    return /^\s*(?:sudo\s+|env\s+)*node(?:js)?\s+(?:--version|-v)\s*$/.test(text);
  }
  if (name === "python" || name === "python3" || name === "py") {
    return /^\s*(?:sudo\s+|env\s+)*py(?:thon3?)?\s+(?:--version|-V|-v)\s*$/.test(text);
  }
  // 包管理器的只读查询（版本 / 本地列表 / 远端元信息）。
  if (["npm", "pnpm", "yarn", "npx"].includes(name)) {
    return /^\s*(?:sudo\s+|env\s+)*(?:npm|pnpm|yarn|npx)\s+(?:--version|-v|ls|list|view|info)\b/.test(text);
  }
  if (MUTATING_BASH_COMMANDS.has(name)) return false;
  // unzip 只有 -p/-l 是只读（解到标准输出），其余形式会落盘。
  if (name === "unzip") return /-(?:p|l)\b/.test(segment);
  if (!READONLY_BASH_COMMANDS.has(name)) return false;
  // find 的 -delete/-exec 等形式仍可能改文件，这里保守排除。
  if (name === "find" && /-(?:delete|exec|execdir|ok)\b/.test(segment)) return false;
  return true;
}

/**
 * 命令链是否整条只读：每一段的首命令都在只读白名单里。
 */
export function bashChainIsReadonly(command) {
  const segments = bashCommandSegments(command);
  if (!segments.length) return false;
  return segments.every((segment) => bashSegmentIsReadonly(segment));
}

/** node -e / python -c 的只读内联脚本（Office 闸门既有放行口径）。 */
function isInlineReadonlyScript(segment) {
  const text = String(segment || "");
  if (/\bnode\s+-e\s+["'][^"']*(?:readFile|JSZip|loadAsync|console\.log)[^"']*["']/i.test(text)) return true;
  if (/\bpython\s+-c\s+["'][^"']*(?:zipfile|print)[^"']*["']/i.test(text)) return true;
  return false;
}

/** bash 文档生成特征：命中即视为绕过管线。
 *  2026-11-08 D1：收窄——不再把任意 `python *.py` / `node *.mjs` 当 Office 生成；
 *  只有脚本名/参数指向 Office 目标、或同一命令出现 Office 库特征时才拦截。
 *  这样技能脚本（数据分析、格式转换）与普通 Node 构建不再被误伤。 */
const DOCX_GENERATION = [
  // 内联脚本 + Office 库
  /\bnode\s+-e\b[\s\S]*(?:pptxgenjs|Packer|Presentation|writeFileSync|createWriteStream)/i,
  /\bpython3?\s+-c\b[\s\S]*(?:from\s+pptx|import\s+pptx|docx\.Document|Presentation\s*\()/i,
  // 脚本文件名里带 Office 关键词（build_ppt.py / make_docx.mjs / report_gen.py）
  /\bnode\b[^\n]*\b[\w./-]*(?:docx|pptx|ppt|xlsx|excel|word|office|report|slide|deck)[\w./-]*\.(?:mjs|cjs|js)\b/i,
  /\bpython3?\b[^\n]*\b[\w./-]*(?:docx|pptx|ppt|xlsx|excel|word|office|report|slide)[\w./-]*\.py\b/i,
  // 脚本命令同一行出现 Office 目标扩展名
  /\b(?:node|python3?)\b[^\n]*\.(?:mjs|cjs|js|py)\b[^\n]*\.(?:docx|pptx|xlsx)\b/i,
  // 脚本命令同一行出现 Office 关键词（如 python build.py # docx）
  /\b(?:node|python3?)\b[^\n]*\.(?:mjs|cjs|js|py)\b[^\n]*\b(?:docx|pptx|xlsx)\b/i,
  // 脚本 + Office 库特征出现在同一命令
  /\b(?:node|python3?)\b[^\n]*\.(?:mjs|cjs|js|py)\b[\s\S]*(?:python-docx|pptxgenjs|openpyxl|docx\.Document|Packer)/i,
  /\bpandoc\b[^\n]*\.(?:docx|pptx)/i,
  /\b(?:soffice|libreoffice)\b[^\n]*(?:--convert|--headless)/i,
  /(?:^|[^|])(?:>|>>)\s*[^\n]*\.(?:docx|pptx|xlsx)\b/i,
  // 复制/移动/打包不是“生成 docx”：复制走 review_copy 或普通拷贝，不应被管线闸门拦截。
  /\bunzip\b(?!\s+(?:-p|-l))/i,
  /\bofficecli\b/i,
];

/** 命令是否引用了显式技能目录下的脚本（D1 技能白名单通道）。 */
export function referencesSkillScript(command, roots = []) {
  const text = String(command || "").replace(/\\/g, "/");
  if (!text || !Array.isArray(roots) || !roots.length) return false;
  if (!/\.(?:py|mjs|cjs|js)\b/i.test(text)) return false;
  return roots.some((root) => {
    const normalized = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized && text.includes(normalized);
  });
}

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
  // 逐段判定整条命令链：任一段不是明确只读 → 整条按写处理。
  // 修复：`ls; rm -rf x`、`cat a | tee b`、`find . -delete` 这类"只读在前、
  // 写操作在后"的组合，此前会因为首个命令只读而被判为只读，从而不占工作区写锁。
  return bashChainIsReadonly(text);
}

export function isDocxGenerationCommand(command) {
  const text = String(command || "");
  if (!text.trim()) return false;
  // 写 Office 二进制（重定向/写文件 API）+ 目标 .docx/.pptx
  if (WRITE_INDICATORS.test(text) && OFFICE_BINARY.test(text)) return true;
  return DOCX_GENERATION.some((pattern) => pattern.test(text));
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

  // Office CLI 的判定不再依赖 officeFormat 开关：read 路由必须只读，edit 路由放行，
  // template/generate 才受澄清与流水线约束。这样“开关关闭”不会变成写入后门。
  if (tool === "officecli") {
    const args = String(input.args || "");
    if (hasAllowManual(args)) return allow({ args: stripAllowManual(args) });
    const policy = officeCliPolicy({
      mode,
      route,
      command: officecliCommand(args),
      args,
      pipelineProduced,
      clarificationPending,
      manualAllowed,
    });
    if (!policy.allowed) return block(policy.code, policy.reason, policy.suggestion);
    return allow();
  }

  // 非 Office CLI 工具：开关关闭 / 非写作路由 / Chat / Review 完全放行（基线行为）。
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
    // D1：显式技能调用时，放行技能目录下的脚本（产物仍走 validate / 规则闸门）。
    const skillExec = context.skillExec || null;
    if (skillExec?.allowed && referencesSkillScript(command, skillExec.roots || [])) {
      return { blocked: false, skillExec: true };
    }
    if (isDocxGenerationCommand(command)) {
      return block(
        "OFFICE_PIPELINE_REQUIRED",
        "写作路由下禁止用 bash 生成/转换 Office 文档（node 生成脚本、python-docx、pandoc、重定向、officecli）。",
        "请改用 editorial_pipeline：它会按模板/场景直写 docx，并自动做目录、页码与规则闸门。",
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
