#!/usr/bin/env node
/**
 * 界面运行时冒烟（真实浏览器）：只验证"打开一条有消息的会话，界面能不能正常渲染"。
 *
 * 为什么必须有它（见 docs/audits/2026-11-17-全仓缺陷复盘/00-复盘报告.md）：
 *   - `node --check` / `vite build` 抓不到 `transcriptV3 is not defined`、无效 hook 调用这类错误；
 *   - 绝大多数 `test:*` 是"源码字符串断言"，防得住改回去，防不住跑不起来；
 *   - 历史 TDZ 类缺陷出现过 6 次，变更日志原话："verify、CI 全绿都发现不了它"。
 *
 * 判据（任一不满足即 FAIL，退出码 1）：
 *   1) 无错误边界（"组件出错，请刷新页面"）、无应用错误页；
 *   2) 无 pageerror、无非噪声 console.error；
 *   3) **必须真的打开了一条有消息的会话**（`.msg` ≥ 1）——空会话不渲染消息组件，等于没测；
 *   4) 折叠交互不跳：点开/收起整轮折叠头，折叠头自身的视口位移 ≤ 2px；
 *   5) （报告项）会话流可见字号落在规范白名单内，越档只告警并列出，不阻塞。
 *
 * 用法：
 *   node scripts/聊天界面冒烟检查.mjs                      # 自动挑一条本机有消息的会话
 *   node scripts/聊天界面冒烟检查.mjs <baseUrl> [clientId] [sessionId] [workspace] [截图路径]
 *   npm run test:ui-smoke
 *
 * 依赖：playwright（本项目已有；也可用已装的 msedge / chrome 通道）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || process.env.OAW_SMOKE_BASE || "http://127.0.0.1:3002";
const SHOT = process.argv[6] || path.join(os.tmpdir(), `oaw-chat-smoke-${Date.now()}.png`);
/** 会话流可见文本的字号白名单（规范 §4：基线 12 / 14 / 16；v3 另允许 12.5 / 13，2026-11-18 同步）。 */
const FONT_WHITELIST = [12, 12.5, 13, 14, 16];
/** 会话流里参与字号检查的选择器。 */
const FONT_SELECTORS = [".tl-verb", ".tl-obj", ".tl-time", ".tb-cap", ".run-fold-head", ".tl-thinking-text", ".tl-group-head"];

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

/** 从服务端挑一条"本机存在且更适合渲染"的会话：优先本项目工作区，其次任意磁盘存在的 cwd。 */
async function resolveTarget() {
  if (process.argv[2] && process.argv[3] && process.argv[4]) {
    return { clientId: process.argv[3], sessionId: process.argv[4], workspace: process.argv[5] || "", title: "" };
  }
  const payload = await fetch(`${BASE}/api/sessions`).then((r) => r.json()).catch(() => null);
  const list = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const exists = (dir) => { try { return Boolean(dir) && fs.existsSync(dir); } catch { return false; } };
  const local = list.filter((item) => exists(item.cwd) && String(item.cwd).includes("office-agent-web"));
  const usable = list.filter((item) => exists(item.cwd));
  const pick = local[0] || usable[0] || list[0] || {};
  return {
    clientId: "smoke-client",
    sessionId: pick.id || "",
    workspace: pick.cwd || "",
    title: String(pick.title || "").slice(0, 16),
  };
}

