#!/usr/bin/env node
/**
 * Open Plan（规聚）命令行入口
 *
 * 用法（在任意终端）：
 *   guiju               启动服务（如未运行）并打开浏览器
 *   guiju --no-open     只启动/确认服务，不打开浏览器
 *   guiju --status      查看服务状态（版本/PID/启动时间/开关摘要）
 *   guiju --stop        停止服务（连同后台监督进程，释放 3002 端口）
 *   guiju --foreground  前台运行监督进程（Ctrl+C 退出）
 *   guiju --port 3003   指定端口（默认 3002）
 *
 * 说明：默认调用 scripts/服务监督.mjs 以“后台监督”模式启动；服务异常退出会被自动拉起。
 * 停止时直接复用仓库内的“停止规聚服务.ps1”（它会先停监督进程再停服务，避免被拉回）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISOR = path.join(ROOT, "scripts", "服务监督.mjs");
const STOP_SCRIPT = path.join(ROOT, "停止规聚服务.ps1");

function parseArgs(argv = []) {
  const options = { action: "open", open: true, port: Number.parseInt(process.env.PORT || "3002", 10) || 3002, extra: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === "--no-open") options.open = false;
    else if (arg === "--status" || arg === "-s") options.action = "status";
    else if (arg === "--stop") options.action = "stop";
    else if (arg === "--foreground") options.action = "foreground";
    else if (arg === "--help" || arg === "-h") options.action = "help";
    else if (arg === "--port") {
      const value = Number.parseInt(String(argv[i + 1] || ""), 10);
      if (Number.isFinite(value) && value > 0) { options.port = value; i += 1; }
    } else options.extra.push(arg);
  }
  return options;
}

function baseUrl(port) { return `http://127.0.0.1:${port}`; }

function getHealth(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/status", timeout: timeoutMs, headers: { Accept: "application/json", Connection: "close" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve({ ok: response.statusCode === 200, status: JSON.parse(body) }); }
        catch { resolve({ ok: false, error: `返回内容不是 JSON（HTTP ${response.statusCode}）` }); }
      });
    });
    request.on("timeout", () => { request.destroy(); resolve({ ok: false, error: "健康检查超时" }); });
    request.on("error", (error) => resolve({ ok: false, error: String(error?.code || error?.message || error) }));
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function printStatus(status) {
  const enabled = Object.entries(status.runtimeFlags || {})
    .filter(([key, value]) => value === true && ["skillDeps", "interactionHub", "composerUnified", "writingOneShot", "writingLeanContext", "askAssumption", "writingBudget"].includes(key))
    .map(([key]) => key);
  console.log(`[规聚] 运行中：${baseUrl("3002")}`);
  console.log(`  版本        ${status.version || "?"}（客户端构建 ${status.clientBuild || "?"}）`);
  if (status.service) console.log(`  服务 PID    ${status.service.pid}（已运行 ${Math.round(Number(status.service.uptimeSec || 0) / 60)} 分钟）`);
  console.log(`  新功能开关  ${enabled.length ? enabled.join("、") : "全部关闭（基线行为）"}`);
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch (error) {
    console.log(`[规聚] 无法自动打开浏览器：${error?.message || error}；请手动访问 ${url}`);
    return false;
  }
}

function startSupervisor({ port, foreground }) {
  const env = { ...process.env, PORT: String(port) };
  const child = spawn(process.execPath, [SUPERVISOR, foreground ? "--foreground" : "--background"], {
    cwd: ROOT,
    env,
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    windowsHide: !foreground,
  });
  if (!foreground) child.unref();
  return child;
}

function stopService() {
  return new Promise((resolve) => {
    if (process.platform === "win32" && fs.existsSync(STOP_SCRIPT)) {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", STOP_SCRIPT, "-Quiet"], { cwd: ROOT, stdio: "inherit", windowsHide: false });
      child.on("exit", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    } else {
      // 非 Windows：停监督进程与 server/index.mjs
      try {
        const ps = spawn("pkill", ["-f", "服务监督.mjs"], { stdio: "ignore" });
        ps.on("exit", () => {
          spawn("pkill", ["-f", "server/index.mjs"], { stdio: "ignore" }).on("exit", () => resolve(true));
        });
      } catch { resolve(false); }
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.action === "help") {
    console.log(`规聚命令行：
  guiju                启动（如未运行）并打开浏览器
  guiju --no-open      只启动/确认服务
  guiju --status       查看状态
  guiju --stop         停止服务
  guiju --foreground   前台运行（Ctrl+C 退出）
  guiju --port 3003    指定端口`);
    return 0;
  }

  if (options.action === "status") {
    const health = await getHealth(options.port);
    if (!health.ok) { console.log(`[规聚] 未运行（${health.error || "无法连接"}）；可执行 guiju 启动`); return 1; }
    printStatus(health.status);
    return 0;
  }

  if (options.action === "stop") {
    console.log("[规聚] 正在停止服务 ...");
    const ok = await stopService();
    if (ok) console.log("[规聚] 服务已停止，端口已释放。");
    else console.log("[规聚] 停止命令执行失败，请检查 3002 端口占用。");
    return ok ? 0 : 1;
  }

  if (options.action === "foreground") {
    console.log(`[规聚] 前台启动监督进程（${baseUrl(options.port)}），Ctrl+C 退出`);
    startSupervisor({ port: options.port, foreground: true });
    return 0;
  }

  // 默认：启动（如需要）并打开
  const existing = await getHealth(options.port);
  if (existing.ok) {
    console.log("[规聚] 服务已在运行，直接打开。");
    printStatus(existing.status);
    if (options.open) openBrowser(baseUrl(options.port));
    return 0;
  }

  console.log(`[规聚] 服务未运行，正在后台启动（端口 ${options.port}）...`);
  startSupervisor({ port: options.port, foreground: false });
  const deadline = Date.now() + 180_000;
  let lastError = "";
  while (Date.now() < deadline) {
    await sleep(1500);
    const health = await getHealth(options.port);
    if (health.ok) {
      console.log("[规聚] 启动完成。");
      printStatus(health.status);
      if (options.open) openBrowser(baseUrl(options.port));
      return 0;
    }
    lastError = health.error || "";
  }
  console.log(`[规聚] 启动超时（${lastError || "健康检查未通过"}）。`);
  console.log(`  查看日志：${path.join(ROOT, "运行日志", "服务监督.log")}`);
  return 1;
}

const code = await main();
process.exit(Number.isInteger(code) ? code : 0);
