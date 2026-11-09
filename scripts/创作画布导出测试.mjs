/**
 * 创作画布导出回归（test:canvas-export）：导出计划纯函数、SVG 序列化、
 * 导出视图 URL、文件名清洗、PPTX 可编辑文本断言、PNG/PDF 浏览器调用链（假浏览器注入）。
 *
 * 运行：node scripts/创作画布导出测试.mjs
 * 临时工作区使用 os.tmpdir()，脚本结束（含异常）后整体清理；不需要真实浏览器/网络。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  buildCanvasExportUrl,
  buildExportFileName,
  reserveExportFile,
  sanitizeSvgMarkup,
  serializeBoardToSvg,
} from "../server/创作画布导出.mjs";
import {
  createCanvas,
  importCanvas,
  listExportJobs,
  planExport,
  runExport,
  writeBoard,
} from "../server/创作画布.mjs";

const passed = [];
async function check(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

async function expectCode(fn, code, hint = "") {
  try {
    await fn();
  } catch (error) {
    assert.equal(error?.code, code, `${hint} 期望 ${code}，实际 ${error?.code}: ${error?.message}`);
    return error;
  }
  assert.fail(`${hint} 应抛出 ${code}，但没有抛错`);
}

/** 1×1 透明 PNG（合法字节，PPTX/文件断言够用）。 */
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const TINY_PDF_BASE64 = Buffer.from("%PDF-1.4\n% fake pdf for test\n%%EOF\n", "utf8").toString("base64");

