/**
 * 平台边界检查（ADR 0024 的强制门禁）。
 *
 * 为什么需要：桌面端采用「一份源码 + 平台适配层」，一旦有人把 Electron 依赖漏进
 * 共享层（client/ 或 server/），web 形态立刻不可构建，而这种破坏在桌面端本地跑不出来。
 * 所以用静态扫描把它挡在提交前。
 *
 * 规则（任一命中即失败）：
 *   R1 client/、server/ 的**非平台层**代码不得 import/require electron
 *   R2 client/ 不得出现 window.require / ipcRenderer / __dirname hack
 *   R3 desktop/ 不得复制业务实现（只允许壳文件白名单）
 *   R4 server/ 不得硬编码 Windows 盘符绝对路径
 *   R5 平台适配层不得反向 import 业务模块（只允许 node: 内置与同层）
 *
 * 用法: node scripts/平台边界检查.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

/** 递归收集文件（跳过 node_modules / dist / 隐藏目录）。 */
function walk(dir, exts, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 构建产物目录一律跳过：它们包含 Electron 运行时与打包后的 server/ 副本（属预期，不是违规复制）
      if (/^(node_modules|dist|dist-app|out|release|release\d+|build-app|\.git|\.oaw|\.sessions|\.规聚会话)$/i.test(entry.name)) continue;
      walk(full, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

function readLines(file) {
  try { return fs.readFileSync(file, "utf8").split("\n"); } catch { return []; }
}

const IMPORT_ELECTRON = /(?:from\s+|require\(\s*|import\(\s*)[`'"]electron(?:\/[^`'"]*)?[`'"]/;

console.log("\n▶ R1 共享层禁止依赖 Electron");
const sharedLayers = [
  { dir: path.join(ROOT, "client", "src"), exts: [".js", ".jsx", ".ts", ".tsx"], allow: ["平台/"] },
  { dir: path.join(ROOT, "server"), exts: [".mjs", ".js"], allow: ["平台/"] },
];
let r1checked = 0;
for (const layer of sharedLayers) {
  for (const file of walk(layer.dir, layer.exts)) {
    const relative = path.relative(layer.dir, file).split(path.sep).join("/");
    if (layer.allow.some((prefix) => relative.startsWith(prefix))) continue;
    r1checked += 1;
    const lines = readLines(file);
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释豁免
      if (IMPORT_ELECTRON.test(line)) fail(`${rel(file)}:${index + 1} 共享层出现 electron 依赖`);
    });
  }
}
if (!failed) ok(`已扫描 ${r1checked} 个共享层文件，无 electron 依赖`);

console.log("\n▶ R2 前端不直接使用 Electron 私有通道");
const r2Hits = [];
for (const file of walk(path.join(ROOT, "client", "src"), [".js", ".jsx", ".ts", ".tsx"])) {
  const relative = rel(file);
  if (relative.includes("/平台/")) continue;
  readLines(file).forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (/window\.require\s*\(|ipcRenderer|process\.versions\.electron/.test(line)) {
      r2Hits.push(`${relative}:${index + 1}`);
    }
  });
}
if (r2Hits.length) r2Hits.forEach((hit) => fail(`${hit} 前端直接使用 Electron 私有通道`));
else ok("未发现 window.require / ipcRenderer / process.versions.electron");

console.log("\n▶ R3 外壳不得复制业务实现");
const DESKTOP_ALLOW = /^(src\/(main|服务宿主|浏览器视图|原生桥|菜单|诊断)\.(mjs|cjs)|src\/preload\.cjs|electron\.vite\.config\.mjs|electron-builder\.yml|build\/|scripts\/|package\.json$|README\.md$|assets\/)/;
const desktopDir = path.join(ROOT, "desktop");
if (fs.existsSync(desktopDir)) {
  const offenders = [];
  for (const file of walk(desktopDir, [".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx"])) {
    const relative = path.relative(desktopDir, file).split(path.sep).join("/");
    if (!DESKTOP_ALLOW.test(relative)) offenders.push(relative);
  }
  if (offenders.length) offenders.forEach((item) => fail(`desktop/${item} 不在壳文件白名单内（疑似复制业务实现）`));
  else ok(`desktop/ 仅含壳文件（${fs.existsSync(path.join(desktopDir, "src")) ? "src/ 已建立" : "尚未建立"}）`);
} else {
  ok("desktop/ 尚未建立（跳过）");
}

console.log("\n▶ R4 服务端不得硬编码「本机」绝对路径（数据/工作区）");
// 说明：操作系统安装目录（C:\Program Files、C:\Windows）、浏览器可执行文件候选路径
// 属于合法的「探测安装位置」，不算违规。真正要禁的是把**开发机**的项目路径或
// 用户目录写死进代码——那些一换机器就坏，且桌面端会指向错误位置。
const projectRootLiteral = ROOT.replace(/\//g, "\\");
const currentUser = process.env.USERNAME || "";
const driveHits = [];
for (const file of walk(path.join(ROOT, "server"), [".mjs"])) {
  const relative = rel(file);
  if (relative.startsWith("server/平台/")) continue; // 平台层允许（探测安装路径）
  readLines(file).forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const isProjectPath = line.includes(projectRootLiteral);
    const isUserLeak = currentUser && new RegExp(`[A-Za-z]:\\\\+Users\\\\+${currentUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(line);
    if (isProjectPath || isUserLeak) {
      driveHits.push(`${relative}:${index + 1}${isProjectPath ? "（写死项目路径）" : "（写死当前用户目录）"}`);
    }
  });
}
if (driveHits.length) driveHits.slice(0, 10).forEach((hit) => fail(`${hit}`));
else ok("未发现写死本机项目路径或用户目录");

console.log("\n▶ R5 平台适配层不得反向依赖业务模块");
const platformDirs = [path.join(ROOT, "server", "平台"), path.join(ROOT, "client", "src", "平台")];
let r5checked = 0;
for (const dir of platformDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir, [".mjs", ".js"])) {
    r5checked += 1;
    readLines(file).forEach((line, index) => {
      const m = line.match(/from\s+[`'"](\.\.\/[^`'"]+)[`'"]/);
      if (m && !m[1].startsWith("../平台/")) {
        fail(`${rel(file)}:${index + 1} 平台层反向依赖业务模块 ${m[1]}`);
      }
    });
  }
}
if (r5checked) ok(`已扫描 ${r5checked} 个平台层文件，无反向依赖`);
else ok("平台层尚未建立（跳过）");

console.log("\n▶ R6 文件树契约（ADR 0024）");
const required = [
  ["server/平台/宿主信息.mjs", "宿主信息"],
  ["server/平台/外部二进制.mjs", "外部二进制"],
];
for (const [file, label] of required) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`缺少平台适配层文件：${file}（${label}）`);
}
if (!failed) ok("平台适配层基础文件齐备");

console.log(failed ? "\n平台边界检查：失败" : "\n平台边界检查：通过");
process.exit(failed ? 1 : 0);
