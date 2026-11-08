/**
 * 技能依赖声明与只读预检（2026-11-08，D1；计划 2026-11-08-001 §9）
 *
 * 目标：把“技能需不需要运行环境、缺什么、能不能用”变成确定性、可解释、只读的检查：
 *   - 声明：SKILL.md frontmatter 的 `requires`（runtime/python/npm/exec/network/platform/install）；
 *   - 预检：不安装、不联网，只探测解释器、隔离环境、包是否可用；
 *   - 输出：ready / degraded / blocked + 人话原因，供 skills_read、/api/skills 与安装 UI 使用。
 *
 * 设计约束：
 *   - 依赖只允许安装到 `<workspace>/.oaw/skill-deps/<skill>/`，本模块只做只读探测；
 *   - 不写系统目录、不发起网络请求；包检测用解释器退出码（stdio: ignore），避免沙箱管道限制；
 *   - 所有路径来自 workspace/skill，禁止越界读写。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SKILL_DEPS_ROOT = path.join(".oaw", "skill-deps");

/** 技能名 → 安全目录名（只允许小写字母/数字/短横线/下划线）。 */
export function skillDirName(name = "") {
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "skill";
}

/** 技能依赖目录（绝对路径，限制在 workspace 内）。 */
export function skillDepsDir(workspace = "", name = "") {
  const root = path.resolve(workspace || ".", SKILL_DEPS_ROOT);
  return path.join(root, skillDirName(name));
}

