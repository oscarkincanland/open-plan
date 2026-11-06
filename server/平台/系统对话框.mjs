/**
 * 系统原生文件对话框（平台适配层，ADR 0024）。
 *
 * 现状：web 形态下服务端用 PowerShell 弹 FolderBrowserDialog（见 server/原生文件.mjs）。
 * 桌面形态下改由 Electron preload 的原生对话框承担（渲染进程直接调），
 * 服务端这份保留给 web 形态使用，两边语义一致（返回绝对路径或空）。
 *
 * 本模块只做「语言中立」的路径校验与结果规范化，不 import electron。
 */

import path from "node:path";
import fs from "node:fs";
import { isDesktop } from "./宿主信息.mjs";

/**
 * 校验用户选中的路径是否可用于当前工作区操作。
 * 桌面端与 web 端共用同一套边界规则：必须是已存在的目录、不得为空。
 * @param {string} target
 * @returns {{ok:boolean, reason?:string, resolved?:string}}
 */
export function validatePickedPath(target) {
  const raw = String(target || "").trim();
  if (!raw) return { ok: false, reason: "路径为空" };
  const resolved = path.resolve(raw);
  try {
    if (!fs.statSync(resolved).isDirectory()) return { ok: false, reason: "不是目录" };
  } catch {
    return { ok: false, reason: "目录不存在" };
  }
  return { ok: true, resolved };
}

/** 当前宿主是否需要服务端弹窗（桌面端由渲染进程直接调原生对话框）。 */
export function needsServerDialog() {
  return !isDesktop();
}
