/**
 * 外部打开 / 文件管理器定位（平台适配层，ADR 0024）。
 *
 * 桌面：Electron shell（openPath / showItemInFolder）；
 * 浏览器：回退到既有服务端接口（/api/native/*），行为与历史一致。
 */

import { hostBridge } from "./宿主.js";

/** 用系统默认应用打开某路径。 */
export async function 用系统打开(target) {
  const bridge = hostBridge();
  if (typeof bridge?.openPath === "function") {
    const result = await bridge.openPath(target);
    return { ok: Boolean(result?.ok), error: result?.error || "" };
  }
  try {
    const res = await fetch("/api/native/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    return { ok: res.ok, error: res.ok ? "" : `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** 在文件管理器中定位某路径。 */
export async function 在文件夹中显示(target) {
  const bridge = hostBridge();
  if (typeof bridge?.showItemInFolder === "function") {
    const result = await bridge.showItemInFolder(target);
    return { ok: Boolean(result?.ok), error: "" };
  }
  try {
    const res = await fetch("/api/native/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    return { ok: res.ok, error: res.ok ? "" : `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
