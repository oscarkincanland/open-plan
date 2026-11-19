#!/usr/bin/env node
/**
 * 路由唯一性与注册顺序测试（静态）
 *
 * 守护三条约束：
 * 1. 所有路由注册（server/index.mjs + server/路由/*.mjs）中，同一 method + path 只能注册一次；
 * 2. 任何 /api 路由都不得注册在 `/api` 404 兜底之后（否则请求会被兜底拦截，接口恒 404）；
 * 3. server/路由/ 下的分组必须被 index.mjs 通过 registerXxxRoutes(app, ...) 调用，
 *    有效注册位置按该调用所在行计算，避免“模块写了但没挂载”。
 *
 * 依据：docs/plans/2026-11-18-006-死路由清理与C4收敛及路由分组拆分方案.md 批次 1 / 批次 3。
 * 纯静态：只读源码，不启动服务、不写文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_FILE = path.join(ROOT, "server", "index.mjs");
const ROUTES_DIR = path.join(ROOT, "server", "路由");

const ROUTE_RE = /^\s*app\.(get|post|put|delete|patch|all)\(\s*["'`]([^"'`]+)["'`]/;
const REGISTER_CALL_RE = /^\s*(register\w+Routes)\(\s*app\b/;
const EXPORT_RE = /export\s+function\s+(register\w+Routes)\s*\(/;
const API_404_RE = /^\s*app\.use\(\s*["'`]\/api["'`]\s*,\s*\(\s*(?:_req|req)\s*,\s*res\s*\)\s*=>\s*res\.status\(404\)/;

const indexLines = fs.readFileSync(INDEX_FILE, "utf8").split("\n");

let api404Line = 0;
const routes = [];
const registerCalls = new Map();

indexLines.forEach((line, index) => {
  const lineNo = index + 1;
  if (!api404Line && API_404_RE.test(line)) api404Line = lineNo;
  const call = line.match(REGISTER_CALL_RE);
  if (call) registerCalls.set(call[1], lineNo);
  const route = line.match(ROUTE_RE);
  if (route) routes.push({ file: "server/index.mjs", lineNo, method: route[1].toUpperCase(), routePath: route[2] });
});

const failures = [];
const moduleFiles = fs.existsSync(ROUTES_DIR)
  ? fs.readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".mjs")).sort()
  : [];

for (const name of moduleFiles) {
  const file = `server/路由/${name}`;
  const source = fs.readFileSync(path.join(ROUTES_DIR, name), "utf8");
  const exportName = (source.match(EXPORT_RE) || [])[1];
  if (!exportName) {
    failures.push(`${file} 未导出 registerXxxRoutes(app, deps) 工厂函数`);
    continue;
  }
  const callLine = registerCalls.get(exportName);
  if (!callLine) {
    failures.push(`${file} 的 ${exportName} 未被 server/index.mjs 调用（模块写了但没挂载）`);
    continue;
  }
  source.split("\n").forEach((line, index) => {
    const route = line.match(ROUTE_RE);
    if (route) {
      routes.push({
        file,
        lineNo: index + 1,
        effectiveLine: callLine,
        method: route[1].toUpperCase(),
        routePath: route[2],
      });
    }
  });
}

const seen = new Map();
for (const route of routes) {
  const key = `${route.method} ${route.routePath}`;
  if (!seen.has(key)) seen.set(key, []);
  seen.get(key).push(`${route.file}:${route.lineNo}`);
}
for (const [key, where] of seen) {
  if (where.length > 1) failures.push(`重复注册 ${key}：${where.join("，")}`);
}

if (!api404Line) {
  failures.push("未找到 /api 404 兜底（app.use(\"/api\", ... res.status(404)）");
} else {
  for (const route of routes) {
    const effectiveLine = route.effectiveLine || route.lineNo;
    if (route.routePath.startsWith("/api") && effectiveLine > api404Line) {
      failures.push(`API 注册在 /api 404 兜底之后（第 ${api404Line} 行）：${route.method} ${route.routePath}（${route.file}:${route.lineNo}）`);
    }
  }
}

if (failures.length) {
  console.error(`✗ 路由唯一性检查失败（${failures.length} 项，共 ${routes.length} 条注册）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const moduleRouteCount = routes.length - indexLines.filter((line) => ROUTE_RE.test(line)).length;
console.log(
  `✓ 路由唯一性与注册顺序通过：${routes.length} 条注册（index ${routes.length - moduleRouteCount} + 分组模块 ${moduleRouteCount}）、`
  + `${seen.size} 个唯一 method+path；/api 404 兜底在第 ${api404Line} 行`,
);