/** 在页面上把目标会话点开；返回是否真的加载出消息。 */
async function openSession(page, target) {
  const msgCount = () => page.evaluate(() => document.querySelectorAll(".msg").length);
  if ((await msgCount()) > 0) return true;

  // 1) 用会话标题在界面上找到入口（项目卡/最近会话/侧栏都可能命中）
  if (target.title) {
    const clicked = await page.evaluate((title) => {
      const nodes = [...document.querySelectorAll("button, [role=button], .project-session-open, .session-item, a")]
        .filter((el) => (el.textContent || "").includes(title));
      const target = nodes[nodes.length - 1];
      if (!target) return false;
      target.click();
      return true;
    }, target.title);
    if (clicked) {
      await page.waitForTimeout(6000);
      if ((await msgCount()) > 0) return true;
    }
  }

  // 2) 兜底：点第一条"最近会话"入口（`.project-session-open` 或侧栏会话行）
  for (const selector of [".project-session-open", ".session-item", "[data-session-id]"]) {
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      (el.closest("button") || el).click();
      return true;
    }, selector);
    if (!clicked) continue;
    await page.waitForTimeout(6000);
    if ((await msgCount()) > 0) return true;
  }

  // 3) 还在首页时先点项目卡，再重试一次
  const projectClicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[class*=project]")].filter((el) => /会话|项目/.test(el.className || ""));
    const target = nodes.find((el) => el.querySelector("button"));
    if (!target) return false;
    target.querySelector("button").click();
    return true;
  });
  if (projectClicked) {
    await page.waitForTimeout(2500);
    const clicked = await page.evaluate(() => {
      const el = document.querySelector(".project-session-open");
      if (!el) return false;
      el.click();
      return true;
    });
    if (clicked) {
      await page.waitForTimeout(6000);
      if ((await msgCount()) > 0) return true;
    }
  }
  return false;
}

/** 折叠头开合的位置稳定性：展开/收起后折叠头自身不应在视口里移动（≤2px）。 */
async function measureFoldDrift(page) {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fold = document.querySelector(".run-fold");
    if (!fold) return { skipped: true, reason: "该会话没有可折叠的过程（无 .run-fold）" };
    const head = fold.querySelector(".run-fold-head");
    if (!head) return { skipped: true, reason: "折叠头缺失" };
    const read = () => head.getBoundingClientRect().top;
    // 先确保是收起态
    const openNow = fold.classList.contains("open");
    if (openNow) { head.click(); await wait(700); }
    const before = read();
    head.click();
    await wait(700);
    const expanded = read();
    head.click();
    await wait(700);
    const collapsed = read();
    return {
      skipped: false,
      expandDrift: Math.round(Math.abs(expanded - before) * 10) / 10,
      collapseDrift: Math.round(Math.abs(collapsed - before) * 10) / 10,
    };
  });
}

