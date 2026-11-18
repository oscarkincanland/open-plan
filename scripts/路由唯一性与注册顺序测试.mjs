#!/usr/bin/env node
/**
 * 路由唯一性与注册顺序测试（静态）
 *
 * 守护两条约束：
 * 1. server/index.mjs 中同一 method + path 只能注册一次（Express 首个同路径处理器生效，
 *    后注册的会成为永远不会执行的死代码）；
 * 2. 任何 /api 路由都不得注册在 `/api` 404 兜底之后（否则请求会被兜底拦截，接口恒 404）。
 *
 * 依据：docs/plans/2026-11-18-006-死路由清理与C4收敛及路由分组拆分方案.md 批次 1。
 * 纯静态：只读源码，不启动服务、不写文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "server", "index.mjs");
const lines = fs.readFileSync(FILE, "utf8").split("\n");

const ROUTE_RE = /^\s*app\.(get|post|put|delete|patch|all)\(\s*["'`]([^"'`]+)["'`]/;
const API_404_RE = /^\s*app\.use\(\s*["'`]\/api["'`]\s*,\s*\(\s*(?:_req|req)\s*,\s*res\s*\)\s*=>\s*res\.status\(404\)/;

const routes = [];
let api404Line = 0;
lines.forEach((line, index) => {
  const lineNo = index + 1;
  if (!api404Line && API_404_RE.test(line)) api404Line = lineNo;
  const match = line.match(ROUTE_RE);
  if (match) routes.push({ lineNo, method: match[1].toUpperCase(), routePath: match[2] });
});

const failures = [];
const seen = new Map();
for (const route of routes) {
  const key = `${route.method} ${route.routePath}`;
  if (!seen.has(key)) seen.set(key, []);
  seen.get(key).push(route.lineNo);
}
for (const [key, lineNos] of seen) {
  if (lineNos.length > 1) failures.push(`重复注册 ${key}：行 ${lineNos.join(", ")}`);
}

if (!api404Line) {
  failures.push("未找到 /api 404 兜底（app.use(\"/api\", ... res.status(404)）");
} else {
  for (const route of routes) {
    if (route.routePath.startsWith("/api") && route.lineNo > api404Line) {
      failures.push(`API 注册在 /api 404 兜底之后（第 ${api404Line} 行）：${route.method} ${route.routePath} @ ${route.lineNo}`);
    }
  }
}

if (failures.length) {
  console.error(`✗ 路由唯一性检查失败（${failures.length} 项，共 ${routes.length} 条注册）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ 路由唯一性与注册顺序通过：${routes.length} 条注册、${seen.size} 个唯一 method+path；/api 404 兜底在第 ${api404Line} 行`);
