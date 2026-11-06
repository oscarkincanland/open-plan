#!/usr/bin/env node
/**
 * 桌面端产物冒烟测试（不依赖 GUI）。
 *
 * 本环境无法启动 Electron 窗口（与 Edge 一样被沙箱拦），因此用「启动打包目录里的服务、
 * 真实发 HTTP 请求」的方式验证桌面产物是否可用：SPA 能否加载、静态资源是否齐全、
 * 关键 API 是否工作、运行开关是否按桌面期望生效。
 *
 * 用法:
 *   node scripts/桌面/产物冒烟.mjs                      # 默认测 desktop/dist-app/win-unpacked
 *   node scripts/桌面/产物冒烟.mjs --dir <win-unpacked 目录>
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir") >= 0 ? args[args.indexOf("--dir") + 1] : "";
const UNPACKED = path.resolve(dirArg || path.join(ROOT, "desktop", "dist-app", "win-unpacked"));
const APP_DIR = path.join(UNPACKED, "resources", "app");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log(`\n▶ 产物冒烟：${UNPACKED}\n`);

  // ---- 0. 产物结构 ----
  console.log("▶ 产物结构");
  const required = [
    "GuiJu.exe",
    "resources/app.asar",
    "resources/app/server/index.mjs",
    "resources/app/server/服务入口.mjs",
    "resources/app/client/dist/index.html",
    "resources/app/scripts/lib/tiler.mjs",
    "resources/app/node_modules/express/package.json",
    "resources/bin/清单.json",
  ];
  for (const rel of required) {
    check(`存在 ${rel}`, fs.existsSync(path.join(UNPACKED, rel)));
  }

  // ---- 1. 启动服务 ----
  console.log("\n▶ 启动打包目录内的服务");
  const entryUrl = pathToFileURL(path.join(APP_DIR, "server", "服务入口.mjs")).href;
  const { startDesktopService } = await import(entryUrl);
  const svc = await startDesktopService({
    projectDir: APP_DIR,
    userDataDir: path.join(process.env.TEMP || APP_DIR, "oaw-smoke"),
    resourcesDir: path.join(UNPACKED, "resources"),
    clientDist: path.join(APP_DIR, "client", "dist"),
  });
  const base = svc.url;
  check("服务监听随机端口", svc.port > 0 && svc.port !== 3002, `port=${svc.port}`);
  check("签发 API token", (svc.token || "").length >= 32, `len=${svc.token.length}`);

  const auth = { headers: { Authorization: `Bearer ${svc.token}` } };

  // ---- 2. SPA ----
  console.log("\n▶ SPA 与静态资源");
  const index = await fetch(`${base}/`);
  const html = await index.text();
  check("GET / 返回 200", index.status === 200, String(index.status));
  check("返回 HTML", /text\/html/.test(index.headers.get("content-type") || ""));
  check("HTML 含应用挂载点", /<div id="root"/.test(html) || /id="root"/.test(html));
  const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((m) => m[1]);
  check("HTML 引用前端资源", assets.length > 0, `${assets.length} 个`);
  let assetOk = 0;
  for (const asset of assets.slice(0, 6)) {
    const res = await fetch(new URL(asset, base).href);
    if (res.ok) assetOk += 1;
    await res.arrayBuffer();
  }
  check("前端资源可加载", assetOk === Math.min(assets.length, 6), `${assetOk}/${Math.min(assets.length, 6)}`);

  // ---- 3. 关键 API ----
  console.log("\n▶ 关键 API");
  const endpoints = ["/api/status", "/api/sessions", "/api/workspaces", "/api/models", "/api/browser/state?client=smoke&thread=t"];
  for (const ep of endpoints) {
    try {
      const res = await fetch(base + ep, auth);
      check(`GET ${ep}`, res.ok, String(res.status));
      await res.arrayBuffer();
    } catch (error) {
      check(`GET ${ep}`, false, String(error?.message || error).slice(0, 80));
    }
  }

  // ---- 4. 鉴权 ----
  console.log("\n▶ 鉴权");
  const noToken = await fetch(`${base}/api/sessions`);
  check("无 token 访问 API 被拒", noToken.status === 401 || noToken.status === 403, String(noToken.status));
  await noToken.arrayBuffer();

  // ---- 5. 桌面期望的运行开关 ----
  console.log("\n▶ 桌面形态下的运行开关");
  try {
    const res = await fetch(`${base}/api/status`, auth);
    const body = await res.text();
    let flags = null;
    try { flags = JSON.parse(body); } catch { flags = null; }
    const flat = JSON.stringify(flags || {});
    check("status 可解析", Boolean(flags), flags ? "ok" : "非 JSON");
    check("CAD 预览默认开", /"cadPreview":\s*true/.test(flat), flat.includes('"cadPreview":true') ? "cadPreview=true" : "未取到");
    check("CAD 写入默认关", /"cadAgent":\s*false/.test(flat), flat.includes('"cadAgent":false') ? "cadAgent=false" : "未取到");
  } catch (error) {
    check("status 可解析", false, String(error?.message || error).slice(0, 80));
  }

  // ---- 6. 外部二进制解析 ----
  console.log("\n▶ 外部二进制解析（桌面 resources/bin 优先）");
  try {
    const binMod = await import(pathToFileURL(path.join(APP_DIR, "server", "平台", "外部二进制.mjs")).href);
    const report = binMod.externalBinaryReport();
    check("外部二进制报告可生成", Boolean(report), JSON.stringify(report.bundledBinDir || "").slice(0, 60));
    check(
      "随包目录指向 resources/bin",
      String(report.bundledBinDir || "").includes(path.join("resources", "bin")),
      report.bundledBinDir,
    );
  } catch (error) {
    check("外部二进制报告可生成", false, String(error?.message || error).slice(0, 100));
  }

  // ---- 7. 浏览器驱动 ----
  console.log("\n▶ 浏览器驱动");
  try {
    const drv = await import(pathToFileURL(path.join(APP_DIR, "server", "平台", "浏览器驱动.mjs")).href);
    check("未注入宿主时回落 system", drv.currentBrowserDriver() === "system", drv.currentBrowserDriver());
    check("可查询宿主注入状态", typeof drv.hasEmbeddedBrowserHost === "function");
  } catch (error) {
    check("浏览器驱动模块可加载", false, String(error?.message || error).slice(0, 100));
  }

  await svc.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  }
  console.log(failed.length ? "\n产物冒烟：失败" : "\n产物冒烟：全部通过");
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(failed.length ? 1 : 0), 150);
}

main().catch((error) => {
  console.error(`冒烟脚本异常：${String(error?.stack || error)}`);
  process.exit(1);
});
