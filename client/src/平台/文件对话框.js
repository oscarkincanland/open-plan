/**
 * 文件/目录选择（平台适配层，ADR 0024）。
 *
 * 桌面：走 preload 暴露的原生对话框；
 * 浏览器：走 <input type=file>（文件）或由调用方给路径文本（目录）。
 *
 * 返回值统一为 { canceled, paths, files? }，调用方不关心实现差异。
 */

import { hostBridge } from "./宿主.js";

/**
 * 选择文件。
 * @param {{accept?: string, multiple?: boolean, title?: string}} [options]
 */
export async function 选择文件(options = {}) {
  const bridge = hostBridge();
  if (typeof bridge?.openFile === "function") {
    const result = await bridge.openFile({
      title: options.title,
      filters: options.accept
        ? [{ name: "可选文件", extensions: String(options.accept).split(",").map((s) => s.trim().replace(/^\./, "")).filter(Boolean) }]
        : undefined,
    });
    return { canceled: Boolean(result?.canceled), paths: result?.paths || [] };
  }
  // 浏览器回退：临时 input（调用方若已有 input 应优先用受控组件）
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options.accept) input.accept = options.accept;
    if (options.multiple) input.multiple = true;
    input.style.display = "none";
    input.onchange = () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve({ canceled: files.length === 0, paths: [], files });
    };
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * 选择目录。
 * @param {{title?: string}} [options]
 * @returns {Promise<{canceled:boolean, paths:string[]}>}
 */
export async function 选择目录(options = {}) {
  const bridge = hostBridge();
  if (typeof bridge?.openDirectory === "function") {
    const result = await bridge.openDirectory({ title: options.title || "选择工作区目录" });
    return { canceled: Boolean(result?.canceled), paths: result?.paths || [] };
  }
  // 浏览器形态没有目录选择能力：显式失败，由调用方给出「请输入路径」提示
  return { canceled: true, paths: [], unsupported: true };
}
