/**
 * 上下文文件选择（2026-11-03）。
 *
 * Pi 的 loadProjectContextFiles 会从工作区一路向上加载每一级目录的 AGENTS.md，
 * 默认工作区在仓库内时会把「研发宪法（仓库根 AGENTS.md）」也读进运行时。
 * 这里只保留：
 *   1. 工作区自身的 AGENTS.md（L1 项目规则）；
 *   2. agentDir 下的全局 AGENTS.md（用户级规则）；
 * 丢弃工作区之外、且不属于 agentDir 的祖先文件，并按 realpath 去重。
 */
import fs from "node:fs";
import path from "node:path";

function canonical(value) {
  const raw = String(value || "");
  if (!raw) return "";
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

function comparable(value) {
  const resolved = canonical(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(file, dir) {
  const target = comparable(file);
  const root = comparable(dir);
  if (!target || !root) return false;
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function selectAgentsFiles(files = [], { workspace = "", agentDir = "" } = {}) {
  const seen = new Set();
  const workspaceFiles = [];
  const globalFiles = [];
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = String(file?.path || "");
    if (!filePath) continue;
    const key = comparable(filePath);
    if (!key || seen.has(key)) continue;
    if (workspace && isInside(filePath, workspace)) {
      workspaceFiles.push(file);
      seen.add(key);
    } else if (agentDir && isInside(filePath, agentDir)) {
      globalFiles.push(file);
      seen.add(key);
    }
  }
  // L1 工作区规则在前，用户级全局规则在后；祖先研发宪法不在两类中，自动丢弃。
  return [...workspaceFiles, ...globalFiles];
}

export function listContextFilePaths(files = []) {
  return (Array.isArray(files) ? files : []).map((file) => String(file?.path || "")).filter(Boolean);
}
