import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "./持久化工具.mjs";
import { RUNTIME_FLAGS } from "./运行开关.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.resolve(__dirname, "..");
export const WORKSPACE_DIR = path.join(PROJECT_DIR, "office-workspace");
export const CLIENT_DIST = path.join(PROJECT_DIR, "client", "dist");

// OfficeCLI 二进制解析优先级：
//   1. 环境变量 OFFICECLI_BIN（显式指定）
//   2. 项目内置 bin/officecli（node scripts/install-officecli.mjs 安装）
//   3. 系统 PATH 中的 officecli
//   4. Windows 默认安装路径（officecli.ai 官方安装脚本）
function resolveOfficecli() {
  if (process.env.OFFICECLI_BIN) return process.env.OFFICECLI_BIN;
  const bundled = path.join(PROJECT_DIR, "bin", process.platform === "win32" ? "officecli.exe" : "officecli");
  if (fs.existsSync(bundled)) return bundled;
  const onPath = process.platform === "win32" ? null : (() => { try { return requireResolveInPath("officecli"); } catch { return null; } })();
  if (onPath) return onPath;
  return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Local"), "OfficeCLI", "officecli.exe");
}

function requireResolveInPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    try {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export const OFFICECLI = resolveOfficecli();

// AGENT_DIR 是规聚自己的配置目录；LOCAL_PI_AGENT_DIR 仅用于检测/显式导入。
// 两者由配置管理器统一解析，避免业务模块继续绑定某台机器的用户目录。
export { AGENT_DIR, LOCAL_PI_AGENT_DIR } from "./Pi配置管理.mjs";

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const ROOTS_STATE_FILE = path.join(PROJECT_DIR, ".file-roots.json");
// CAD 预览开关（默认关）：开启后 DXF/DWG 进入文件树与文件搜索白名单（CAD 方案 AC1/AC6）。
// 开关为进程级静态快照，正则只在模块加载时构建一次，flag 关 = 白名单与基线逐字节一致。
const CAD_EXT_SEGMENT = RUNTIME_FLAGS.cadPreview ? "|dxf|dwg" : "";
const SUPPORTED_EXTENSIONS = new RegExp(`\\.(docx|doc|xlsx|xls|pptx|pdf|csv|json|md|markdown|txt|html|htm|wps|png|jpg|jpeg|gif|webp|bmp|svg|avif${CAD_EXT_SEGMENT})$`, "i");
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".next", "dist", "build", "coverage"]);

// 当前工作区（可切换），默认项目内的 office-workspace；切换后持久化，重启恢复
let _currentWorkspace = WORKSPACE_DIR;
const WS_STATE_FILE = path.join(PROJECT_DIR, ".workspace-state.json");
try {
  const saved = JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8"));
  const restored = saved?.workspace ? normalizeWorkspace(saved.workspace) : null;
  if (restored) _currentWorkspace = restored;
} catch {}

export function getWorkspace() {
  return _currentWorkspace;
}

/**
 * 解析并校验一个工作区目录，统一给 HTTP 层、Agent 和 Run 使用。
 * 返回 realpath，避免同一个目录因相对路径/符号链接产生多个运行归属。
 */
