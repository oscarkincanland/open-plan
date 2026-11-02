/**
 * 环境能力探测（计划 2026-10-31-003 / N-08）。
 *
 * 背景：bash 工具在 Windows 上最初依赖 WSL。实测 run_05198175 里模型调用 bash 三次全部失败，
 * 错误是 UTF-16 编码的乱码（"Linux 的 Windows 子系统没有已安装的分发版"），
 * 模型看不懂、反复重试。2026-10-30 用户专门开过一轮任务装 WSL，也没装成。
 *
 * 2026-11-01 修正：Windows 上不再只认 WSL。
 *   实测本机 Git Bash 在 D:\Git\usr\bin\bash.exe（Git 装在非默认盘），本身完全可用；
 *   旧探测只跑 `wsl.exe echo` → 判为不可用 → bash 工具被闸门整条拦掉；
 *   同时 SDK 自己的 shell 解析按 "%ProgramFiles%\Git\bin" → PATH 上的 bash.exe 顺序找，
 *   服务进程 PATH 里没有 Git 时会命中 C:\Windows\System32\bash.exe（WSL 旧启动器），
 *   输出 UTF-16 乱码——正是上面那次 run 的现象。
 *   现在统一由本模块解析 shell：Git Bash 优先 → WSL 兜底，
 *   并把同一个 shell 同时喂给探测与执行端，保证"探测说可用"与"实际执行"一致。
 *
 * 这里做一次启动期探测并缓存结果：
 *   - 可用：bash 照常工作，零改动；
 *   - 不可用：bash 调用直接返回结构化错误 { code: "bash_unavailable" }，
 *     并在工具描述里说明"本机 bash 不可用，文档处理请用 officecli/read/write"，
 *     避免模型盲目重试。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR, getPiConfigPaths } from "./Pi配置管理.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 探测标记：实际执行一次命令来判定可用性（`wsl.exe --status` 未装发行版也返回 0，不可用）。 */
const PROBE_MARKER = "__oaw_probe__";

/**
 * WSL 旧启动器：C:\Windows\System32\bash.exe。
 * 没有 Linux 发行版时它会输出 UTF-16 乱码，绝不能当 bash 用。
 */
const LEGACY_WSL_BASH = /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i;

/** 探测结果缓存：同一进程内只探测一次。 */
let cached = null;

/** 文件是否存在（不存在返回 false，不抛异常）。 */
function fileExists(target) {
  try {
    return Boolean(target) && fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 在 PATH 上查找可执行文件，返回命中的绝对路径列表。
 * Windows 用 where，其余用 which；找不到时返回空数组。
 */
function findOnPath(executable, env = process.env) {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(finder, [executable], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
      env,
    });
    if (result.error || result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((candidate) => fileExists(candidate));
  } catch {
    return [];
  }
}

/**
 * Git Bash 候选路径：
 *   1. 标准安装位置（ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA 下的 Git\bin）；
 *   2. 由 PATH 上的 git.exe 反推 Git 安装根目录——Git 装在非默认盘时（如本机 D:\Git）也能找到。
 */
function gitBashCandidates(env = process.env) {
  const out = [];
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
    if (!base) continue;
    out.push(path.join(base, "Git", "bin", "bash.exe"));
  }
  for (const gitExe of findOnPath("git.exe", env)) {
    const root = path.dirname(path.dirname(gitExe)); // <root>\cmd\git.exe → <root>
    out.push(path.join(root, "bin", "bash.exe"));
    out.push(path.join(root, "usr", "bin", "bash.exe"));
  }
  return out;
}

/**
 * 从候选路径里挑一个可用的 bash：跳过 WSL 旧启动器，返回第一个真实存在的。
 * 导出供单测使用（纯函数，不碰文件系统以外的东西）。
 */
export function pickBashShellFromCandidates(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (LEGACY_WSL_BASH.test(candidate)) continue;
    if (fileExists(candidate)) return candidate;
  }
  return "";
}

/**
 * 读取 Pi 设置里的 shellPath。
 *
 * Pi SDK 的 settings.json 支持 shellPath（见 SDK settings-manager），
 * 但它只作用于 SDK 自带的 bash 工具——本项目用 customTools 接管了那个工具，
 * 所以这里显式读同一份设置，让「产品里的 bash」与「SDK 内部的 bash」用同一个 shell。
 * 项目级设置（.pi/settings.json）优先于全局设置（<AGENT_DIR>/settings.json）。
 */
