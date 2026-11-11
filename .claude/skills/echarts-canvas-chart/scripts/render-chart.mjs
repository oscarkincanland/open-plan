#!/usr/bin/env node
/**
 * ECharts SSR 渲染脚本（echarts-canvas-chart 技能，2026-11-11-007）。
 *
 * 用法：
 *   node render-chart.mjs --option <option.json> --out <chart.svg> \
 *     --width 1280 --height 720 [--depsDir <workspace>/.oaw/skill-deps/echarts-canvas-chart]
 *
 * 行为：
 *   - 从 --depsDir 用 createRequire 解析 echarts（依赖由技能中心安装到工作区，脚本不带任何仓库依赖）；
 *   - SSR（无 DOM）：echarts.init(null,null,{renderer:"svg",ssr:true,width,height}) → setOption → renderToSVGString；
 *   - option 只从 JSON 文件读入（禁止 eval/函数），输出为静态展示 SVG（无脚本，画布清洗管线可直接收）；
 *   - 退出码：0 成功；2 依赖未装；3 参数/IO 错误；4 option 非 JSON 或含非法内容。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function fail(code, message) {
  console.error(`[${code}] ${message}`);
  process.exit(code === "ECHARTS_MISSING" ? 2 : code === "USAGE" || code === "IO" ? 3 : 4);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : "";
}

const optionFile = arg("option");
const outFile = arg("out");
const width = Math.round(Number(arg("width")) || 1280);
const height = Math.round(Number(arg("height")) || 720);
const depsDir = path.resolve(arg("depsDir") || process.env.SKILL_DEPS_DIR || "");

if (!optionFile || !outFile || !depsDir) {
  fail("USAGE", "需要 --option <json> --out <svg> --width N --height N --depsDir <skill-deps 目录>");
}
if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
  fail("USAGE", `尺寸非法：${width}x${height}`);
}

let optionText = "";
try { optionText = fs.readFileSync(optionFile, "utf8"); } catch (e) {
  fail("IO", `option 文件读取失败：${optionFile}（${e.message}）`);
}
let option;
try {
  option = JSON.parse(optionText);
} catch (e) {
  fail("OPTION_INVALID", `option 不是合法 JSON：${e.message}（本技能不接受 JS/函数，只接受纯 JSON）`);
}
if (!option || typeof option !== "object" || Array.isArray(option)) {
  fail("OPTION_INVALID", "option 必须是 JSON 对象");
}
if (JSON.stringify(option).length > 512 * 1024) {
  fail("OPTION_INVALID", "option 过大（>512KB），请精简数据");
}

// 解析 echarts：createRequire 锚定 deps 目录，向上只查该目录的 node_modules。
let echarts;
try {
  const requireFromDeps = createRequire(path.join(depsDir, "package.json"));
  echarts = requireFromDeps("echarts");
} catch (e) {
  fail("ECHARTS_MISSING",
    `echarts 未安装或不可解析（depsDir=${depsDir}）。\n`
    + `请在技能中心安装本技能依赖，或手动执行：\n`
    + `  npm install echarts --prefix "${depsDir}"`);
}
if (!echarts || typeof echarts.init !== "function") {
  fail("ECHARTS_MISSING", "echarts 加载异常（缺少 init API），请安装 echarts@>=5.3");
}

let chart;
try {
  chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, svg, "utf8");
  const bytes = Buffer.byteLength(svg, "utf8");
  console.log(`OK 已渲染 ${width}x${height} → ${outFile}（${Math.round(bytes / 1024)} KB）`);
} catch (e) {
  fail("RENDER_FAILED", `渲染失败：${e.message}`);
} finally {
  try { chart?.dispose?.(); } catch {}
}
