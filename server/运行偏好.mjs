/**
 * 运行偏好（用户在设置面板里切换的产品行为偏好）。
 *
 * 与 server/运行开关.mjs 的分工（不要混用）：
 *   - 运行开关.mjs：环境变量驱动的"实验性能力"。进程内只读快照，改了要重启服务，
 *     默认关闭，语义是"这次要不要试一下"。
 *   - 本模块：用户主动选择的"产品行为"。落盘 JSON，进程内随时可读，**下一轮任务
 *     立即生效**，不需要重启。语义是"我想要这个行为一直是这样"。
 *
 * 当前偏好：
 *   - completeTaskEnabled：是否要求模型显式调用 complete_task 声明完成状态。
 *     默认 **关闭**：关闭时不暴露该工具、不强制收尾回合、提示词也不要求它；
 *     Run 的完成语义退回到"按终态推断"（server/运行轨迹.mjs 的 inferred 分支），
 *     省掉一次多余的模型回合。打开后恢复显式声明（success/partial/blocked/failed）。
 *
 * 环境变量 OAW_COMPLETE_TASK=1 可把默认值改成开启（运维/测试用）；
 * 用户在设置里保存的值优先于环境变量默认值。
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace.mjs";
import { atomicWriteJson } from "./持久化工具.mjs";

// 允许测试与运维使用隔离的路径，避免写到用户正在使用的偏好文件。
const PREFERENCES_FILE = process.env.OAW_PREFERENCES_FILE
  ? path.resolve(process.env.OAW_PREFERENCES_FILE)
  : path.join(PROJECT_DIR, ".oaw", "preferences.json");

const TRUTHY = new Set(["1", "true", "on", "yes"]);

function envDefault() {
  const raw = String(process.env?.OAW_COMPLETE_TASK ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/** 默认值：complete_task 默认关闭（显式完成声明是额外的模型回合，不是必需品）。 */
export const DEFAULT_PREFERENCES = Object.freeze({
  completeTaskEnabled: false,
});

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 当前生效的运行偏好。
 * 读取顺序：磁盘保存值（用户选择）> 环境变量默认值 > 内置默认值。
 */
export function readRuntimePreferences() {
  const defaults = { ...DEFAULT_PREFERENCES, completeTaskEnabled: envDefault() };
  const stored = readJson(PREFERENCES_FILE, {}) || {};
  const merged = { ...defaults };
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    if (stored[key] !== undefined && stored[key] !== null) merged[key] = Boolean(stored[key]);
  }
  return merged;
}

/** 只读视图（供 /api/runtime-preferences 下发）：不暴露文件路径。 */
export function publicRuntimePreferences() {
  const prefs = readRuntimePreferences();
  return {
    completeTaskEnabled: prefs.completeTaskEnabled,
    completeTaskAvailable: true,
    source: "user",
  };
}

/**
 * 保存运行偏好。只接受白名单字段，值一律转布尔。
 * 返回保存后的生效值。
 */
export function saveRuntimePreferences(patch = {}) {
  const current = readRuntimePreferences();
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    if (patch[key] !== undefined && patch[key] !== null) next[key] = Boolean(patch[key]);
  }
  fs.mkdirSync(path.dirname(PREFERENCES_FILE), { recursive: true });
  atomicWriteJson(PREFERENCES_FILE, next);
  try { fs.chmodSync(PREFERENCES_FILE, 0o600); } catch {}
  return { ...next };
}

/** 是否启用 complete_task 显式完成声明（每轮任务开始时读一次，立即生效）。 */
export function completeTaskEnabled() {
  return readRuntimePreferences().completeTaskEnabled === true;
}

/** 偏好文件路径（诊断用）。 */
export function runtimePreferencesFile() {
  return PREFERENCES_FILE;
}
