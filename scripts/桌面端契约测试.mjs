#!/usr/bin/env node
/**
 * 桌面端契约测试（ADR 0024）。
 *
 * 桌面端在本环境无法真正启动 GUI（与 Edge 一样被沙箱拦），所以这里用**可执行的静态契约**
 * 把「壳优先」的关键接线钉住，防止后续改动悄悄破坏：
 *
 *   1. 服务入口：桌面主进程能拿到「随机端口 + token」，且服务真能在该端口起 SPA
 *      （用真实 node 进程验证，不依赖 Electron）
 *   2. 外壳接线：main.cjs 起服务 → 建窗口 → 注入内嵌浏览器宿主 → 退出清理
 *   3. 浏览器双驱动：embedded 分支存在且 system 路径逐字保留（web 形态不受影响）
 *   4. 打包配置：asarUnpack bin、extraResources 带 server/client/bin/node_modules
 *   5. 安全：nodeIntegration=false、contextIsolation=true、preload 不暴露 ipcRenderer
 *
 * 用法: node scripts/桌面端契约测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

console.log("\n▶ 1. 服务入口（真实启动验证）");
await test("桌面服务入口：随机端口 + token + SPA 可访问 + 强制鉴权", async () => {
  // 放到子进程里跑：桌面服务与 Electron 同进程，测试进程内起停会与 libuv 收尾竞争。
  const { spawnSync } = await import("node:child_process");
  const script = path.join(ROOT, "scripts", "桌面", "服务自检.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, OAW_DISABLE_RECOVERY: "1" },
  });
  const out = String(result.stdout || "");
  const err = String(result.stderr || "");
  assert.match(out, /SELF_CHECK_OK=1/, `子进程应输出 SELF_CHECK_OK；stderr=${err.slice(0, 400)}`);
  const port = Number((out.match(/SELF_CHECK_PORT=(\d+)/) || [])[1]);
  assert.ok(port > 0 && port !== 3002, `应使用随机端口（实际 ${port}）`);
  const tokenLen = Number((out.match(/SELF_CHECK_TOKEN_LEN=(\d+)/) || [])[1]);
  assert.ok(tokenLen >= 32, `应生成足够长的 API token（实际 ${tokenLen}）`);
  const rootLine = (out.match(/SELF_CHECK_ROOT=(\d+):([^\n]+)/) || []);
  assert.equal(Number(rootLine[1]), 200, "根路径应返回 200");
  assert.match(rootLine[2] || "", /text\/html/, "根路径应返回 SPA HTML");
  const authStatus = Number((out.match(/SELF_CHECK_AUTH=(\d+)/) || [])[1]);
  assert.ok(authStatus === 401 || authStatus === 403, `无 token 的 API 应被拒（实际 ${authStatus}）`);
});

console.log("\n▶ 2. 外壳接线");
await test("main.cjs：起服务 → 建窗口 → 注入浏览器宿主 → 退出清理", () => {
  const main = read("desktop/src/main.cjs");
  assert.match(main, /const \{ app, BrowserWindow, shell, dialog, ipcMain \} = require\("electron"\)/, "应使用 CJS 外壳（Electron 33 ESM 主进程不兼容）");
  assert.match(main, /requestSingleInstanceLock/, "应做单实例锁");
  assert.match(main, /bootService\(\)/, "应在本进程内启动服务");
  assert.match(main, /state\.browserHost = createEmbeddedBrowserHost\(\{ getWindow: \(\) => state\.window \}\)/, "应注入内嵌浏览器宿主");
  assert.match(main, /installEmbeddedBrowserHost\(state\.browserHost\)/, "应向 server 侧注册宿主");
  assert.match(main, /disposeAll\(\)/, "退出前应清理原生视图");
  assert.match(main, /setWindowOpenHandler/, "外部链接应拦截并交给系统浏览器");
});

await test("安全基线：nodeIntegration=false / contextIsolation=true / 不暴露 ipcRenderer", () => {
  const main = read("desktop/src/main.cjs");
  assert.match(main, /nodeIntegration: false/, "必须关闭 nodeIntegration");
  assert.match(main, /contextIsolation: true/, "必须开启 contextIsolation");
  const preload = read("desktop/src/preload.cjs");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("__OAW_HOST__"/, "应只暴露白名单桥");
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\b/, "不得把 ipcRenderer 本体暴露给渲染进程");
  assert.match(preload, /browser:\s*\{/, "应暴露内嵌浏览器视图通道");
});

console.log("\n▶ 3. 浏览器双驱动");
await test("embedded 分支存在；system 路径逐字保留", () => {
  const src = read("server/内置浏览器.mjs");
  assert.match(src, /import \{ currentBrowserDriver, getEmbeddedBrowserHost \} from "\.\/平台\/浏览器驱动\.mjs"/, "应引入驱动注册表");
  assert.match(src, /if \(currentBrowserDriver\(\) === "embedded"\)/, "应有 embedded 分支");
  assert.match(src, /const transport = await host\.attach\(this\.key\)/, "应使用宿主注入的 transport");
  assert.match(src, /内嵌视图模式：页面已经画在窗口里/, "startScreencast 应短路");
  assert.match(src, /if \(this\.embedded\) return null/, "captureFrame 应短路");
  // system 路径的关键调用必须仍在（web 形态零变化）
  assert.match(src, /findBrowserExecutable\(\)/, "system 驱动仍应探测系统浏览器");
  assert.match(src, /new CdpConnection\(browserWs\)/, "system 驱动仍应走 CDP WebSocket");
  const driver = read("server/平台/浏览器驱动.mjs");
  assert.match(driver, /EXPLICIT|OAW_BROWSER_DRIVER/, "应有驱动开关 OAW_BROWSER_DRIVER");
  assert.match(driver, /return embeddedHost \? "embedded" : "system"/, "未注入宿主时应回落 system");
});

console.log("\n▶ 4. 打包配置");
await test("electron-builder.yml：asarUnpack bin + extraResources 全量", () => {
  const conf = read("desktop/electron-builder.yml");
  assert.match(conf, /asar: true/, "应启用 asar");
  assert.match(conf, /asarUnpack:\s*\n\s*- "\*\*\/bin\/\*\*"/, "bin/ 必须解包（子进程不能从 asar 执行）");
  for (const item of ["app/server", "app/client/dist", "app/node_modules", "bin"]) {
    assert.ok(conf.includes(item), `extraResources 应包含 ${item}`);
  }
  assert.match(conf, /target: nsis/, "应产出 NSIS 安装包");
  assert.match(conf, /oneClick: false/, "应允许选择安装目录（M2 体验）");
});

await test("随包二进制：清单入库 + 校验脚本拒绝未知二进制", () => {
  assert.ok(exists("bin/清单.json"), "bin/清单.json 应入库（bin/ 本身被 gitignore）");
  const manifest = JSON.parse(read("bin/清单.json"));
  assert.ok(Array.isArray(manifest.items), "清单应含 items 数组");
  assert.ok(manifest.policy?.libredwg?.includes("随包"), "应声明 LibreDWG 随包策略");
  assert.ok(manifest.policy?.oda?.includes("不随包"), "应声明 ODA 不随包策略");
  const prep = read("scripts/桌面/准备随包二进制.mjs");
  assert.match(prep, /sha256/, "应按 sha256 校验");
  assert.match(prep, /process\.exit\(1\)/, "校验失败应中止（退出码 1）");
});

console.log("\n▶ 5. 平台能力桥（渲染进程侧）");
await test("宿主探测与原生能力回退", () => {
  const host = read("client/src/平台/宿主.js");
  assert.match(host, /export function isDesktopHost/, "应能探测桌面宿主");
  assert.match(host, /__OAW_HOST__/, "应读取 preload 注入的桥");
  assert.match(host, /原生文件对话框/, "应暴露能力表（问能力不问形态）");
  const dialogs = read("client/src/平台/文件对话框.js");
  assert.match(dialogs, /选择文件/, "应提供选择文件");
  assert.match(dialogs, /选择目录/, "应提供选择目录");
  assert.match(dialogs, /unsupported: true/, "浏览器形态应显式标注目录选择不支持（降级可见）");
  const embedded = read("client/src/平台/内嵌浏览器.js");
  assert.match(embedded, /是内嵌浏览器视图/, "应能探测内嵌视图");
  assert.match(embedded, /上报视图边界/, "应能上报面板矩形");
});

await test("面板：内嵌模式不渲染帧、改为上报矩形", () => {
  const panel = read("client/src/components/内置浏览器面板.jsx");
  assert.match(panel, /是内嵌浏览器视图/, "面板应探测内嵌模式");
  assert.match(panel, /上报视图边界\(会话键, payload\)/, "应上报矩形");
  assert.match(panel, /设置视图可见\(会话键/, "应同步可见性");
  assert.match(panel, /browser-embedded-host/, "内嵌模式应渲染占位容器");
  const css = read("client/src/styles.css");
  assert.match(css, /\.browser-embedded-host/, "应有内嵌视图占位样式");
});

console.log(failed ? "\n桌面端契约测试：失败" : "\n桌面端契约测试：全部通过");
process.exit(failed ? 1 : 0);
