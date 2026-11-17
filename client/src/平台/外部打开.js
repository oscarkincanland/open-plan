/**
 * 外部打开 / 文件管理器定位（平台适配层，ADR 0024）。
 *
 * 桌面：Electron shell（openPath / showItemInFolder）；
 * 浏览器：回退到服务端接口（/api/system/open、/api/system/reveal），行为与历史一致。
 *
 * 2026-11-11-011：本模块此前指向并不存在的 /api/native/*，且全仓无引用，属死代码；
 * 改为真实端点后由产物卡的「打开方式」按钮复用。
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
    const res = await fetch("/api/system/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    let payload = null;
    try { payload = await res.json(); } catch {}
    return { ok: res.ok && payload?.ok !== false, error: res.ok ? "" : (payload?.error || `HTTP ${res.status}`) };
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
    const res = await fetch("/api/system/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    let payload = null;
    try { payload = await res.json(); } catch {}
    return { ok: res.ok && payload?.ok !== false, error: res.ok ? "" : (payload?.error || `HTTP ${res.status}`) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
