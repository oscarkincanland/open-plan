/**
 * 客户端构建标识（判断"页面跑的是不是最新前端"）。
 *
 * ## 为什么需要
 *
 * `client/dist/index.html` 已经是 `no-store`、`assets/*` 带内容 hash 且强缓存，
 * 所以**手动刷新一定能拿到新构建**。但浏览器不会主动重新拉取 index.html：
 * 部署新构建后，已经打开的页面会一直跑旧代码。
 *
 * 叠加 `dist/assets` 刻意保留历史包（旧页面懒加载 chunk 不 404），旧页面连
 * "分包 404 → 自动刷新"这条兜底都触发不了。结果就是：修复已上线，用户看到的
 * 还是老行为（2026-11-02 的会话加载超时修复就是这样被误判为"没修好"的）。
 *
 * ## 做法
 *
 * 服务端从当前的 index.html 里取出入口脚本名（`/assets/index-<hash>.js`），
 * 经 /api/status 的 `clientBuild` 下发；前端拿自己**实际加载**的入口脚本名比对，
 * 不一致就提示刷新。不引入构建插件、不改 index.html 生成方式。
 */

import fs from "node:fs";
import path from "node:path";
import { CLIENT_DIST } from "./workspace.mjs";

const INDEX_FILE = path.join(CLIENT_DIST, "index.html");
// 入口脚本：Vite 产出形如 /assets/index-4rjN3GS-.js（也可能带 base 前缀）。
const ENTRY_PATTERN = /<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/i;

let cache = { mtimeMs: -1, build: "" };

/**
 * 当前构建的入口标识（入口脚本文件名，如 `index-4rjN3GS-.js`）。
 * 读不到 index.html 时返回空串——调用方必须把它当作"未知"，不能当作"最新"。
 */
export function clientBuildId() {
  try {
    const stat = fs.statSync(INDEX_FILE);
    if (stat.mtimeMs === cache.mtimeMs) return cache.build;
    const html = fs.readFileSync(INDEX_FILE, "utf8");
    const match = html.match(ENTRY_PATTERN);
    const build = match ? path.basename(match[1]) : "";
    cache = { mtimeMs: stat.mtimeMs, build };
    return build;
  } catch {
    return "";
  }
}

/** 从任意入口脚本地址里取构建标识（前端与服务端共用同一口径）。 */
export function buildIdFromScriptSrc(src) {
  const value = String(src || "").trim();
  if (!value) return "";
  const name = value.split(/[?#]/)[0].split("/").pop() || "";
  return /^index-.*\.js$/i.test(name) ? name : "";
}

/** 诊断：当前解析出的 index.html 路径与构建标识。 */
export function clientBuildInfo() {
  return { indexFile: INDEX_FILE, exists: fs.existsSync(INDEX_FILE), build: clientBuildId() };
}
