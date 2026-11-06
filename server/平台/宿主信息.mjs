/**
 * 宿主信息（平台适配层，ADR 0024）。
 *
 * 为什么需要：同一份源码要跑在两种宿主里——
 *   web    ：`scripts/服务监督.mjs` 起独立 Node 进程，项目目录 = 仓库根目录；
 *   desktop：Electron 主进程 `import` 本服务，项目目录被拆成「只读应用目录」与「可写用户目录」。
 * 业务模块只问「可写目录在哪」「资源目录在哪」，不问「是不是桌面」。
 *
 * 约定：本模块**禁止** import 业务代码，也禁止 import 'electron'
 *       （由 `scripts/平台边界检查.mjs` 守护）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（server/平台/ → server/ → 根）。 */
export const PROJECT_DIR = path.resolve(__dirname, "..", "..");

/** 是否运行在桌面宿主内。由 desktop 主进程在启动服务前注入。 */
export function isDesktop() {
  return String(process.env.OAW_DESKTOP || "") === "1";
}

/** 只读资源目录：桌面端为 `resources/`，web 端为仓库根。 */
export function resourcesDir() {
  const explicit = String(process.env.OAW_RESOURCES_DIR || "").trim();
  if (explicit) return explicit;
  if (!isDesktop()) return PROJECT_DIR;
  // Electron 打包后 resourcesPath 由主进程注入；兜底用可执行文件同级 resources
  return path.join(path.dirname(process.execPath), "resources");
}

/**
 * 可写根目录：桌面端为 `%APPDATA%/open-plan`（或注入的 OAW_USER_DATA_DIR），
 * web 端为仓库根（历史行为，零变化）。
 */
export function userDataDir() {
  const explicit = String(process.env.OAW_USER_DATA_DIR || "").trim();
  if (explicit) return explicit;
  if (!isDesktop()) return PROJECT_DIR;
  const base = process.env.APPDATA
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Roaming");
  return path.join(base, "open-plan");
}

/** 启动时确保可写目录存在（桌面端首次运行）。 */
export function ensureUserDataDir() {
  const dir = userDataDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * 运行时状态目录（`.oaw/`、`.sessions/`、`.规聚会话/`）的根。
 * web 端 = 仓库根（与历史一致）；桌面端 = 用户数据目录（程序目录只读）。
 */
export function runtimeStateDir() {
  return isDesktop() ? ensureUserDataDir() : PROJECT_DIR;
}
