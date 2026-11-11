/**
 * 地图导出执行器（2026-11-11-004 §3.2）：G7 批量导出与 agent `map_export` 工具共用的截图管线。
 *
 * 从 server/index.mjs 原样抽取（行为零变更），职责单一：
 *   专用浏览器会话（map-export|batch，独立实例不干扰用户面板）→ 打开 /?export=map 导出视图
 *   → 视口设为目标尺寸 → 轮询就绪 → PNG 截图 / printToPDF → 写盘到指定目录。
 *
 * 单飞闸门：内置浏览器会话 `map-export|batch` 全局只有一条，同一时刻只允许一个任务在跑；
 * G7 批量导出（batchId 为 owner）与 agent 导出（"agent" 为 owner）共用同一闸门，冲突方收到明确错误。
 * 产物目录由调用方决定：G7 落 `workspace/地图导出/`，agent 落 `maps/{project}/agent/exports/`。
 */
import fs from "node:fs";
import path from "node:path";

let activeOwner = ""; // 单飞闸门：同一浏览器会话串行复用，同一时刻只允许一个任务在跑

export const EXPORT_SESSION_KIND = "map-export";
export const EXPORT_SESSION_ID = "batch";

/** 原子占用导出槽位；占用成功返回 true，已被占用返回 false。 */
export function tryAcquireExportSlot(owner) {
  const key = String(owner || "").trim();
  if (!key || activeOwner) return false;
  activeOwner = key;
  return true;
}

/** 释放导出槽位（仅 owner 本人可释放）。 */
export function releaseExportSlot(owner) {
  if (activeOwner === String(owner || "")) activeOwner = "";
}

/** 当前占用者（用于冲突提示）；空串表示空闲。 */
export function currentExportOwner() {
  return activeOwner;
}

/** 导出视图地址：/?export=map&project=…（layers/title 可选）。port 缺省读进程环境（与 index.mjs 同源）。 */
export function buildExportViewUrl(job, port) {
  const resolved = Number(port) || Number(process.env.PORT) || 3002;
  const qs = new URLSearchParams({ export: "map", project: job.project, title: job.title });
  if (job.layers?.length) qs.set("layers", job.layers.join(","));
  return `http://127.0.0.1:${resolved}/?${qs.toString()}`;
}

/**
 * 执行单个导出任务：渲染 → 截图/打印 → 写盘。
 * @param {object} job {project, layers?, width, height, format, fileName, title?}
 * @param {object} opts {workspace, port, outDir?}  outDir 缺省 = workspace/地图导出（G7 口径）
 * @returns {Promise<{file: string, bytes: number}>}
 */
export async function executeExportJob(job, { workspace, port, outDir } = {}) {
  const browser = await import("./内置浏览器.mjs");
  const key = browser.browserSessionKey(EXPORT_SESSION_KIND, EXPORT_SESSION_ID);
  await browser.browserOpen(key, buildExportViewUrl(job, port));
  await browser.browserResize(key, job.width, job.height);
  await browser.browserWaitForExpression(key, "window.__OAW_EXPORT_READY === true", { timeoutMs: 45000 });
  const pageError = await browser.browserEvaluateValue(key, "window.__OAW_EXPORT_ERROR || ''").catch(() => "");
  if (pageError) throw new Error(`导出视图异常：${pageError}`);
  const capture = job.format === "pdf"
    ? await browser.browserPrintToPdf(key)
    : await browser.browserScreenshot(key, { format: "png" });
  const dir = outDir || path.join(workspace, "地图导出");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, job.fileName);
  if (!target.startsWith(path.resolve(workspace))) throw new Error("导出产物路径越界");
  fs.writeFileSync(target, Buffer.from(capture.base64 || "", "base64"));
  return { file: target, bytes: Buffer.byteLength(capture.base64 || "", "base64") };
}