/** 会话流可见字号是否落在白名单内（报告项，不阻塞）。 */
async function measureFonts(page) {
  return page.evaluate((selectors) => {
    const seen = new Map();
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!el.offsetParent) continue;
        const size = getComputedStyle(el).fontSize.replace("px", "");
        const key = `${selector}|${size}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    return [...seen.entries()].map(([key, count]) => {
      const [selector, size] = key.split("|");
      return { selector, size: Number(size), count };
    });
  }, FONT_SELECTORS);
}

const chromium = loadChromium();
const target = await resolveTarget();

// 服务没起：明确的"跳过"而不是失败（避免把环境问题误判成代码回归）。
try {
  const probe = await fetch(`${BASE}/api/status`).then((r) => r.json());
  if (!probe?.ok) throw new Error("status 非 ok");
} catch (error) {
  console.error(`[跳过] 服务不可达（${BASE}）：${String(error?.message || error)}`);
  console.error("请先 npm start，再运行 npm run test:ui-smoke");
  process.exit(2);
}

const pageErrors = [];
const consoleErrors = [];
/** console.error 里允许出现的噪声（第三方库/网络探测等与渲染无关的已知项）。 */
const CONSOLE_NOISE = [/Failed to load resource/i, /favicon/i, /net::ERR/i, /ResizeObserver loop/i];

let browser;
for (const opts of [{}, { channel: "msedge" }, { channel: "chrome" }]) {
  try { browser = await chromium.launch({ headless: true, ...opts }); break; } catch {}
}
if (!browser) {
  console.error("无法启动浏览器：请确认已安装 chromium / Edge / Chrome");
  process.exit(1);
}

let exitCode = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.addInitScript(({ clientId, workspace }) => {
    localStorage.setItem("oaw_client_id", clientId);
    if (workspace) localStorage.setItem("oaw_ui_state_v1", JSON.stringify({ workspace, sidebarOpen: true }));
  }, { clientId: target.clientId, workspace: target.workspace });

  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text().slice(0, 300);
    if (CONSOLE_NOISE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(7000);

  const loaded = await openSession(page, target);
  const state = await page.evaluate(() => ({
    boundary: (document.querySelector(".chat-error-boundary")?.innerText || "").replace(/\s+/g, " ").trim(),
    appError: (document.querySelector(".app-error")?.innerText || "").replace(/\s+/g, " ").trim(),
    messages: document.querySelectorAll(".msg").length,
    transcriptV3: document.querySelector(".chat-body")?.getAttribute("data-transcript-v3") || null,
    folds: document.querySelectorAll(".run-fold").length,
    groups: document.querySelectorAll(".tl-group").length,
    toolCards: document.querySelectorAll(".tool-card").length,
    legacyExecutionFlow: document.querySelectorAll(".execution-flow").length,
  }));

  const fold = await measureFoldDrift(page);
  const fonts = await measureFonts(page);
  const fontViolations = fonts.filter((item) => !FONT_WHITELIST.includes(item.size));
  await page.screenshot({ path: SHOT });

  const lines = [];
  lines.push(`目标: session=${target.sessionId || "(未指定)"} workspace=${target.workspace || "(未指定)"}`);
  lines.push(`会话加载: ${loaded ? "✓ 已打开有消息的会话" : "✗ 未能打开任何有消息的会话（冒烟无效）"}`);
  lines.push(`错误边界: ${state.boundary ? `✗ ${state.boundary}` : "✓ 无"}`);
  lines.push(`应用错误页: ${state.appError ? `✗ ${state.appError}` : "✓ 无"}`);
  lines.push(`pageerror: ${pageErrors.length ? `✗ ${pageErrors.join(" | ")}` : "✓ 无"}`);
  lines.push(`console.error: ${consoleErrors.length ? `✗ ${consoleErrors.slice(0, 2).join(" | ")}` : "✓ 无"}`);
  lines.push(`消息条数: ${state.messages}`);
  lines.push(`渲染形态: v3=${state.transcriptV3 || "关"} 折叠=${state.folds} 过程组=${state.groups} 工具卡=${state.toolCards} 旧执行流=${state.legacyExecutionFlow}`);
  if (fold.skipped) {
    lines.push(`折叠稳定性: - ${fold.reason}`);
  } else {
    lines.push(`折叠稳定性: ${fold.expandDrift <= 2 && fold.collapseDrift <= 2 ? "✓" : "✗"} 展开位移 ${fold.expandDrift}px / 收起位移 ${fold.collapseDrift}px（阈值 ≤2px）`);
  }
  if (fonts.length) {
    lines.push(`字号白名单: ${fontViolations.length ? `⚠ ${fontViolations.length} 项越档` : "✓"} ${fonts.map((f) => `${f.selector.replace(".", "")}=${f.size}px`).join(" ")}`);
    if (fontViolations.length) {
      lines.push(`  越档明细（规范 §4 只允许 ${FONT_WHITELIST.join("/")}px）：${fontViolations.map((f) => `${f.selector}=${f.size}px`).join("，")}`);
    }
  }
  lines.push(`截图: ${SHOT}`);
  console.log(lines.join("\n"));

  const hardFailures = [];
  if (!loaded || state.messages === 0) hardFailures.push("未能加载有消息的会话");
  if (state.boundary) hardFailures.push("出现错误边界");
  if (state.appError) hardFailures.push("出现应用错误页");
  if (pageErrors.length) hardFailures.push(`pageerror ×${pageErrors.length}`);
  if (consoleErrors.length) hardFailures.push(`console.error ×${consoleErrors.length}`);
  if (!fold.skipped && (fold.expandDrift > 2 || fold.collapseDrift > 2)) hardFailures.push("折叠开合位置漂移 > 2px");

  if (hardFailures.length) {
    console.error(`\n✗ 界面冒烟失败：${hardFailures.join("；")}`);
    exitCode = 1;
  } else {
    console.log("\n✓ 界面冒烟通过（有消息会话可渲染、无运行时错误、折叠位置稳定）");
  }
} finally {
  await browser.close();
}
process.exit(exitCode);
