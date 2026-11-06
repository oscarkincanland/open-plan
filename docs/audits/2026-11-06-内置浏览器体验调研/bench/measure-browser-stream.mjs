/**
 * 内置浏览器帧流实测脚本（只读测量，不修改项目源码、不启动 3002 主服务）
 *
 * 复现生产参数（server/内置浏览器.mjs:23-46）：
 *   viewport 1440x900 / Page.startScreencast(jpeg, quality 70, maxWidth 1600, maxHeight 1000,
 *   everyNthFrame 2, maxFramesInFlight 2) / 前端合并节流 90ms / MAX_FRAME_BYTES 900000
 *
 * 用法：node docs/audits/2026-11-06-内置浏览器体验调研/bench/measure-browser-stream.mjs
 * 产物：同目录 results-<timestamp>.json
 *
 * 注意：spawn 使用 stdio:"ignore"（沙箱内 piped stdio 会 EPERM），用独立临时 profile，
 * 结束时会清理自己启动的浏览器进程（按 profile 路径过滤，不碰用户自己的 Edge）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = HERE;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-bench-"));
const PROFILE_DIR = path.join(TMP_ROOT, "profile");
fs.mkdirSync(OUT_DIR, { recursive: true });

const PROD = {
  viewport: { width: 1440, height: 900 },
  screencast: { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 2, maxFramesInFlight: 2 },
  broadcastIntervalMs: 90,
  maxFrameBytes: 900000,
};

const EDGE_CANDIDATES = [
  process.env.OAW_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  throw new Error("未找到 Edge/Chrome 可执行文件");
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* ---------------- 本地 fixture：模拟真实网页（正文 + 列表 + 表格 + 渐变图块） ---------------- */
const PARAGRAPH = "浙江省综合交通规划提出构建现代化高质量综合立体交通网，强化杭州都市圈与宁波舟山港的联动，推进轨道交通、高速公路、内河水运多式联运体系建设。规划强调以枢纽为核心组织客流与货流，提升通道能力与换乘效率，并对山区海岛地区实行差异化供给策略。";
const LIST_ITEM = "重点任务：加快杭绍甬智慧高速扩容、推进沪乍杭铁路前期工作、完善内河高等级航道网络、优化城市群城际铁路布局。";