export function piConfiguredShell(settingsPaths = defaultSettingsPaths()) {
  for (const file of settingsPaths) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const value = String(raw?.shellPath || "").trim();
      if (value && fileExists(value)) return value;
    } catch {
      // 设置损坏时忽略：回落到自动探测
    }
  }
  return "";
}

/** Pi 设置文件候选路径（项目级 → Open Plan 运行时设置 → SDK 原生全局设置）。 */
function defaultSettingsPaths() {
  const out = [];
  try {
    out.push(path.join(PROJECT_DIR, ".pi", "settings.json"));
  } catch {}
  try {
    // Open Plan 的 Pi 设置（中文文件名，defaultProvider/defaultModel 等都在这里）
    out.push(getPiConfigPaths(AGENT_DIR).settingsPath);
  } catch {}
  try {
    // Pi SDK 原生全局设置（英文文件名）；产品用 customTools 接管了 SDK 的 bash 工具，
    // 这里单独读一份，保证 SDK 内部路径与产品用同一个 shell。
    out.push(path.join(AGENT_DIR, "settings.json"));
  } catch {}
  return out;
}

/**
 * 解析本机可用的 bash。
 *
 * 顺序：OAW_BASH_SHELL 显式覆盖 → Pi settings.json 的 shellPath →
 *      Git Bash（标准位置 / 由 git.exe 反推 / PATH）→ WSL 兜底。
 * 非 Windows 直接用系统 bash。
 *
 * @param {{env?:NodeJS.ProcessEnv, platform?:string, settingsPaths?:string[]}} [options]
 * @returns {{shell:string, kind:string, source:string, reason:string}}
 */
export function resolveBashShell({ env = process.env, platform = process.platform, settingsPaths = null } = {}) {
  const explicit = String(env.OAW_BASH_SHELL || "").trim();
  if (explicit) {
    return { shell: explicit, kind: "custom", source: "OAW_BASH_SHELL", reason: "" };
  }
  if (platform !== "win32") {
    return { shell: "bash", kind: "native", source: "PATH", reason: "" };
  }

  const configured = piConfiguredShell(settingsPaths || defaultSettingsPaths());
  if (configured) {
    return { shell: configured, kind: "configured", source: "settings.json", reason: "" };
  }

  const gitBash = pickBashShellFromCandidates(gitBashCandidates(env));
  if (gitBash) {
    return { shell: gitBash, kind: "git-bash", source: "git-bash", reason: "" };
  }

  // PATH 上的 bash.exe：跳过 System32 的 WSL 旧启动器（无发行版时只会输出乱码）。
  const pathBash = pickBashShellFromCandidates(findOnPath("bash.exe", env));
  if (pathBash) {
    return { shell: pathBash, kind: "git-bash", source: "PATH", reason: "" };
  }

  // WSL 兜底：必须先确认真的装了可执行的发行版。
  const wslShim = path.join(env.SystemRoot || "C:\\Windows", "System32", "bash.exe");
  if (fileExists(wslShim)) {
    try {
      const result = spawnSync("wsl.exe", ["echo", PROBE_MARKER], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        env,
      });
      if (!result.error && Number(result.status) === 0 && String(result.stdout || "").includes(PROBE_MARKER)) {
        return { shell: wslShim, kind: "wsl", source: "wsl", reason: "" };
      }
    } catch {
      // 忽略：下面统一给兜底原因
    }
  }

  return {
    shell: "",
    kind: "none",
    source: "",
    reason: "未找到可用的 bash（Git Bash 与 WSL 均不可用）",
  };
}

/**
 * 探测 bash 是否可用。
 *
 * @param {{force?:boolean, timeoutMs?:number}} [options]
 * @returns {{available:boolean, reason:string, platform:string, probedAt:string, shell:string, shellKind:string}}
 */
