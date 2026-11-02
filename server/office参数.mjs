import fs from "node:fs";
import path from "node:path";

/**
 * officecli 工具的参数处理（纯函数，便于单测）：
 * 这些细节都踩过坑——模型照抄说明里的转义引号会被切坏、暂存文件引用写成 key=value
 * 时物化不出来、officecli 不会创建输出目录。
 */

// 模型经常照抄说明里的转义写法（--prop author=\"规聚 Agent\"）。普通正则分词会把
// author=\"规聚 和 Agent\" 切成两个 token，officecli 就报 Invalid --prop 'Agent"': expected key=value
//（实测发生过）。这里手写分词：普通引号与反斜杠转义引号都当引号分隔符，且丢掉多余的反斜杠。
export function parseOfficeArgs(input) {
  const text = String(input || "");
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  const flush = () => {
    if (started) args.push(current);
    current = "";
    started = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\" && (next === '"' || next === "'")) {
      if (quote === next) quote = null;
      else if (!quote) { quote = next; started = true; }
      else current += next;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (!quote) { quote = ch; started = true; }
      else current += ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) { flush(); continue; }
    current += ch;
    started = true;
  }
  flush();
  return joinPropValues(args);
}

// 模型也常把带空格的 prop 值裸写（--prop author=规聚 Agent，不加引号）。
// officecli 的一个 --prop 只吃一个参数，被空格切开就会报 Invalid --prop 'Agent': expected key=value（实测发生过）。
// 这里把 --prop 之后"不像新选项、也不像 key=value"的 token 并回同一个值。
function joinPropValues(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token !== "--prop" || i + 1 >= args.length) { out.push(args[i]); continue; }
    let value = String(args[i + 1]);
    i += 1;
    while (i + 1 < args.length) {
      const next = String(args[i + 1]);
      if (next.startsWith("-") || next.includes("=")) break;
      value += ` ${next}`;
      i += 1;
    }
    out.push(token, value);
  }
  return out;
}

// 参数里引用的文件可能写成 key=value（--prop src=报告.md、--prop path=数据.json），
// 也可能带引号残留。先剥掉 key= 前缀再判断，否则物化时会去找一个叫 "src=报告.md" 的路径，
// 暂存文件永远物化不出来，officecli 报 "markdown source file not found"（实测发生过）。
//
// N-06 扩展：--prop 之后的值必须单独抽取（--prop image=figs/a.svg 的值不会被
// looksLikePath 命中，因为整个 token 以 "--prop" 开头而值在下一个 token）；
// 扩展名补 svg/gif/bmp/tiff（实测 .work/figs/test.svg 找不到）。
const REFERENCE_EXT = /\.(docx|xlsx|pptx|json|md|markdown|txt|csv|xml|html|png|jpe?g|gif|bmp|tiff?|svg|pbf)$/i;

/** 已知会承载文件引用的 prop 键。 */
const REFERENCE_PROP_KEYS = new Set(["src", "source", "path", "file", "image", "attachment", "attachments", "input", "output", "from", "to"]);

/** 剥掉包裹值的一层引号（模型常把路径写成 src="ch01.md"）。 */
function stripQuotes(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

export function collectReferencedPaths(args = []) {
  const out = [];
  const stripKey = (value) => {
    const text = String(value || "").trim();
    const match = text.match(/^[A-Za-z_][A-Za-z0-9_-]{0,24}=(.+)$/);
    return match ? match[1].trim() : text;
  };
  const looksLikePath = (value) => {
    const text = stripQuotes(stripKey(value));
    if (!text || text.startsWith("-") || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) return false;
    return REFERENCE_EXT.test(text);
  };
  const list = Array.isArray(args) ? args : [];
  // 只有 create 的目标文件（args[1]）不是"引用"——它本来就尚不存在，当引用会把
  // 预检误判成"文件缺失"并阻断 create。add/set/batch 的目标是既有文档，物化它
  // 无害且历史契约要求把它算作引用（Review 报错修复回归测试依赖这一点）。
  const targetIndex = String(list[0] || "").toLowerCase() === "create" ? 1 : -1;
  list.forEach((token, index) => {
    const text = String(token);
    if (index === targetIndex) return;
    if (text === "--input") {
      const next = list[index + 1];
      if (next) out.push(stripQuotes(stripKey(next)));
      return;
    }
    // --prop <key>=<value>：只有已知引用键才当文件引用，避免把 --prop bold=true 当路径。
    if (text === "--prop") {
      const next = String(list[index + 1] || "");
      const eq = next.indexOf("=");
      if (eq > 0) {
        const key = next.slice(0, eq).trim().toLowerCase();
        const value = stripQuotes(next.slice(eq + 1).trim());
        if (REFERENCE_PROP_KEYS.has(key) && value && looksLikePath(value)) out.push(value);
      }
      return;
    }
    // --prop key=value 写成一个 token 的形态。
    if (text.startsWith("--prop=")) {
      const next = text.slice("--prop=".length);
      const eq = next.indexOf("=");
      if (eq > 0) {
        const key = next.slice(0, eq).trim().toLowerCase();
        const value = stripQuotes(next.slice(eq + 1).trim());
        if (REFERENCE_PROP_KEYS.has(key) && value && looksLikePath(value)) out.push(value);
      }
      return;
    }
    if (looksLikePath(text)) out.push(stripQuotes(stripKey(text)));
  });
  return [...new Set(out)];
}

// officecli 不会创建输出目录（实测：-o .work/review.html 报 Could not find a part of the path）。
// 调用前按 -o/--output 的目标把父目录建好，避免"目录不存在"这种无意义的失败。
export function ensureOfficeOutputDirs(args = [], workspace = "") {
  const created = [];
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index]);
    let target = "";
    if (token === "-o" || token === "--output") target = String(list[index + 1] || "");
    else if (token.startsWith("--output=")) target = token.slice("--output=".length);
    if (!target) continue;
    const text = target.trim();
    if (!text || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.includes("..")) continue;
    const root = path.resolve(workspace);
    const dir = path.dirname(path.resolve(root, text));
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(path.relative(root, dir).replace(/\\/g, "/"));
      }
    } catch {}
  }
  return created;
}