function buildFixtureHtml() {
  const paragraphs = Array.from({ length: 14 }, (_, i) => `<p>${i + 1}. ${PARAGRAPH} ${PARAGRAPH}</p>`).join("\n");
  const list = Array.from({ length: 18 }, (_, i) => `<li>${i + 1}）${LIST_ITEM}</li>`).join("\n");
  const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>杭州</td><td>${1200 + i * 37}</td><td>${(3.1 + i * 0.2).toFixed(1)}</td><td>${(72 + i).toFixed(1)}</td></tr>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>浙江省综合交通规划（bench fixture）</title>
<style>
 body{margin:0;font-family:"Microsoft YaHei","Segoe UI",sans-serif;background:#f7f9fc;color:#1f2933}
 header{height:180px;background:linear-gradient(120deg,#0f4c81 0%,#2f7ab8 45%,#7ec4e8 100%);display:flex;align-items:center;padding:0 48px;color:#fff}
 header h1{font-size:34px;margin:0;letter-spacing:1px}
 .wrap{display:grid;grid-template-columns:1fr 340px;gap:28px;padding:28px 48px}
 .hero{height:220px;border-radius:14px;background:linear-gradient(60deg,#dbeafe,#bfdbfe 40%,#93c5fd 70%,#60a5fa);display:flex;align-items:flex-end;padding:20px;color:#0b3966;font-size:20px}
 h2{font-size:22px;border-left:5px solid #2f7ab8;padding-left:12px}
 p{line-height:1.85;font-size:15px}
 ul{line-height:1.9;font-size:15px}
 table{border-collapse:collapse;width:100%;font-size:14px}
 th,td{border:1px solid #d6dee8;padding:8px 10px;text-align:left}
 th{background:#eaf2fa}
 aside{background:#fff;border:1px solid #e1e8f0;border-radius:12px;padding:16px}
 .stat{font-size:26px;color:#0f4c81;font-weight:700}
 .chart{height:200px;margin-top:12px;border-radius:10px;background:linear-gradient(180deg,#e0f2fe,#bae6fd);display:flex;align-items:flex-end;gap:6px;padding:10px}
 .bar{flex:1;background:#2f7ab8;border-radius:4px 4px 0 0}
 footer{margin:32px 48px;padding:18px;border-top:1px solid #dbe3ec;color:#5b6b7c;font-size:13px}
</style></head><body>
<header><h1>浙江省综合交通规划（示意 fixture）</h1></header>
<div class="wrap">
 <main>
  <div class="hero">多式联运 · 都市圈通勤 · 港产城融合</div>
  <h2>规划摘要</h2>
  ${paragraphs}
  <h2>重点任务清单</h2>
  <ul>${list}</ul>
  <h2>分市指标</h2>
  <table><thead><tr><th>城市</th><th>客运量(万人次)</th><th>货运量(亿吨)</th><th>轨道里程(km)</th></tr></thead><tbody>${rows}</tbody></table>
 </main>
 <aside>
  <h2>关键指标</h2>
  <div class="stat">2.4 万亿</div><p>综合交通投资规模</p>
  <div class="stat">8600 km</div><p>高铁运营里程</p>
  <div class="chart">${Array.from({ length: 12 }, (_, i) => `<div class="bar" style="height:${20 + ((i * 37) % 80)}%"></div>`).join("")}</div>
 </aside>
</div>
<footer>本页为性能测量用本地页面，数据为演示数据，不代表真实调查或监测结果。</footer>
</body></html>`;
}

function startFixtureServer() {
  const html = Buffer.from(buildFixtureHtml(), "utf8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (event) => reject(new Error(`CDP WebSocket 错误: ${event?.message || "unknown"}`)));
      this.ws.addEventListener("close", () => { this.closed = true; });
      this.ws.addEventListener("message", (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
          return;
        }
        if (msg.method) {
          const set = this.handlers.get(msg.method);
          if (set) for (const fn of [...set]) { try { fn(msg.params); } catch {} }
        }
      });
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP 已关闭"));
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, 30000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function launchBrowser(port) {
  const executable = findBrowser();
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-renderer-backgrounding",
    `--window-size=${PROD.viewport.width},${PROD.viewport.height}`,
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: "ignore", detached: false, windowsHide: true });
  child.on("error", () => {});
  const deadline = Date.now() + 25000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (version?.webSocketDebuggerUrl) return { child, executable, version };
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error(`浏览器 CDP 未就绪：${lastError?.message || "超时"}`);
}

async function connectPage(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有可用的 page target");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return cdp;
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return { n: sorted.length, min: pick(0), p50: pick(0.5), p95: pick(0.95), max: pick(1), avg: Math.round(sum / sorted.length), sum };
}

async function navigateHome(cdp, url) {
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const value = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (value?.result?.value === "complete") return true;
    } catch {}
    await sleep(120);
  }
  return false;
}

/** 启动 screencast 并采集 durationMs 内的帧 */
async function measureScreencast(cdp, params, durationMs) {
  const frames = [];
  let screencastSession = 0;
  const off = cdp.on("Page.screencastFrame", (payload) => {
    const at = Date.now();
    frames.push({ at, bytes: payload.data ? Buffer.byteLength(payload.data, "utf8") : 0 });
    const sessionId = payload.sessionId ?? screencastSession;
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", params).catch((error) => { throw error; });
  await sleep(durationMs);
  await cdp.send("Page.stopScreencast").catch(() => {});
  off();
  const intervals = [];
  for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i].at - frames[i - 1].at);
  const sizes = frames.map((f) => f.bytes);
  const spanMs = frames.length > 1 ? frames[frames.length - 1].at - frames[0].at : 0;
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  return {
    params,
    frameCount: frames.length,
    spanMs,
    fps: spanMs > 0 ? Number(((frames.length - 1) / (spanMs / 1000)).toFixed(1)) : 0,
    bytes: stats(sizes),
    intervalMs: stats(intervals),
    totalBytes,
    mbps: spanMs > 0 ? Number(((totalBytes * 8) / (spanMs / 1000) / 1e6).toFixed(2)) : 0,
  };
}

async function scrollBurst(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const start = window.scrollY;
      const target = Math.min(document.body.scrollHeight - innerHeight, start + 1400);
      const steps = 30;
      for (let i = 1; i <= steps; i += 1) {
        window.scrollTo(0, start + ((target - start) * i) / steps);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { start, target, end: window.scrollY };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }).catch(() => {});
}

async function measureCaptureScreenshot(cdp, times = 8) {
  const latencies = [];
  const sizes = [];
  for (let i = 0; i < times; i += 1) {
    const startedAt = Date.now();
    try {
      const result = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: PROD.screencast.quality });
      latencies.push(Date.now() - startedAt);
      sizes.push(Buffer.byteLength(result?.data || "", "utf8"));
    } catch {}
    await sleep(60);
  }
  return { latencyMs: stats(latencies), bytes: stats(sizes) };
}

async function measureAxTree(cdp) {
  await cdp.send("Accessibility.enable").catch(() => {});
  const startedAt = Date.now();
  let payload = null;
  try { payload = await cdp.send("Accessibility.getFullAXTree", {}); } catch (error) {
    try { payload = await cdp.send("Accessibility.getFullAXTree", { depth: -1 }); } catch { return { error: String(error?.message || error) }; }
  }
  const elapsed = Date.now() - startedAt;
  const json = JSON.stringify(payload || {});
  return { elapsedMs: elapsed, nodeCount: Array.isArray(payload?.nodes) ? payload.nodes.length : 0, jsonBytes: Buffer.byteLength(json, "utf8") };
}

function base64AndJsonOverhead(sampleBytes) {
  const buffer = Buffer.alloc(sampleBytes, 0xab);
  const base64 = buffer.toString("base64");
  const payload = { type: "frame", data: { data: base64, at: Date.now(), width: 1440, height: 900 } };
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  const parseStart = process.hrtime.bigint();
  JSON.parse(JSON.stringify(payload));
  const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6;
  const base64DecodeStart = process.hrtime.bigint();
  Buffer.from(base64, "base64");
  const base64DecodeMs = Number(process.hrtime.bigint() - base64DecodeStart) / 1e6;
  return {
    rawBytes: sampleBytes,
    base64Bytes: Buffer.byteLength(base64, "utf8"),
    expansion: Number((Buffer.byteLength(base64, "utf8") / sampleBytes).toFixed(3)),
    sseChunkBytes: Buffer.byteLength(chunk, "utf8"),
    jsonRoundTripMs: Number(parseMs.toFixed(3)),
    base64DecodeMs: Number(base64DecodeMs.toFixed(3)),
  };
}

async function main() {
  const report = { at: new Date().toISOString(), env: {}, prod: PROD, results: {}, notes: [] };
  const executable = findBrowser();
  report.env.browserPath = executable;
  report.env.node = process.version;
  report.env.os = `${os.platform()} ${os.release()}`;
  try {
    report.env.browserVersion = execFileSync(executable, ["--version"], { encoding: "utf8", stdio: "ignore" });
  } catch {} // --version 通常直接输出到 stdout，stdout 被 ignore 时拿不到；版本改由 CDP 读取

  const { server, port: fixturePort } = await startFixtureServer();
  const debugPort = await freePort();
  report.env.debugPort = debugPort;
  let browser = null;
  let cdp = null;
  let exitCode = 0;
  try {
    browser = await launchBrowser(debugPort).catch((error) => { throw error; });
    report.env.browserVersion = browser.version?.Browser || report.env.browserVersion || "";
    report.env.cdpProtocolVersion = browser.version?.["Protocol-Version"] || "";
    cdp = await connectPage(debugPort);
    const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
    const loaded = await navigateHome(cdp, fixtureUrl);
    report.notes.push(`fixture 加载：${loaded ? "成功" : "超时"}`);
    await sleep(800);

    // A1：静态页（生产参数，5s）
    report.results.static_prod = await measureScreencast(cdp, PROD.screencast, 5000);
    // A2：滚动页（生产参数，滚动 1.4 屏 + 3s 采样）
    await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }).catch(() => {});
    await sleep(400);
    const scrollPromise = (async () => { await sleep(200); await scrollBurst(cdp); })();
    const scrollMeasure = await measureScreencast(cdp, PROD.screencast, 3000);
    await scrollPromise.catch(() => {});
    report.results.scroll_prod = scrollMeasure;

    // B：参数扫点（静态页，各 2.5s）
    const sweep = [];
    const combos = [];
    for (const quality of [40, 55, 70, 85]) {
      for (const [maxWidth, everyNthFrame] of [[1600, 2], [1280, 2], [900, 2], [1600, 1], [1600, 3]]) {
        combos.push({ ...PROD.screencast, quality, maxWidth, everyNthFrame });
      }
    }
    for (const combo of combos) {
      await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }).catch(() => {});
      await sleep(120);
      const result = await measureScreencast(await Promise.resolve(cdp), combo, 2200);
      sweep.push(result);
    }
    report.results.sweep = sweep;

    // C：单帧截图 / 导航 / 可访问性树
    report.results.captureScreenshot = await measureCaptureScreenshot(cdp);
    report.results.axTree = await measureAxTree(cdp);

    const navStart = Date.now();
    const navOk = await navigateHome(cdp, `${fixtureUrl}?nav=${Date.now()}`);
    report.results.navigate = { ok: navOk, elapsedMs: Date.now() - navStart };

    // D：base64 + JSON 开销（取静态页生产参数实测帧中位字节数）
    const medianFrameBytes = report.results.static_prod?.bytes?.p50 || 120000;
    report.results.encodingOverhead = base64AndJsonOverhead(medianFrameBytes);
    report.notes.push(`编码开销基于实测中位帧字节数 ${medianFrameBytes} B`);

    // E：真实站点（可选）。网络不可用则跳过。
    try {
      const realLoaded = await navigateHome(cdp, "https://cn.bing.com");
      if (realLoaded) {
        await sleep(1200);
        report.results.static_bing = await measureScreencast(cdp, PROD.screencast, 4000);
      } else {
        report.notes.push("真实站点 cn.bing.com 导航超时，跳过 E 组");
      }
    } catch (error) {
      report.notes.push(`真实站点测量跳过：${String(error?.message || error).slice(0, 160)}`);
    }
  } catch (error) {
    exitCode = 1;
    report.error = String(error?.stack || error?.message || error);
    console.error("[bench] 失败：", report.error);
  } finally {
    try { if (cdp) { await cdp.send("Browser.close").catch(() => {}); cdp.close(); } } catch {}
    try { browser?.child?.kill(); } catch {}
    await sleep(600);
    killByProfile();
    try { server.close(); } catch {}
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
    const file = path.join(OUT_DIR, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    console.log(`[bench] 结果已写入 ${file}`);
    printSummary(report);
  }
  process.exitCode = exitCode;
}

/** 只杀本脚本 profile 的浏览器进程，绝不碰用户自己的 Edge。 */
function killByProfile() {
  if (process.platform !== "win32") return;
  try {
    const escaped = PROFILE_DIR.replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`;
    execFileSync("pwsh", ["-NoProfile", "-Command", script], { stdio: "ignore", timeout: 15000 });
  } catch {}
}

function printSummary(report) {
  const r = report.results || {};
  const line = (label, value) => console.log(`  ${label}: ${value}`);
  console.log("[bench] 摘要");
  if (r.static_prod) {
    line("静态帧数/帧率", `${r.static_prod.frameCount} 帧 / ${r.static_prod.fps} fps`);
    line("帧字节 中位/P95/最大", `${r.static_prod.bytes?.p50} / ${r.static_prod.bytes?.p95} / ${r.static_prod.bytes?.max} B`);
    line("稳态带宽", `${r.static_prod.mbps} Mbps`);
  }
  if (r.scroll_prod) {
    line("滚动帧率/带宽", `${r.scroll_prod.fps} fps / ${r.scroll_prod.mbps} Mbps`);
  }
  if (r.captureScreenshot) {
    line("单帧截图延迟 中位/P95", `${r.captureScreenshot.latencyMs?.p50} / ${r.captureScreenshot.latencyMs?.p95} ms`);
  }
  if (r.axTree) {
    line("可访问性树", `${r.axTree.nodeCount} 节点 / ${r.axTree.jsonBytes} B / ${r.axTree.elapsedMs} ms`);
  }
  if (r.encodingOverhead) {
    line("base64 膨胀 / SSE 包装", `${r.encodingOverhead.expansion}x / ${r.encodingOverhead.sseChunkBytes} B`);
  }
  if (report.error) line("错误", report.error.split("\n")[0]);
  console.log(`[bench] 备注: ${(report.notes || []).join(" | ")}`);
}

main().catch((error) => {
  console.error("[bench] 未捕获错误：", error);
  process.exit(1);
});