export function normalizeWorkspace(dir = _currentWorkspace, { create = false } = {}) {
  const raw = String(dir || "").trim();
  if (!raw) return null;
  try {
    if (!fs.existsSync(raw)) {
      if (!create) return null;
      fs.mkdirSync(raw, { recursive: true });
    }
    const real = fs.realpathSync(raw);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function setWorkspace(dir) {
  try {
    const real = normalizeWorkspace(dir, { create: true });
    if (!real) return false;
    _currentWorkspace = real;
    // 合并写入，保留 hiddenWorkspaces 等已持久化字段
    let prev = {};
    try { prev = fs.existsSync(WS_STATE_FILE) ? JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8")) : {}; } catch {}
    prev.workspace = real;
    try { atomicWriteJson(WS_STATE_FILE, prev); } catch {}
    return true;
  } catch {
    return false;
  }
}

// 隐藏（删除）的工作区名单：持久化在 .workspace-state.json 的 hiddenWorkspaces 中，
// 用于让用户从下拉列表中移除不再需要的工作区路径（不破坏相关会话历史）。
export function getHiddenWorkspaces() {
  try {
    const state = JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8"));
    return Array.isArray(state.hiddenWorkspaces) ? state.hiddenWorkspaces : [];
  } catch {
    return [];
  }
}

export function hideWorkspace(dir) {
  try {
    const state = fs.existsSync(WS_STATE_FILE) ? JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8")) : {};
    const list = Array.isArray(state.hiddenWorkspaces) ? state.hiddenWorkspaces : [];
    const d = fs.existsSync(dir) ? fs.realpathSync(dir) : String(dir);
    if (!list.includes(d)) list.push(d);
    state.hiddenWorkspaces = list;
    atomicWriteJson(WS_STATE_FILE, state);
    return true;
  } catch {
    return false;
  }
}

export function safeName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.includes("..") || /[\\/:*?"<>|]/.test(base)) return null;
  return base;
}

export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readFileRoots() {
  try {
    const roots = JSON.parse(fs.readFileSync(ROOTS_STATE_FILE, "utf8"));
    return Array.isArray(roots) ? roots.filter((r) => r?.id && r?.path && fs.existsSync(r.path)) : [];
  } catch {
    return [];
  }
}

export function listFileRoots() {
  return readFileRoots().map((r) => ({ ...r, path: fs.realpathSync(r.path) }));
}

export function addFileRoot(dir, label = "") {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "path required" };
  try {
    const real = fs.realpathSync(raw);
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: "不是文件夹" };
    const roots = readFileRoots();
    const existing = roots.find((r) => r.path === real);
    if (existing) return { ok: true, root: { ...existing, path: real }, roots: listFileRoots() };
    const id = crypto.createHash("sha1").update(real).digest("hex").slice(0, 12);
    const root = { id, path: real, label: String(label || path.basename(real) || real), created: new Date().toISOString() };
    atomicWriteJson(ROOTS_STATE_FILE, [...roots, root]);
    return { ok: true, root, roots: listFileRoots() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function removeFileRoot(id) {
  const roots = readFileRoots();
  const next = roots.filter((r) => r.id !== String(id || ""));
  if (next.length === roots.length) return { ok: false, error: "root not found" };
  atomicWriteJson(ROOTS_STATE_FILE, next);
  return { ok: true, roots: listFileRoots() };
}

export function resolveExternalPath(rootId, rel = "") {
  const root = listFileRoots().find((r) => r.id === String(rootId || ""));
  if (!root) return null;
  const clean = String(rel || "").replace(/^[/\\]+/, "");
  if (!clean || clean.includes("\0") || clean.split(/[\\/]/).includes("..") || path.isAbsolute(clean)) return null;
  const target = path.resolve(root.path, clean);
  if (!isInside(root.path, target) || !fs.existsSync(target)) return null;
  const real = fs.realpathSync(target);
  return isInside(root.path, real) ? real : null;
}

export function listWorkspace(dir) {
  const target = dir || _currentWorkspace;
  if (!fs.existsSync(target)) return [];
  let items;
  try {
    items = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    // 根目录在检查后消失：返回空列表由调用方按“目录不存在”处理；
    // 其余 EPERM/EACCES/EIO 继续抛出，交给 /api/files 返回可重试错误。
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  const files = [];
  for (const entry of items) {
    if (!entry.isFile() || entry.name.startsWith("~$") || entry.name.startsWith(".")) continue;
    if (!SUPPORTED_EXTENSIONS.test(entry.name)) continue;
    try {
      const st = fs.statSync(path.join(target, entry.name));
      files.push({ name: entry.name, size: st.size, mtime: st.mtimeMs, ext: path.extname(entry.name).slice(1).toLowerCase(), isDir: false });
    } catch {
      // 文件在 readdir 与 stat 之间被删除/重命名：跳过该条，不让整页列表失败。
    }
  }
  const dirs = [];
  for (const entry of items) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    // 目录只用于导航，不依赖 mtime；不再逐个 stat，缩小文件抖动下的竞态窗口。
    dirs.push({ name: entry.name, size: 0, mtime: 0, ext: "folder", isDir: true });
  }
  return [...dirs, ...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 在当前工作区递归搜索文件和目录名称，返回相对路径，避免前端逐层请求目录。 */
export function searchWorkspace(query, { dir = _currentWorkspace, limit = 200, maxDepth = 12 } = {}) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const root = normalizeWorkspace(dir);
  if (!root || !terms.length) return [];
  const results = [];
  const pending = [{ absolute: root, relative: "", depth: 0 }];
  const matches = (relative) => terms.every((term) => relative.toLowerCase().includes(term));
  while (pending.length && results.length < limit) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current.absolute, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        if (matches(relative)) {
          try {
            const stat = fs.statSync(absolute);
            results.push({ name: entry.name, relPath: relative, isDir: true, ext: "folder", size: 0, mtime: stat.mtimeMs });
          } catch {}
        }
        if (current.depth < maxDepth) pending.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!SUPPORTED_EXTENSIONS.test(entry.name) || !matches(relative)) continue;
      try {
        const stat = fs.statSync(absolute);
        results.push({ name: entry.name, relPath: relative, isDir: false, ext: path.extname(entry.name).slice(1).toLowerCase(), size: stat.size, mtime: stat.mtimeMs });
      } catch {}
      if (results.length >= limit) break;
    }
  }
  return results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.relPath.localeCompare(b.relPath, undefined, { sensitivity: "base" });
  }).slice(0, limit);
}

// 解析相对路径（支持子目录），返回绝对路径
export function resolvePath(rel, workspace = _currentWorkspace) {
  const raw = String(rel || "").trim();
  if (!raw || raw.includes("\0") || raw.split(/[\\/]/).includes("..") || path.isAbsolute(raw) || raw.startsWith("\\\\") || raw.startsWith("//") || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  const root = normalizeWorkspace(workspace);
  if (!root) return null;
  const n = raw.replace(/^\\/g, "").replace(/^\//g, "");
  const p = path.resolve(root, n);
  if (!isInside(root, p) || !fs.existsSync(p)) return null;
  try {
    const real = fs.realpathSync(p);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

export function filePath(name, workspace = _currentWorkspace) {
  return resolvePath(name, workspace);
}

export { SUPPORTED_EXTENSIONS };