export function probeBashAvailability({ force = false, timeoutMs = 4000 } = {}) {
  if (cached && !force) return cached;
  const platform = process.platform;
  const now = new Date().toISOString();
  // 非 Windows：bash 是系统原生命令，默认可用（不再多探一次）。
  if (platform !== "win32") {
    cached = { available: true, reason: "", platform, probedAt: now, shell: "bash", shellKind: "native" };
    return cached;
  }

  const resolved = resolveBashShell();
  let available = false;
  let reason = resolved.reason || "";
  if (resolved.kind === "wsl") {
    // resolveBashShell 已用 wsl.exe 实际执行验证过发行版可用。
    available = true;
  } else if (resolved.shell) {
    try {
      const result = spawnSync(resolved.shell, ["-c", `echo ${PROBE_MARKER}`], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      });
      if (result.error) {
        reason = `bash 探测失败：${String(result.error.message || result.error).slice(0, 120)}`;
      } else if (Number(result.status) !== 0 || !String(result.stdout || "").includes(PROBE_MARKER)) {
        reason = `bash 探测未通过（退出码 ${result.status}）：${resolved.shell}`;
      } else {
        available = true;
      }
    } catch (error) {
      reason = `bash 探测异常：${String(error?.message || error).slice(0, 120)}`;
    }
  }
  cached = {
    available,
    reason,
    platform,
    probedAt: now,
    shell: resolved.shell || "",
    shellKind: resolved.kind,
    shellSource: resolved.source || "",
  };
  return cached;
}

/** 清除缓存（测试用）。 */
export function resetBashAvailabilityCache() {
  cached = null;
}

/**
 * 诊断用：bash 能力的结构化快照。
 * 供 /api/agent/diagnostics 展示——「bash 到底能不能用、用的是哪个 shell」必须一眼可见，
 * 否则下次再坏只能靠翻事件流猜。
 */
export function bashEnvironmentInfo() {
  const probe = probeBashAvailability();
  return {
    available: probe.available,
    shell: probe.shell || null,
    shellKind: probe.shellKind,
    shellSource: probe.shellSource || null,
    reason: probe.reason || null,
    probedAt: probe.probedAt,
  };
}

/**
 * bash 不可用时的结构化错误提示。
 * @returns {{code:string, message:string, suggestion:string}}
 */
export function bashUnavailableError() {
  const probe = probeBashAvailability();
  return {
    code: "bash_unavailable",
    message: `本机 bash 不可用（${probe.reason || "未找到可用的 bash"}）。`,
    suggestion: "请改用其它工具完成工作："
      + "文本读写用 read / write / edit；"
      + "Office 文档用 officecli（原生引擎优先）或 editorial_pipeline；"
      + "目录浏览用 ls / find；"
      + "确实需要 bash 时，请先让用户安装 Git Bash 或 WSL 后重试。",
  };
}

/** bash 工具描述里的环境说明（可用时为空串）。 */
export function bashEnvironmentHint() {
  const probe = probeBashAvailability();
  if (probe.available) return "";
  return ` NOTE: bash is NOT available on this machine (${probe.reason || "no usable bash"}). `
    + "Use read/write/edit for text, officecli or editorial_pipeline for Office documents, "
    + "and ls/find for browsing. Do not retry bash calls that fail.";
}

/**
 * bash 的路径语义说明：不同 shell 对 Windows 路径的写法不同，写错会直接报"文件不存在"。
 * 可用时返回一句可直接塞进系统提示的话；不可用时返回空串。
 */
export function bashShellHint() {
  const probe = probeBashAvailability();
  if (!probe.available) return "";
  if (probe.shellKind === "wsl") {
    return ` bash 由 WSL 提供：Windows 路径要写成挂载形式（如 F:/data 对应 /mnt/f/data）。`;
  }
  return ` bash 由 Git Bash 提供（${probe.shell}）：Windows 路径用正斜杠（如 F:/data），不要用 WSL 的 /mnt/ 写法。`;
}

/**
 * 系统提示里关于 bash 与文本改写的一条规则。
 *
 * 背景：模型做小段文本替换时习惯用 sed/awk，一旦 bash 不可用就会连续触发
 * bash_unavailable 报错与审批噪音。规则层面直接禁止用 shell 改写文本，
 * 让文本改写稳定落在 read/write/edit 上。
 */
export function bashWorkspaceRule() {
  const probe = probeBashAvailability();
  const where = probe.available
    ? `本机 bash 可用（${probe.shellKind === "wsl" ? "WSL" : probe.shellKind === "custom" ? "自定义 shell" : "Git Bash"}）。`
    : `本机 bash 不可用（${probe.reason || "未找到可用的 bash"}）。`;
  return "- **bash 与文本改写**: " + where
    + "文本的读取、写入与小段改写一律用 read / write / edit 工具；"
    + "不要用 sed / awk / 重定向改写文本文件（会触发 bash 失败、审批与闸门噪音），"
    + "也不要用 bash 处理文档（用 officecli）。"
    + "bash 只在必须执行脚本、构建或运行命令时使用。"
    + bashShellHint()
    + bashEnvironmentHint();
}