export function skillVenvPython(workspace = "", name = "", platform = process.platform) {
  const dir = skillDepsDir(workspace, name);
  return platform === "win32"
    ? path.join(dir, ".venv", "Scripts", "python.exe")
    : path.join(dir, ".venv", "bin", "python");
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function splitList(value = "") {
  return String(value || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,，、\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseRuntime(value = "") {
  const out = [];
  const text = String(value || "");
  for (const match of text.matchAll(/\{([^}]*)\}/g)) {
    const body = match[1];
    const kind = (body.match(/kind\s*:\s*["']?([a-zA-Z0-9_+-]+)/) || [])[1] || "runtime";
    const version = (body.match(/version\s*:\s*["']?([^"',}]+)/) || [])[1] || "";
    out.push({ kind: kind.toLowerCase(), version: version.trim() });
  }
  return out;
}

/**
 * 解析 frontmatter 里的 `requires` 嵌套块文本。
 * @param {string} requiresText
 * @param {string} [installText] 顶层 `install:` 块文本
 */
export function parseRequires(requiresText = "", installText = "") {
  const text = String(requiresText || "");
  if (!text.trim()) return null;
  const result = {
    runtime: [],
    python: [],
    npm: [],
    exec: [],
    network: null,
    platform: [],
    install: { python: "", npm: "" },
  };
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "runtime") result.runtime = parseRuntime(value);
    else if (key === "python") result.python = splitList(value);
    else if (key === "npm") result.npm = splitList(value);
    else if (key === "exec") result.exec = splitList(value);
    else if (key === "platform") result.platform = splitList(value).map((item) => item.toLowerCase());
    else if (key === "network") result.network = /^(true|yes|1)$/i.test(value) ? true : /^(false|no|0)$/i.test(value) ? false : null;
    else if (key === "install") {
      const nested = parseRequiresInstall(String(installText || ""));
      const legacy = splitList(value);
      if (legacy.length) result.install.python = legacy[0];
      if (nested.python) result.install.python = nested.python;
      if (nested.npm) result.install.npm = nested.npm;
    }
  }
  // install 可能是顶层键（与 requires 同级），单独解析
  const topInstall = parseRequiresInstall(String(installText || ""));
  if (topInstall.python) result.install.python = topInstall.python;
  if (topInstall.npm) result.install.npm = topInstall.npm;
  const hasAny = result.runtime.length || result.python.length || result.npm.length
    || result.exec.length || result.platform.length || result.network !== null
    || result.install.python || result.install.npm;
  return hasAny ? result : null;
}

/** 解析顶层 `install:` 块（python: requirements.txt / npm: package.json）。 */
export function parseRequiresInstall(installText = "") {
  const out = { python: "", npm: "" };
  for (const line of String(installText || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(python|npm)\s*:\s*(.+)$/i);
    if (match) out[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * 在 PATH 中查找可执行文件（不启动子进程，避免沙箱管道限制）。
 * @returns {string|null}
 */
export function findExecutable(name = "", { pathEnv = process.env.PATH || "", platform = process.platform, pathext = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM" } = {}) {
  const command = String(name || "").trim();
  if (!command) return null;
  if (path.isAbsolute(command)) return isFile(command) ? command : null;
  const dirs = String(pathEnv || "").split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? String(pathext || "").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 解析 Python：优先工作区隔离 venv，其次 PATH。 */
export function resolvePython({ workspace = "", skillName = "", pathEnv = process.env.PATH || "", platform = process.platform } = {}) {
  const venv = skillVenvPython(workspace, skillName, platform);
  if (isFile(venv)) return { path: venv, source: "workspace-venv" };
  for (const name of ["python3", "python", "py"]) {
    const found = findExecutable(name, { pathEnv, platform });
    if (found) return { path: found, source: "path" };
  }
  return null;
}

/** 解释器版本是否满足简单约束（>=3.10 / >=3 / *）。返回 {ok, detail}。 */
export function checkPythonVersion(pythonPath = "", version = "", {
  platform = process.platform,
  runner = defaultPythonRunner,
} = {}) {
  const constraint = String(version || "").trim();
  if (!pythonPath || !constraint) return { ok: true, detail: "未声明版本约束" };
  const threshold = constraint.match(/(\d+)\.(\d+)/);
  const major = threshold ? Number(threshold[1]) : 3;
  const minor = threshold ? Number(threshold[2]) : 0;
  const script = `import sys;sys.exit(0 if sys.version_info[:2]>=(${major},${minor}) else 1)`;
  try {
    runner(pythonPath, ["-c", script], { platform });
    return { ok: true, detail: `Python ≥ ${major}.${minor}` };
  } catch (error) {
    return { ok: false, detail: `Python 版本低于 ${major}.${minor}`, error: String(error?.message || error) };
  }
}

function defaultPythonRunner(pythonPath, args, { platform = process.platform } = {}) {
  execFileSync(pythonPath, args, {
    stdio: "ignore",
    timeout: 8000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
}

/** 检查 Python 包是否可导入；先批量，失败后逐包定位缺失项。 */
export function checkPythonPackages(pythonPath = "", packages = [], {
  platform = process.platform,
  runner = defaultPythonRunner,
} = {}) {
  const list = (Array.isArray(packages) ? packages : []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!pythonPath || !list.length) return { missing: [], checked: list.length, error: "" };
  const moduleNames = list.map((item) => item.replace(/\[.*$/, "").replace(/-/g, "_"));
  try {
    runner(pythonPath, ["-c", `import ${moduleNames.join(", ")}`], { platform });
    return { missing: [], checked: list.length, error: "" };
  } catch {
    const missing = [];
    for (let index = 0; index < moduleNames.length; index += 1) {
      try {
        runner(pythonPath, ["-c", `import ${moduleNames[index]}`], { platform });
      } catch {
        missing.push(list[index]);
      }
    }
    return { missing: Array.isArray(missing) ? missing : [], checked: list.length, error: "" };
  }
}

function npmPackagesInstalled(dir, packages) {
  if (!packages.length) return { missing: [], checked: 0 };
  const modules = path.join(dir, "node_modules");
  const missing = packages.filter((name) => {
    const clean = String(name || "").replace(/@[\d.^~<>=*| -]+$/, "");
    if (!clean) return false;
    if (clean.startsWith("@")) {
      const [scope, namePart] = clean.split("/");
      return !isDir(path.join(modules, scope, namePart || ""));
    }
    return !isDir(path.join(modules, clean));
  });
  return { missing, checked: packages.length };
}

/**
 * 只读预检。
 * @param {object} input
 * @param {object} input.skill 技能目录项（含 requiresText / installText / path / name）
 * @param {string} input.workspace 工作区绝对路径
 * @param {"full"|"declared"} [input.mode] full=检查包；declared=只检查声明与平台/可执行
 * @returns {{status:"ready"|"degraded"|"blocked", code:string, reasons:string[], checks:object[], requires:object|null, dir:string, manifest:object|null}}
 */
export function probeSkillDeps({
  skill = null,
  workspace = "",
  mode = "full",
  platform = process.platform,
  pathEnv = process.env.PATH || "",
  runner,
  versionRunner,
} = {}) {
  const name = String(skill?.name || "");
  const dir = skillDepsDir(workspace, name);
  const requires = parseRequires(skill?.requiresText || "", skill?.installText || "");
  if (!requires) {
    return { status: "ready", code: "SKILL_DEPS_NONE", reasons: [], checks: [], requires: null, dir, manifest: readManifest(workspace, name) };
  }
  const checks = [];
  const reasons = [];
  let blocked = false;
  let degraded = false;

  if (requires.platform.length && !requires.platform.includes(platform)) {
    blocked = true;
    reasons.push(`该技能声明仅支持 ${requires.platform.join("/")}，当前 ${platform}`);
    checks.push({ id: "platform", status: "blocked", detail: platform });
  } else {
    checks.push({ id: "platform", status: "ok", detail: platform });
  }

  const needsPython = requires.runtime.some((item) => item.kind === "python") || requires.python.length > 0 || requires.exec.includes("python");
  const python = needsPython ? resolvePython({ workspace, skillName: name, pathEnv, platform }) : null;
  if (needsPython && !python) {
    blocked = true;
    reasons.push("缺少 Python 运行时（未找到 python/python3，工作区也没有隔离 venv）");
    checks.push({ id: "python", status: "blocked", detail: "未找到 Python" });
  } else if (needsPython) {
    checks.push({ id: "python", status: "ok", detail: `${python.source === "workspace-venv" ? "工作区隔离 venv" : "PATH"}：${python.path}` });
    const runtimeSpec = requires.runtime.find((item) => item.kind === "python");
    const versionCheck = checkPythonVersion(python.path, runtimeSpec?.version || "", { platform, runner: versionRunner || runner || defaultPythonRunner });
    if (!versionCheck.ok) {
      blocked = true;
      reasons.push(versionCheck.detail);
      checks.push({ id: "python-version", status: "blocked", detail: versionCheck.detail });
    } else {
      checks.push({ id: "python-version", status: "ok", detail: versionCheck.detail });
    }
    if (mode === "full" && requires.python.length) {
      const packageCheck = checkPythonPackages(python.path, requires.python, { platform, runner: runner || defaultPythonRunner });
      if (packageCheck.missing.length) {
        blocked = true;
        reasons.push(`缺少 ${packageCheck.missing.length} 个 Python 包：${packageCheck.missing.slice(0, 6).join("、")}${packageCheck.missing.length > 6 ? "…" : ""}`);
        checks.push({ id: "python-packages", status: "blocked", detail: `缺 ${packageCheck.missing.length}/${packageCheck.checked}` });
      } else {
        checks.push({ id: "python-packages", status: "ok", detail: `${packageCheck.checked} 个包可用` });
      }
    } else if (requires.python.length) {
      degraded = true;
      checks.push({ id: "python-packages", status: "unknown", detail: `声明 ${requires.python.length} 个包（未逐包探测）` });
    }
  }

  if (requires.npm.length) {
    const npm = findExecutable("npm", { pathEnv, platform });
    if (!npm) {
      blocked = true;
      reasons.push("缺少 npm（技能声明了 npm 依赖）");
      checks.push({ id: "npm", status: "blocked", detail: "未找到 npm" });
    } else {
      const installed = npmPackagesInstalled(dir, requires.npm);
      if (installed.missing.length) {
        if (mode === "full") {
          blocked = true;
          reasons.push(`缺少 ${installed.missing.length} 个 npm 包：${installed.missing.slice(0, 6).join("、")}`);
        } else {
          degraded = true;
        }
        checks.push({ id: "npm-packages", status: mode === "full" ? "blocked" : "unknown", detail: `缺 ${installed.missing.length}/${installed.checked}` });
      } else {
        checks.push({ id: "npm-packages", status: "ok", detail: `${installed.checked} 个包可用` });
      }
    }
  }

  for (const executable of requires.exec) {
    if (executable.toLowerCase() === "python") continue;
    const found = findExecutable(executable, { pathEnv, platform });
    if (!found) {
      blocked = true;
      reasons.push(`缺少可执行文件：${executable}`);
      checks.push({ id: `exec:${executable}`, status: "blocked", detail: "未找到" });
    } else {
      checks.push({ id: `exec:${executable}`, status: "ok", detail: found });
    }
  }

  if (requires.network) {
    checks.push({ id: "network", status: "unknown", detail: "技能声明需要网络（预检不联网）" });
  }

  const status = blocked ? "blocked" : degraded ? "degraded" : "ready";
  const code = blocked
    ? (reasons.some((item) => /Python 运行时/.test(item)) ? "SKILL_DEP_RUNTIME_MISSING" : reasons.some((item) => /包/.test(item)) ? "SKILL_DEP_PACKAGE_MISSING" : "SKILL_DEP_BLOCKED")
    : degraded ? "SKILL_DEP_UNVERIFIED" : "SKILL_DEPS_OK";
  return { status, code, reasons, checks, requires, dir, manifest: readManifest(workspace, name), python: python?.path || null };
}

// ---------- manifest ----------

export function manifestFile(workspace = "", name = "") {
  return path.join(skillDepsDir(workspace, name), "manifest.json");
}

export function readManifest(workspace = "", name = "") {
  try { return JSON.parse(fs.readFileSync(manifestFile(workspace, name), "utf8")); } catch { return null; }
}

export function writeManifest(workspace = "", name = "", data = {}) {
  const file = manifestFile(workspace, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ skill: name, ...data }, null, 2), "utf8");
  return file;
}

/** 删除工作区内的技能依赖目录（只允许 .oaw/skill-deps 下）。 */
export function removeSkillDeps(workspace = "", name = "") {
  const dir = skillDepsDir(workspace, name);
  const root = path.resolve(workspace || ".", SKILL_DEPS_ROOT);
  const resolved = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return { removed: false, reason: "越界路径，拒绝删除" };
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return { removed: true, dir: resolved };
  } catch (error) {
    return { removed: false, reason: String(error?.message || error) };
  }
}