/** 假内置浏览器：记录调用链，PNG/PDF 返回固定 base64（不启动 Chrome）。 */
function createFakeBrowser({ gate = null } = {}) {
  const calls = [];
  return {
    calls,
    browserSessionKey: (kind, id) => `${kind}-${id}`,
    async browserOpen(key, url) {
      calls.push({ op: "open", key, url });
      if (gate) await gate;
      return { url };
    },
    async browserResize(key, width, height) {
      calls.push({ op: "resize", key, width, height });
      return { viewport: { width, height } };
    },
    async browserWaitForExpression(key, expression) {
      calls.push({ op: "wait", key, expression });
      return true;
    },
    async browserEvaluateValue(key, expression) {
      calls.push({ op: "evaluate", key, expression });
      return "";
    },
    async browserScreenshot(key, options = {}) {
      calls.push({ op: "screenshot", key, format: options.format });
      return { base64: TINY_PNG_BASE64, bytes: Buffer.byteLength(TINY_PNG_BASE64, "base64"), file: "" };
    },
    async browserPrintToPdf(key) {
      calls.push({ op: "print", key });
      return { base64: TINY_PDF_BASE64, bytes: Buffer.byteLength(TINY_PDF_BASE64, "base64"), file: "" };
    },
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-canvas-export-"));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "ws-")));
const designs = path.join(workspace, "designs");

const TITLE_TEXT = "规聚 · 交通规划 AI 工作台";
const SVG_MARKUP = '<svg viewBox="0 0 100 100"><script>alert(1)</script><rect width="100" height="100" fill="#2f6bff" onclick="steal()"/></svg>';

function writeAsset(relPath, buffer) {
  const target = path.join(workspace, "designs", "export-a", "project", relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return target;
}

try {
  // ---------- 准备画布 ----------
  createCanvas(workspace, { slug: "export-a", title: "导出画布", template: "deck" });
  writeAsset(path.join("assets", "map.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
  writeAsset(path.join("assets", "flow.svg"), Buffer.from('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#141413"/></svg>', "utf8"));
  writeBoard(workspace, "export-a", "boards/body.board.json", {
    v: 1, w: 1280, h: 720, background: "#ffffff",
    elements: [
      { id: "el-title", type: "text", x: 80, y: 64, w: 960, h: 120, text: TITLE_TEXT, style: { fontSize: 56, fontWeight: 700, color: "#141413", textAlign: "left", lineHeight: 1.2 } },
      { id: "el-accent", type: "rect", x: 80, y: 220, w: 1120, h: 2, style: { fill: "#d6dce5" } },
      { id: "el-line", type: "line", x1: 80, y1: 260, x2: 1200, y2: 260, style: { stroke: "#141413", strokeWidth: 2 } },
      { id: "el-shot", type: "image", x: 80, y: 300, w: 520, h: 300, src: "../assets/map.png", fit: "cover" },
      { id: "el-chart", type: "svg", x: 640, y: 300, w: 520, h: 300, src: "../assets/flow.svg" },
      { id: "el-inline", type: "svg", x: 640, y: 40, w: 120, h: 120, markup: SVG_MARKUP },
    ],
  }, { actor: "agent" });

  // 兼容画布（.dc.html）来源，用于导入 + 图片页导出
  const compatRoot = path.join(designs, "compat-src");
  fs.mkdirSync(path.join(compatRoot, "project"), { recursive: true });
  fs.writeFileSync(path.join(compatRoot, "project", "Main.dc.html"), "<!doctype html><html><body><h1>兼容板</h1></body></html>", "utf8");
  fs.writeFileSync(path.join(compatRoot, "project", "canvas.json"), JSON.stringify({
    v: 3,
    title: "兼容来源",
    boards: { "Main.dc.html": { x: 0, y: 0, w: 1280, h: 720, title: "兼容板" } },
    order: ["Main.dc.html"],
  }), "utf8");

  // ---------- planExport 纯函数 ----------
  console.log("▶ planExport（纯函数）");

  await check("svg 计划：对象板各一条 job，未写盘", async () => {
    const before = fs.existsSync(path.join(designs, "export-a", "exports"));
    const filesBefore = before ? fs.readdirSync(path.join(designs, "export-a", "exports")).length : 0;
    const plan = planExport(workspace, "export-a", { format: "svg" });
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.format, "svg");
    assert.equal(plan.jobs.length, 2);
    assert.deepEqual(plan.jobs.map((job) => job.boardPath), ["boards/cover.board.json", "boards/body.board.json"]);
    assert.ok(plan.jobs.every((job) => job.format === "svg" && job.width === 1280 && job.height === 720));
    const filesAfter = fs.existsSync(path.join(designs, "export-a", "exports"))
      ? fs.readdirSync(path.join(designs, "export-a", "exports")).length : 0;
    assert.equal(filesAfter, filesBefore, "planExport 不应写盘");
    // 纯函数：两次结果一致
    assert.deepEqual(planExport(workspace, "export-a", { format: "svg" }), plan);
  });

  await check("未知格式 / 非法板路径 / 画布不存在", async () => {
    const bad = planExport(workspace, "export-a", { format: "gif" });
    assert.equal(bad.jobs.length, 0);
    assert.ok(bad.errors.some((item) => item.includes("未知导出格式")), JSON.stringify(bad.errors));
    const missingBoard = planExport(workspace, "export-a", { format: "svg", boards: ["boards/nope.board.json"] });
    assert.ok(missingBoard.errors.some((item) => item.includes("画布中不存在该板")));
    const traversal = planExport(workspace, "export-a", { format: "svg", boards: ["../evil.board.json"] });
    assert.ok(traversal.errors.some((item) => item.includes("非法板路径")));
    await expectCode(() => planExport(workspace, "nope", { format: "svg" }), "CANVAS_NOT_FOUND");
  });

  await check("png 计划：导出视图 URL + 截图尺寸钳制", async () => {
    const plan = planExport(workspace, "export-a", { format: "png", boards: ["boards/body.board.json"] });
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.jobs.length, 1);
    const [job] = plan.jobs;
    assert.equal(job.format, "png");
    assert.equal(job.captureWidth, 1280);
    assert.equal(job.captureHeight, 720);
    const url = new URL(job.viewUrl);
    assert.equal(url.searchParams.get("export"), "canvas");
    assert.equal(url.searchParams.get("slug"), "export-a");
    assert.equal(url.searchParams.get("board"), "boards/body.board.json");
    assert.equal(url.searchParams.get("workspace"), workspace);
    // 超出内置浏览器上限 → 等比缩放并给 warning
    writeBoard(workspace, "export-a", "boards/huge.board.json", { v: 1, w: 8000, h: 8000, elements: [] });
    const scaled = planExport(workspace, "export-a", { format: "png", boards: ["boards/huge.board.json"] });
    assert.deepEqual(scaled.errors, []);
    assert.equal(scaled.jobs[0].captureWidth, 1600);
    assert.equal(scaled.jobs[0].captureHeight, 1600);
    assert.ok(scaled.warnings.some((item) => item.includes("等比缩放")), JSON.stringify(scaled.warnings));
  });

  await check("pdf 计划：尺寸必须一致；一致时整本一个 job（多板 URL）", async () => {
    const mixed = planExport(workspace, "export-a", { format: "pdf" });
    assert.equal(mixed.jobs.length, 0);
    assert.ok(mixed.errors.some((item) => item.includes("PDF 导出要求所有板尺寸一致")), JSON.stringify(mixed.errors));
    const plan = planExport(workspace, "export-a", { format: "pdf", boards: ["boards/cover.board.json", "boards/body.board.json"] });
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.jobs.length, 1);
    assert.deepEqual(plan.jobs[0].boards, ["boards/cover.board.json", "boards/body.board.json"]);
    const url = new URL(plan.jobs[0].viewUrl);
    assert.equal(url.searchParams.get("boards"), "boards/cover.board.json,boards/body.board.json");
    assert.equal(url.searchParams.get("format"), "pdf");
  });

  await check("兼容板不能导出 SVG，但可以进 png/pdf/pptx 计划", async () => {
    importCanvas(workspace, { sourcePath: compatRoot, slug: "compat-only" });
    const svgPlan = planExport(workspace, "compat-only", { format: "svg" });
    assert.equal(svgPlan.jobs.length, 0);
    assert.ok(svgPlan.errors.some((item) => item.includes("兼容板不支持 SVG 导出")), JSON.stringify(svgPlan.errors));
    for (const format of ["png", "pdf", "pptx"]) {
      const plan = planExport(workspace, "compat-only", { format });
      assert.deepEqual(plan.errors, [], `${format} 计划应无错误`);
      assert.equal(plan.jobs.length, 1, `${format} 应有一个任务`);
    }
  });

  await check("单次导出不超过 exportMaxBoards（50）板", async () => {
    const plan = planExport(workspace, "compat-only", { format: "png" });
    assert.ok(plan.jobs.length <= 50);
  });

  // ---------- SVG 序列化 ----------
  console.log("▶ SVG 序列化与 sanitize");

  await check("serializeBoardToSvg：text/rect/line/image(base64)/svg 全部内嵌", async () => {
    const { readBoard } = await import("../server/创作画布.mjs");
    const { board } = readBoard(workspace, "export-a", "boards/body.board.json");
    const projectDir = path.join(designs, "export-a", "project");
    const result = serializeBoardToSvg({ board, projectDir, baseDir: path.join(projectDir, "boards"), title: "导出画布" });
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.match(result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(result.svg, /width="1280"/);
    assert.match(result.svg, /viewBox="0 0 1280 720"/);
    // text → <text> + <tspan>，含中文字体白名单
    assert.match(result.svg, /<text /);
    assert.match(result.svg, /<tspan /);
    assert.ok(result.svg.includes(TITLE_TEXT), "文本内容应内联");
    assert.match(result.svg, /font-family="Microsoft YaHei, PingFang SC, Arial, sans-serif"/);
    // rect / line
    assert.match(result.svg, /<rect /);
    assert.match(result.svg, /<line /);
    // image → 内嵌 base64 data URI
    assert.match(result.svg, /<image [^>]*xlink:href="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
    // svg 块 → 嵌套 <svg>，且已 sanitize
    assert.match(result.svg, /<svg x="640" y="300"/);
    assert.ok(!/<script/i.test(result.svg), "导出 SVG 不得含 script");
    assert.ok(!/onclick/i.test(result.svg), "导出 SVG 不得含事件属性");
    assert.match(result.svg, /<rect width="100" height="100" fill="#2f6bff"\/>/);
  });

  await check("serializeBoardToSvg：素材缺失给出 warning 而不是崩溃", async () => {
    const projectDir = path.join(designs, "export-a", "project");
    const result = serializeBoardToSvg({
      board: { w: 100, h: 100, background: "#fff", elements: [{ id: "img", type: "image", x: 0, y: 0, w: 10, h: 10, src: "assets/none.png" }] },
      projectDir,
      baseDir: path.join(projectDir, "boards"),
    });
    assert.ok(result.warnings.some((item) => item.includes("图片素材缺失")), JSON.stringify(result.warnings));
    assert.ok(!/<image /.test(result.svg));
  });

  await check("sanitizeSvgMarkup 去除 script/on*/foreignObject/外链/http url()", async () => {
    const dirty = '<svg><script>alert(1)</script><foreignObject><div/></foreignObject>'
      + '<a href="https://evil/x" onclick="steal()">x</a><image href="http://evil/y.png"/>'
      + '<style>@import url(https://evil/a.css);</style><rect width="1" height="1" fill="url(https://evil/bg)"/></svg>';
    const clean = sanitizeSvgMarkup(dirty);
    assert.ok(!/<script/i.test(clean), clean);
    assert.ok(!/foreignObject/i.test(clean), clean);
    assert.ok(!/onclick/i.test(clean), clean);
    assert.ok(!/https?:\/\//i.test(clean), `外链应移除：${clean}`);
    assert.ok(!/@import/i.test(clean), clean);
    assert.match(clean, /<rect width="1" height="1"/);
  });

  // ---------- URL / 文件名 ----------
  console.log("▶ 导出视图 URL 与文件名");

  await check("buildCanvasExportUrl 单板/多板/元素渲染 URL", async () => {
    const single = new URL(buildCanvasExportUrl({ workspace, slug: "export-a", boards: ["boards/body.board.json"], format: "png" }));
    assert.equal(single.pathname, "/");
    assert.equal(single.searchParams.get("export"), "canvas");
    assert.equal(single.searchParams.get("workspace"), workspace);
    assert.equal(single.searchParams.get("slug"), "export-a");
    assert.equal(single.searchParams.get("board"), "boards/body.board.json");
    assert.equal(single.searchParams.get("format"), "png");
    const multi = new URL(buildCanvasExportUrl({ workspace, slug: "s", boards: ["a.board.json", "b.board.json"], format: "pdf" }));
    assert.equal(multi.searchParams.get("boards"), "a.board.json,b.board.json");
    assert.equal(multi.searchParams.get("format"), "pdf");
    assert.equal(multi.searchParams.get("board"), null);
    const render = new URL(buildCanvasExportUrl({ workspace, slug: "s", boards: ["a.board.json"], render: "svg", element: "el-1" }));
    assert.equal(render.searchParams.get("render"), "svg");
    assert.equal(render.searchParams.get("element"), "el-1");
  });

  await check("导出文件名清洗 + 同名自动加序", async () => {
    const name = buildExportFileName({ title: '报/告:<>"|?*', boardTitle: "封面", format: "png" });
    assert.ok(!/[\\/:*?"<>|]/.test(name), `文件名仍含非法字符：${name}`);
    assert.match(name, /\.png$/);
    assert.match(name, /^\S+-\d{8}-\d{6}\.png$/);
    const exportsDir = path.join(designs, "export-a", "exports");
    fs.mkdirSync(exportsDir, { recursive: true });
    const first = reserveExportFile(exportsDir, "同名.png");
    fs.writeFileSync(first, "x");
    const second = reserveExportFile(exportsDir, "同名.png");
    assert.notEqual(first, second);
    assert.match(second, /-2\.png$/);
    fs.rmSync(first, { force: true });
  });

  // ---------- runExport：SVG（无浏览器） ----------
  console.log("▶ runExport SVG（无需浏览器）");

  await check("runExport svg：落盘 exports/ 且返回 {files, jobId}", async () => {
    const result = await runExport(workspace, "export-a", { format: "svg", boards: ["boards/body.board.json"], actor: "agent" });
    assert.ok(result.jobId, "应返回 jobId");
    assert.equal(result.format, "svg");
    assert.equal(result.files.length, 1);
    const [file] = result.files;
    assert.ok(path.isAbsolute(file.path), "path 应为绝对路径");
    assert.match(file.relative, /^designs\/export-a\/exports\//);
    assert.ok(file.bytes > 0);
    assert.ok(fs.existsSync(file.path));
    const svg = fs.readFileSync(file.path, "utf8");
    assert.match(svg, /^<svg /);
    assert.ok(svg.includes(TITLE_TEXT));
    assert.ok(!/<script/i.test(svg));
    const jobs = listExportJobs(workspace, "export-a");
    const job = jobs.find((item) => item.jobId === result.jobId);
    assert.ok(job, "导出任务应可查询");
    assert.equal(job.status, "completed");
    assert.equal(job.done, 1);
  });

  await check("runExport 支持路由层传入 jobId（HTTP 队列与事件共用同一任务号）", async () => {
    const result = await runExport(workspace, "export-a", {
      format: "svg", boards: ["boards/body.board.json"], jobId: "canvas-export-route-42",
    });
    assert.equal(result.jobId, "canvas-export-route-42");
    const jobs = listExportJobs(workspace, "export-a", { jobId: "canvas-export-route-42" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "completed");
    await expectCode(
      () => runExport(workspace, "export-a", { format: "svg", jobId: "bad id!" }),
      "CANVAS_INVALID",
    );
  });

  await check("计划无效 → CANVAS_INVALID", async () => {
    const error = await expectCode(() => runExport(workspace, "export-a", { format: "gif" }), "CANVAS_INVALID");
    assert.ok(Array.isArray(error.details.errors));
  });

  // ---------- runExport：PNG / PDF（假浏览器） ----------
  console.log("▶ runExport PNG / PDF（假浏览器，断言调用链）");

  await check("runExport png：打开导出视图 → 调整视口 → 等就绪 → 截图 → 落盘", async () => {
    const fake = createFakeBrowser();
    const result = await runExport(workspace, "export-a", { format: "png", boards: ["boards/body.board.json"] }, { browser: fake });
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].path, /\.png$/);
    assert.equal(fs.statSync(result.files[0].path).size, Buffer.byteLength(TINY_PNG_BASE64, "base64"));
    const ops = fake.calls.map((call) => call.op);
    assert.deepEqual(ops, ["open", "resize", "wait", "evaluate", "screenshot"]);
    const openCall = fake.calls[0];
    const url = new URL(openCall.url);
    assert.equal(url.searchParams.get("export"), "canvas");
    assert.equal(url.searchParams.get("slug"), "export-a");
    assert.equal(url.searchParams.get("board"), "boards/body.board.json");
    assert.deepEqual([fake.calls[1].width, fake.calls[1].height], [1280, 720]);
    assert.equal(fake.calls[2].expression, "window.__OAW_EXPORT_READY === true");
    assert.equal(fake.calls[4].format, "png");
  });

  await check("runExport pdf：一次 printToPDF 落一个文件（多板分页）", async () => {
    const fake = createFakeBrowser();
    const result = await runExport(workspace, "export-a", { format: "pdf", boards: ["boards/cover.board.json", "boards/body.board.json"] }, { browser: fake });
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].path, /\.pdf$/);
    const ops = fake.calls.map((call) => call.op);
    assert.equal(ops.filter((op) => op === "print").length, 1);
    assert.equal(ops.filter((op) => op === "open").length, 1);
    const url = new URL(fake.calls[0].url);
    assert.equal(url.searchParams.get("boards"), "boards/cover.board.json,boards/body.board.json");
  });

  await check("浏览器缺失（deps.browser=null）→ CANVAS_BROWSER_UNAVAILABLE", async () => {
    await expectCode(
      () => runExport(workspace, "export-a", { format: "png" }, { browser: null }),
      "CANVAS_BROWSER_UNAVAILABLE",
    );
  });

  await check("同一画布并发导出 → CANVAS_BUSY，释放后可再导出", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = createFakeBrowser({ gate });
    const first = runExport(workspace, "export-a", { format: "png", boards: ["boards/body.board.json"] }, { browser: slow });
    // 等第一个任务进入浏览器阶段并占住画布
    const startedAt = Date.now();
    while (!slow.calls.some((call) => call.op === "open") && Date.now() - startedAt < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const busy = await expectCode(
      () => runExport(workspace, "export-a", { format: "png", boards: ["boards/body.board.json"] }, { browser: createFakeBrowser() }),
      "CANVAS_BUSY",
    );
    assert.match(busy.message, /导出任务/);
    release();
    const firstResult = await first;
    assert.equal(firstResult.files.length, 1);
    const again = await runExport(workspace, "export-a", { format: "png", boards: ["boards/body.board.json"] }, { browser: createFakeBrowser() });
    assert.equal(again.files.length, 1);
  });

  await check("PDF 多板：导出视图未渲染全部板时失败并给可执行原因（不产出缺页 PDF）", async () => {
    const fake = createFakeBrowser();
    fake.browserEvaluateValue = async (key, expression) => (String(expression).includes("data-board") ? 1 : "");
    const error = await expectCode(
      () => runExport(workspace, "export-a", { format: "pdf", boards: ["boards/cover.board.json", "boards/body.board.json"] }, { browser: fake }),
      "CANVAS_EXPORT_FAILED",
    );
    assert.match(error.message, /支持 boards 参数/);
  });

  await check("导出失败时任务标记 failed 并返回 CANVAS_EXPORT_FAILED", async () => {
    const failing = createFakeBrowser();
    failing.browserScreenshot = async () => { throw new Error("模拟截图失败"); };
    const error = await expectCode(
      () => runExport(workspace, "export-a", { format: "png", boards: ["boards/body.board.json"] }, { browser: failing }),
      "CANVAS_EXPORT_FAILED",
    );
    assert.equal(error.details.format, "png");
    const jobs = listExportJobs(workspace, "export-a", { jobId: error.details.jobId });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "failed");
    assert.ok(jobs[0].errors.some((item) => item.includes("模拟截图失败")), JSON.stringify(jobs[0].errors));
  });

  // ---------- runExport：PPTX ----------
  console.log("▶ runExport PPTX（可编辑文本断言）");

  await check("PPTX：对象板文本为可编辑 run，兼容板为整页图片", async () => {
    // 混合画布：导入兼容板（html 图片页）+ 新增对象板（可编辑文本）
    importCanvas(workspace, { sourcePath: compatRoot, slug: "mixed-deck" });
    writeBoard(workspace, "mixed-deck", "boards/editable.board.json", {
      v: 1, w: 1280, h: 720, background: "#ffffff",
      elements: [
        { id: "el-title", type: "text", x: 80, y: 64, w: 960, h: 120, text: TITLE_TEXT, style: { fontSize: 56, fontWeight: 700, color: "#141413" } },
        { id: "el-bar", type: "rect", x: 80, y: 220, w: 400, h: 12, style: { fill: "#2f6bff" } },
        { id: "el-inline", type: "svg", x: 640, y: 300, w: 200, h: 200, markup: SVG_MARKUP },
      ],
    });
    const plans = planExport(workspace, "mixed-deck", { format: "pptx" });
    assert.deepEqual(plans.errors, []);
    assert.equal(plans.jobs.length, 1);
    assert.equal(plans.jobs[0].boards.length, 2);
    assert.deepEqual(plans.jobs[0].imagePages.map((item) => item.boardPath), ["legacy/Main.dc.html"]);

    const fake = createFakeBrowser();
    const result = await runExport(workspace, "mixed-deck", { format: "pptx" }, { browser: fake });
    assert.equal(result.files.length, 1);
    const file = result.files[0];
    assert.match(file.path, /\.pptx$/);
    assert.ok(fs.statSync(file.path).size > 1000, "PPTX 应有实际内容");
    assert.deepEqual(result.imagePages.map((item) => item.boardPath), ["legacy/Main.dc.html"]);
    // 只为兼容板打开一次导出视图（SVG 块默认内嵌矢量，不额外栅格化截图）
    assert.equal(fake.calls.filter((call) => call.op === "open").length, 1);
    assert.ok(result.warnings.some((item) => item.includes("矢量内嵌")), JSON.stringify(result.warnings));

    const zip = await JSZip.loadAsync(fs.readFileSync(file.path));
    const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
    assert.equal(slideNames.length, 2, `应有 2 页，实际 ${slideNames.join(",")}`);
    const slideXmls = [];
    for (const name of slideNames) slideXmls.push(await zip.file(name).async("string"));

    const editableIndex = slideXmls.findIndex((xml) => xml.includes("<a:t>") && xml.includes(TITLE_TEXT));
    assert.ok(editableIndex >= 0, `<a:t> 应包含可编辑文本 ${TITLE_TEXT}`);
    assert.match(slideXmls[editableIndex], /<a:t>/, "文本 run 必须存在");
    // 形状映射存在（rect → p:sp）；SVG 块以图片形式内嵌在同页
    assert.match(slideXmls[editableIndex], /<p:sp>/);

    const imageIndex = slideXmls.findIndex((xml, index) => index !== editableIndex && xml.includes("<p:pic"));
    assert.ok(imageIndex >= 0, "兼容板页应包含图片");
    assert.ok(!slideXmls[imageIndex].includes(TITLE_TEXT), "兼容板页不应含可编辑文本");
    // 兼容板页是整页图片：只有 1 个图片对象，且没有额外文本 run
    assert.ok(!slideXmls[imageIndex].includes("<a:t>"), "兼容板页不应有文本 run");
    assert.equal((slideXmls[imageIndex].match(/<p:pic>/g) || []).length, 1, "兼容板页应是单张整页图片");
    // 幻灯片尺寸：1280×720 px → 13.333×7.5 in（9144000 EMU / 6858000 EMU）
    const presentation = await zip.file("ppt/presentation.xml").async("string");
    assert.match(presentation, /cx="12192000"/);
    assert.match(presentation, /cy="6858000"/);
  });

  await check("PPTX 纯对象板可在无浏览器环境离线生成（deps.browser=null）", async () => {
    createCanvas(workspace, { slug: "offline-deck", title: "离线 deck" });
    writeBoard(workspace, "offline-deck", "boards/only.board.json", {
      v: 1, w: 1280, h: 720, elements: [
        { id: "el-t", type: "text", x: 40, y: 40, w: 400, h: 80, text: "离线文本", style: { fontSize: 32 } },
      ],
    });
    const result = await runExport(workspace, "offline-deck", { format: "pptx" }, { browser: null });
    assert.equal(result.files.length, 1);
    const zip = await JSZip.loadAsync(fs.readFileSync(result.files[0].path));
    const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
    assert.equal(slideNames.length, 2, "空白封面板 + 文本板 = 2 页");
    const allText = [];
    for (const name of slideNames) allText.push(await zip.file(name).async("string"));
    assert.ok(allText.some((xml) => /<a:t>离线文本<\/a:t>/.test(xml)), "应存在可编辑文本 run");
  });

  await check("兼容板 PPTX 在浏览器缺失时给出 CANVAS_BROWSER_UNAVAILABLE", async () => {
    await expectCode(
      () => runExport(workspace, "mixed-deck", { format: "pptx" }, { browser: null }),
      "CANVAS_BROWSER_UNAVAILABLE",
    );
  });

  await check("listExportJobs 最新在前，且只返回本画布任务", async () => {
    const jobs = listExportJobs(workspace, "export-a");
    assert.ok(jobs.length >= 3, `应有多条任务记录，实际 ${jobs.length}`);
    for (let index = 1; index < jobs.length; index += 1) {
      assert.ok(String(jobs[index - 1].createdAt) >= String(jobs[index].createdAt), "任务应按创建时间倒序");
    }
    assert.ok(jobs.every((job) => job.slug === "export-a"));
    assert.ok(jobs.every((job) => typeof job.jobId === "string" && job.jobId.startsWith("canvas-export-")));
    const other = listExportJobs(workspace, "offline-deck");
    assert.ok(other.every((job) => job.slug === "offline-deck"));
  });
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

if (process.exitCode) {
  console.error(`创作画布导出回归：存在失败用例（通过 ${passed.length} 项）`);
} else {
  console.log(`创作画布导出回归：通过（${passed.length} 项）`);
}
