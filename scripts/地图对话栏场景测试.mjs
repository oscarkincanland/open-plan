#!/usr/bin/env node
/**
 * 阶段 4 浏览器场景验证（L3）
 *
 * 验证只靠源码断言覆盖不到的呈现效果：
 *   H1 进入地图模式：对话栏默认 360px、紧凑
 *   H2 拖动分隔条仍可调整（300–620）
 *   H3 对话栏顶部显示当前地图项目与视口
 *   H7 退出地图回到主对话：消息流连续（无重复、无丢失）
 *
 * 前置：服务在 3002 运行，且已 npm run build。
 * 用法：node scripts/地图对话栏场景测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.OAW_BASE || "http://127.0.0.1:3002";
const PW_CACHE = process.env.OAW_PLAYWRIGHT || "C:\\Users\\admin\\AppData\\Local\\npm-cache\\_npx\\86170c4cd1c5da32\\node_modules";
const PW_ENTRY = path.join(PW_CACHE, "playwright-core", "index.js");
if (!fs.existsSync(PW_ENTRY)) { console.error("找不到 playwright-core：" + PW_ENTRY); process.exit(1); }
const { chromium } = (await import(pathToFileURL(PW_ENTRY).href)).default;

function findChromium() {
  const base = "C:/Users/admin/AppData/Local/ms-playwright";
  if (process.env.OAW_CHROMIUM && fs.existsSync(process.env.OAW_CHROMIUM)) return process.env.OAW_CHROMIUM;
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]) {
        const p = `${base}/${d}/${sub}`;
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return "";
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

const exePath = findChromium();
if (!exePath) { console.error("找不到 Chromium"); process.exit(1); }

const browser = await chromium.launch({ headless: true, executablePath: exePath, args: ["--headless=new"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e.message || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

console.log("\n▶ H1/H3 进入地图：紧凑对话栏 + 地图状态行");

await test("进入地图模式，对话栏宽度收紧且带地图状态行", async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar-capabilities, .sidebar-section", { timeout: 25000 }).catch(() => {});
  const toolsTab = page.locator("button", { hasText: "能力" }).first();
  if (await toolsTab.count()) await toolsTab.click().catch(() => {});
  await page.locator(".sidebar-capabilities button", { hasText: "地图" }).first().click({ timeout: 15000 });
  await page.waitForSelector(".mp-topbar", { timeout: 30000 });

  // 对话栏（全局单实例常驻主对话槽位，地图模式用 CSS 固定到右侧）
  await page.waitForSelector(".center-chat-slot.map-mode", { timeout: 20000 });
  const width = await page.evaluate(() => {
    const el = document.querySelector(".center-chat-slot.map-mode");
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  assert.ok(width >= 300 && width <= 400, `地图对话栏宽度应在 300–400（默认 360），实际 ${width}`);
  // 紧凑类
  const compact = await page.locator(".center-chat-slot.map-mode .chat-compact").count();
  assert.ok(compact > 0, "地图模式对话栏应带 chat-compact（紧凑）");
});

await test("顶部显示地图项目与视口（H3）", async () => {
  const status = await page.locator(".chat-map-status").count();
  assert.ok(status > 0, "应显示地图状态行");
  const text = await page.locator(".chat-map-status").innerText();
  assert.match(text, /zhejiang-map/, `状态行应含项目名，实际：${text}`);
  // 视口可能尚未上报（地图初始化中），等一会儿再确认
  await page.waitForTimeout(2500);
  const text2 = await page.locator(".chat-map-status").innerText();
  assert.match(text2, /缩放|附近/, `状态行应显示视口信息，实际：${text2}`);
});

console.log("\n▶ H2 拖动分隔条仍可调整");

await test("拖拽后宽度变化且被限制在 300–620", async () => {
  const before = await page.evaluate(() => Math.round(document.querySelector(".center-chat-slot.map-mode").getBoundingClientRect().width));
  const resizer = page.locator(".map-chat-resizer");
  const box = await resizer.boundingBox();
  assert.ok(box, "应存在拖拽条");
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => Math.round(document.querySelector(".center-chat-slot.map-mode").getBoundingClientRect().width));
  assert.ok(after > before, `向右拖拽应加宽（${before} → ${after}）`);
  assert.ok(after <= 640, `不应超过上限（实际 ${after}）`);
});

console.log("\n▶ H4/H5 地图可视化的结果区提示");

await test("生成分析后出现「临时，未保存」提示（H4）", async () => {
  // 走真实事件路径：SSE 的 map_action 最终由 ChatPanel 的 handleEvent 处理。
  const res = await page.request.get(`${BASE}/api/map/demo-analysis?analysis=heatmap&region=%E4%B9%89%E4%B9%8C%E5%B8%82&project=zhejiang-map`);
  const action = await res.json();
  // 一路两吃：既驱动地图（MapPanel 桥接），也驱动对话栏（事件处理器）。
  await page.evaluate((payload) => {
    window.__oawMapBridge?.mapAction?.(payload);
    window.__oawChatEvents?.handle?.({ type: "map_action", data: payload });
  }, action);
  await page.waitForSelector(".chat-map-visual", { timeout: 15000 });
  const text = await page.locator(".chat-map-visual").innerText();
  assert.match(text, /临时，未保存/, `应提示临时未保存，实际：${text}`);
  assert.match(text, /热力图|分析/, "应含结果名称");
});

await test("Chat 模式点保存 → 就地提示需切 Work（H5）", async () => {
  await page.locator(".cmv-save").click();
  await page.waitForSelector(".cmv-hint", { timeout: 8000 });
  const hint = await page.locator(".cmv-hint").innerText();
  assert.match(hint, /保存正式图层需要切换到 Work 模式/, `应就地提示切 Work，实际：${hint}`);
});

console.log("\n▶ H7 退出地图回到主对话：对话栏连续可用");

await test("返回主对话后对话栏仍在且可用（无重复消息）", async () => {
  const before = await page.locator(".center-chat-slot.map-mode .msg").count();
  await page.locator(".mp-topbar .mp-exit").click();
  await page.waitForTimeout(1500);

  // 对话栏仍在（同一常驻实例），输入框与发送键可用
  assert.ok(await page.locator(".chat").count() > 0, "返回后对话栏应仍在");
  assert.ok(await page.locator(".center-chat-slot .chat").count() > 0, "应回到主对话槽位");
  assert.equal(await page.locator(".center-chat-slot.map-mode").count(), 0, "退出地图应移除 map-mode");
  const after = await page.locator(".center-chat-slot .msg").count();
  // 同一实例：返回不应把消息复制一遍，也不应丢失本地消息
  assert.equal(after, before, `返回不应改变消息数量（${before} → ${after}）`);

  const welcome = await page.locator(".center-chat-slot").innerText();
  assert.ok(welcome.length > 0, "主对话区域应有内容");
});

console.log("\n▶ H8/H9 地图往返连续性与对话栏对齐");

await test("进入地图不重建对话栏：消息与 AGENTS 提示完全保留", async () => {
  await page.waitForSelector(".center-chat-slot", { timeout: 15000 });
  const readMessages = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => ({
    text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
    system: el.classList.contains("system"),
  })), selector);
  const before = await readMessages(".center-chat-slot .msg");
  assert.ok(before.length > 0, "进入地图前主对话应至少有一条消息（AGENTS 提示）");
  const agentsBefore = before.filter((item) => item.text.includes("已加载工作区指令")).length;

  const toolsTab = page.locator("button", { hasText: "能力" }).first();
  if (await toolsTab.count()) await toolsTab.click().catch(() => {});
  await page.locator(".sidebar-capabilities button", { hasText: "地图" }).first().click({ timeout: 15000 });
  await page.waitForSelector(".center-chat-slot.map-mode", { timeout: 20000 });
  await page.waitForTimeout(800);

  const after = await readMessages(".center-chat-slot.map-mode .msg");
  assert.deepEqual(after, before, "进入地图不应卸载/重建对话栏，消息列表应完全一致");
  const agentsAfter = after.filter((item) => item.text.includes("已加载工作区指令")).length;
  assert.equal(agentsAfter, agentsBefore, "AGENTS.md 提示不应因重挂而重复");
});

await test("地图对话栏消息/输入区左缘对齐且隐藏历史/标题行", async () => {
  const box = await page.evaluate(() => {
    const root = document.querySelector(".center-chat-slot.map-mode");
    const msg = root?.querySelector(".chat-body > .msg .msg-main") || root?.querySelector(".chat-body > .msg");
    const compose = root?.querySelector(".chat-compose");
    const input = root?.querySelector(".chat-input");
    const hist = root?.querySelector(".chat-hist");
    const head = root?.querySelector(".chat-head");
    return {
      hasRoot: Boolean(root),
      hasMessage: Boolean(msg),
      msgLeft: msg ? msg.getBoundingClientRect().left : null,
      composeLeft: compose ? compose.getBoundingClientRect().left : null,
      inputLeft: input ? input.getBoundingClientRect().left : null,
      histDisplay: hist ? getComputedStyle(hist).display : "none",
      headDisplay: head ? getComputedStyle(head).display : "none",
    };
  });
  assert.ok(box.hasRoot && box.hasMessage, "地图对话栏与消息应存在");
  assert.ok(Math.abs(box.msgLeft - box.composeLeft) <= 1, `消息左缘应与输入区对齐（${box.msgLeft} vs ${box.composeLeft}）`);
  assert.ok(Math.abs(box.inputLeft - box.composeLeft) <= 1, `输入框左缘应与任务区对齐（${box.inputLeft} vs ${box.composeLeft}）`);
  assert.equal(box.histDisplay, "none", "地图对话栏不应显示历史抽屉行");
  assert.equal(box.headDisplay, "none", "地图对话栏不应显示标题行");
});

await test("退出地图后预览自动打开，并在地图文件变更时热刷新 style", async () => {
  const mapProjectId = (await page.locator(".chat-map-status .cms-project").innerText()).trim();
  assert.ok(mapProjectId, "地图状态行应显示当前项目标识");
  await page.locator(".mp-topbar .mp-exit").click();
  await page.waitForSelector(".mini-map", { timeout: 20000 });
  const projectName = await page.locator(".mini-map-head strong").innerText();
  assert.ok(projectName.trim().length > 0, "预览应显示当前地图项目");
  // 等预览地图完成首屏样式加载，避免把初始 style 请求当成热刷新证据。
  await page.waitForSelector(".mini-map-canvas canvas", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const styleRequests = [];
  page.on("request", (req) => {
    if (req.url().includes("/style.json")) styleRequests.push(req.url());
  });
  await page.evaluate((project) => {
    window.__oawChatEvents?.handle?.({
      type: "file_changed",
      data: { files: [`maps/${project}/style.json`] },
    });
  }, mapProjectId);
  await page.waitForTimeout(1500);
  assert.ok(styleRequests.length > 0, "地图文件变更后预览应重新请求 style.json");
  assert.ok(styleRequests.some((url) => url.includes(`/${mapProjectId}/style.json`)), `应命中当前项目 ${mapProjectId} 的 style.json，实际：${styleRequests.slice(0, 3).join(" | ")}`);
});

await test("页面无 JS 错误", () => {
  const relevant = consoleErrors.filter((t) => !/favicon|ResizeObserver|glyph|Failed to load resource|WebGL|style is not done loading/i.test(t));
  assert.equal(relevant.length, 0, `不应有 JS 错误：\n${relevant.slice(0, 5).join("\n")}`);
});

await browser.close();

if (failed) {
  console.log(`\n阶段 4 浏览器场景：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 4 浏览器场景：通过");
