#!/usr/bin/env node
/**
 * 架构边界棘轮检查（2026-11-18，审查报告 P1-2）
 *
 * 背景：架构规范 §3/§6 写了「组件禁止直接 fetch」「SSE 统一走长连接预算」
 * 「server/ 不得 import scripts/」「Pi SDK 只允许 3 个文件直接 import」，
 * 但这些条款没有任何自动检查，存量违规多年无人发现。
 *
 * 做法：**棘轮**而不是一次性清零——把当前存量写进基线，只允许减少不允许增加。
 *   - 新增文件出现违规、或已有文件违规数变大 → 失败；
 *   - 违规数下降 → 提示更新基线（不阻塞）；
 *   - `--update` 按当前实际重写基线（只用于「确认减少后」登记）。
 *
 * 用法：
 *   node scripts/架构边界检查.mjs
 *   node scripts/架构边界检查.mjs --update
 *   npm run test:arch-boundary
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts", "架构边界基线.json");
const UPDATE = process.argv.includes("--update");

function walk(dir, exts, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const read = (file) => fs.readFileSync(file, "utf8");
const count = (text, re) => (text.match(re) || []).length;

/** 规则：client 组件直接 fetch（api.js 是唯一允许的 HTTP 封装）。 */
function directFetch() {
  const result = {};
  for (const file of walk(path.join(ROOT, "client/src"), [".jsx", ".js"])) {
    const name = rel(file);
    if (name === "client/src/api.js") continue;
    const n = count(read(file), /\bfetch\s*\(/g);
    if (n > 0) result[name] = n;
  }
  return result;
}

/** 规则：组件各自 new EventSource（应统一经 client/src/长连接预算.js）。 */
function rawEventSource() {
  const result = {};
  for (const file of walk(path.join(ROOT, "client/src"), [".jsx", ".js"])) {
    const n = count(read(file), /new\s+EventSource\s*\(/g);
    if (n > 0) result[rel(file)] = n;
  }
  return result;
}

/** 规则：server/ 反向 import scripts/（依赖方向只能 scripts → server）。 */
function serverImportsScripts() {
  const result = {};
  for (const file of walk(path.join(ROOT, "server"), [".mjs", ".js"])) {
    const n = count(read(file), /from\s+["'][^"']*\.\.\/scripts\//g);
    if (n > 0) result[rel(file)] = n;
  }
  return result;
}

/** 规则：Pi SDK 直接 import 只允许三个 server 适配模块（scripts/ 是测试与工具，不在此限）。 */
const PI_ALLOWED = new Set([
  "server/agent.mjs",
  "server/Pi运行时管理.mjs",
  "server/项目信任.mjs",
]);
function piImports() {
  const result = {};
  for (const file of walk(path.join(ROOT, "server"), [".mjs", ".js"])) {
    const name = rel(file);
    if (PI_ALLOWED.has(name)) continue;
    const n = count(read(file), /from\s+["']@earendil-works\/pi-coding-agent["']|import\(\s*["']@earendil-works\/pi-coding-agent["']/g);
    if (n > 0) result[name] = n;
  }
  return result;
}

const rules = [
  { id: "client-direct-fetch", desc: "组件直接 fetch（应走 client/src/api.js）", data: directFetch() },
  { id: "client-raw-eventsource", desc: "组件各自 new EventSource（应走长连接预算.js）", data: rawEventSource() },
  { id: "server-imports-scripts", desc: "server/ 反向 import scripts/", data: serverImportsScripts() },
  { id: "pi-sdk-import", desc: "Pi SDK 直接 import（仅 3 个适配模块允许）", data: piImports() },
];

const baseline = fs.existsSync(BASELINE_FILE)
  ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"))
  : { version: 1, updatedAt: new Date().toISOString().slice(0, 10), rules: {} };

if (UPDATE) {
  const next = { version: 1, updatedAt: new Date().toISOString().slice(0, 10), rules: {} };
  for (const rule of rules) next.rules[rule.id] = rule.data;
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`已重写架构边界基线：${rel(BASELINE_FILE)}`);
  process.exit(0);
}

let failed = 0;
const reduced = [];
console.log("\n▶ 架构边界棘轮检查");

for (const rule of rules) {
  const base = baseline.rules?.[rule.id] || {};
  const worse = [];
  for (const [file, n] of Object.entries(rule.data)) {
    const allowed = Number(base[file] || 0);
    if (n > allowed) worse.push(`${file}（${allowed} → ${n}）`);
  }
  if (worse.length) {
    failed = 1;
    console.error(`  ✗ ${rule.desc}`);
    for (const item of worse) console.error(`      ${item}；新增违规请改为复用既有通道，或走 ADR 调整边界`);
  } else {
    const total = Object.values(rule.data).reduce((a, b) => a + b, 0);
    const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
    const note = baseTotal > total ? `（存量 ${baseTotal} → ${total}，可 --update 收紧）` : "";
    console.log(`  ✓ ${rule.desc}：存量 ${total} 条${note}`);
    if (baseTotal > total) reduced.push(rule.id);
  }
}

if (reduced.length) {
  console.log(`\n提示：${reduced.join(" / ")} 的存量已下降，确认后可运行 --update 收紧基线。`);
}
console.log(failed ? "\n架构边界检查：存在新增违规" : "\n架构边界检查：未新增违规（棘轮基线见 scripts/架构边界基线.json）");
process.exitCode = failed ? 1 : 0;