/**
 * 引用文件的父目录创建（计划 2026-10-31-003 / N-06）。
 *
 * 背景：实测模型写图到 .work/figs/test.svg 时，figs 目录常常不存在，
 * officecli 随即报 "Image file not found"——目录不存在与文件不存在是同一个报错，
 * 模型分不清，于是反复重试（实测 6 次）。
 */
export function ensureReferenceDirs(refs = [], workspace = "") {
  const created = [];
  const root = path.resolve(workspace);
  (Array.isArray(refs) ? refs : []).forEach((ref) => {
    const text = String(ref || "").trim();
    if (!text || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.includes("..")) return;
    const dir = path.dirname(path.resolve(root, text));
    if (dir === root || !dir.startsWith(root + path.sep)) return;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(path.relative(root, dir).replace(/\\/g, "/"));
      }
    } catch {}
  });
  return created;
}

/**
 * 引用预检（计划 2026-10-31-003 / N-06）。
 *
 * 调用 officecli 之前先检查它要引用的文件在磁盘上是否存在：
 * 不存在就直接给出结构化错误，不把命令发给 CLI——因为 CLI 的报错是
 * "Image file not found: x.svg"，模型无法区分"没写"和"目录不存在"，
 * 实测为此盲试 6 次。这里把缺失清单直接告诉模型。
 *
 * @param {string[]} refs 引用路径（工作区相对）
 * @param {string} workspace 工作区绝对路径
 * @param {string[]} [stagedPaths] 已物化/暂存的路径（命中即视为存在）
 * @returns {{ok:boolean, missing:string[], createdDirs:string[]}}
 */
export function preflightOfficeReferences(refs = [], workspace = "", stagedPaths = []) {
  const root = path.resolve(workspace);
  const staged = new Set((Array.isArray(stagedPaths) ? stagedPaths : []).map((item) => String(item).replace(/\\/g, "/")));
  const missing = [];
  (Array.isArray(refs) ? refs : []).forEach((ref) => {
    const text = String(ref || "").trim();
    if (!text) return;
    if (staged.has(text.replace(/\\/g, "/"))) return;
    try {
      if (!fs.existsSync(path.resolve(root, text))) missing.push(text);
    } catch {
      missing.push(text);
    }
  });
  const createdDirs = ensureReferenceDirs(refs, workspace);
  return { ok: missing.length === 0, missing, createdDirs };
}

/**
 * 选项合法性：每个子命令支持的选项不同，传错会让 CLI 直接以
 * "Unrecognized command or argument '--compact'" 失败。
 *
 * 实测（officecli 1.0.158 逐命令 --help 实测）：
 *   --compact / --fields  → 只有 query 支持；
 *   --find / --replace    → 只有 set 支持；
 *   -o / --output         → view / dump 支持。
 *
 * 模型对这条没有内化知识（一次真实写作任务里 9 次把 --compact 用在 get 上）。
 * 提示词约束只能减少、不能杜绝，因此在执行层把**不适用**的选项直接剥掉：
 * 这些选项在目标命令上本来就会让整条命令失败，剥掉反而让命令按预期执行。
 *
 * @param {string[]} args 已解析的参数
 * @returns {{args:string[], stripped:string[]}}
 */
export function stripUnsupportedOptions(args = []) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const command = String(list[0] || "").trim().toLowerCase();
  const stripped = [];
  // 命令白名单 → 允许出现的选项
  const ALLOWED = {
    query: new Set(["--json", "--compact", "--fields", "-h", "--help"]),
    set: new Set(["--json", "--find", "--replace", "--prop", "-h", "--help"]),
    view: new Set(["--json", "-o", "--output", "-h", "--help"]),
    dump: new Set(["--json", "-o", "--output", "-h", "--help"]),
    get: new Set(["--json", "--depth", "-h", "--help"]),
    add: new Set(["--json", "--type", "--prop", "-h", "--help"]),
    batch: new Set(["--json", "--commands", "-h", "--help"]),
    create: new Set(["--json", "--styled", "--no-styles", "--force", "-f", "-h", "--help"]),
    validate: new Set(["--json", "-h", "--help"]),
    import: new Set(["--json", "-h", "--help"]),
  };
  const allowed = ALLOWED[command];
  if (!allowed) return { args: list, stripped };
  const out = [];
  for (const token of list) {
    const isOption = token.startsWith("-") && token !== "-" && !/^-\d/.test(token);
    if (isOption && !allowed.has(token.toLowerCase())) {
      stripped.push(token);
      continue;
    }
    out.push(token);
  }
  return { args: out, stripped };
}
