#!/usr/bin/env node
/**
 * 聊天界面冒烟检查（真实浏览器渲染，能抓到 ReferenceError 这类"组件出错"）
 *
 * 用 Playwright 打开本机服务，检查：
 *   - 是否出现错误边界文案（"组件出错，请刷新页面" / "应用出错"）
 *   - 是否有 pageerror / console.error
 *   - 执行流单行状态栏是否渲染、文案是否合理
 *   - 是否还残留旧的两行 .execution-flow-status / .execution-flow-progress
 * 并输出一张截图便于人工核对。
 *
 * 用法:
 *   node scripts/聊天界面冒烟检查.mjs                 # 自动取最近一轮 Run 的会话
 *   node scripts/聊天界面冒烟检查.mjs <baseUrl> <clientId> <sessionId> <workspace> [截图路径]
 *
 * 依赖: playwright（本机若装在其它项目也可，脚本会自动搜索常见路径）
 *   npm run smoke:chat
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://127.0.0.1:3002";
const SHOT = process.argv[6] || path.join(os.tmpdir(), `oaw-chat-smoke-${Date.now()}.png`);

/** playwright 可能装在别处（本项目未声明该依赖），按常见位置依次尝试。 */
function loadChromium() {
  const candidates = [
    path.join(PROJECT_DIR, "node_modules"),
    path.join(PROJECT_DIR, "client", "node_modules"),
    path.join(PROJECT_DIR, "..", "pi-web"),
    path.join(process.env.APPDATA || "", "npm", "node_modules"),
  ];
  for (const dir of candidates) {
    try {
      const require = createRequire(path.join(dir, "noop.js"));
      return require("playwright").chromium;
    } catch {}
  }
  throw new Error("未找到 playwright：请先 npm i -D playwright（或在本机任意项目安装后重跑）");
}

async function resolveTarget() {
  if (process.argv[2] && process.argv[3] && process.argv[4]) {
    return { clientId: process.argv[3], sessionId: process.argv[4], workspace: process.argv[5] || "" };
  }
  const runs = await fetch(`${BASE}/api/runs?limit=1`).then((r) => r.json()).catch(() => null);
  const latest = runs?.runs?.[0];
  const sessions = await fetch(`${BASE}/api/sessions`).then((r) => r.json()).catch(() => null);
  const list = sessions?.sessions || [];
  const session = list.find((item) => latest?.threadId && item.threadId === latest.threadId) || list[0] || {};
  return {
    clientId: latest?.clientId || "smoke-client",
    sessionId: session.id || latest?.sessionId || "",
    workspace: session.cwd || latest?.cwd || "",
  };
}

const chromium = loadChromium();
const target = await resolveTarget();

const errors = [];
const consoleErrors = [];
let browser;
for (const opts of [{}, { channel: "msedge" }, { channel: "chrome" }]) {
  try { browser = await chromium.launch({ headless: true, ...opts }); break; } catch {}
}
if (!browser) {
  console.error("无法启动浏览器：请确认已安装 chromium/Edge/Chrome");
  process.exit(1);
}

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.addInitScript(({ clientId, sessionId, workspace }) => {
    localStorage.setItem("oaw_client_id", clientId);
    localStorage.setItem("oaw_ui_state_v1", JSON.stringify({ workspace, lastSessionId: sessionId, sidebarOpen: true }));
  }, target);

  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(9000);

  const state = await page.evaluate(() => {
    const head = document.querySelector(".execution-flow-head");
    return {
      boundary: document.querySelector(".chat-error-boundary")?.innerText || "",
      appError: document.querySelector(".app-error")?.innerText || "",
      hasFlow: Boolean(document.querySelector(".execution-flow")),
      flowText: head ? head.innerText.replace(/\s+/g, " ").trim() : "",
      hoverTitle: document.querySelector(".execution-flow-head .execution-flow-toggle")?.getAttribute("title") || "",
      legacyRows: document.querySelectorAll(".execution-flow-status, .execution-flow-progress").length,
      messages: document.querySelectorAll(".msg").length,
    };
  });

  await page.screenshot({ path: SHOT });

  const lines = [];
  lines.push(`目标: client=${target.clientId} session=${target.sessionId} workspace=${target.workspace || "(未指定)"}`);
  lines.push(`错误边界: ${state.boundary ? `✗ ${state.boundary.replace(/\s+/g, " ")}` : "✓ 无"}`);
  lines.push(`应用错误页: ${state.appError ? `✗ ${state.appError.replace(/\s+/g, " ")}` : "✓ 无"}`);
  lines.push(`pageerror: ${errors.length ? `✗ ${errors.join(" | ")}` : "✓ 无"}`);
  lines.push(`console.error: ${consoleErrors.length ? `✗ ${consoleErrors.slice(0, 2).join(" | ")}` : "✓ 无"}`);
  lines.push(`执行流: ${state.hasFlow ? "✓ 已渲染" : "（未渲染：该会话可能没有运行事件）"}`);
  if (state.flowText) lines.push(`  文案: ${state.flowText}`);
  if (state.hoverTitle) lines.push(`  悬停: ${state.hoverTitle}`);
  lines.push(`旧的两行: ${state.legacyRows === 0 ? "✓ 已无" : `✗ 仍有 ${state.legacyRows} 行`}`);
  lines.push(`消息条数: ${state.messages}`);
  lines.push(`截图: ${SHOT}`);
  console.log(lines.join("\n"));

  const failed = Boolean(state.boundary || state.appError || errors.length || state.legacyRows);
  process.exit(failed ? 1 : 0);
} finally {
  await browser.close();
}
