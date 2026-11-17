#!/usr/bin/env node
/**
 * 工作区开始页与产物卡重做回归测试（计划 2026-11-11-011）。
 *
 * 两块契约：
 *   A. 开始页：切换工作区后在画布注入单例「开始」视图（不持久化），页面纯展示、
 *      入口复用 + 菜单动作、「更多工具」就地展开（不新增向下浮层）。
 *   B. 产物卡：默认 3 条主要交付物 + 折叠行（折叠行在滚动容器之外）、常驻三种打开方式、
 *      文件类型图标按扩展名区分（含字符串入参这条历史缺陷）。
 *
 * 用法: node scripts/工作区开始页与产物卡测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error?.message || error}`); failed = 1; }
}

const canvasState = read("client/src/画布状态.js");
const app = read("client/src/App.jsx");
const tabbar = read("client/src/components/画布标签栏.jsx");
const startPage = read("client/src/components/工作区开始页.jsx");
const artifactCard = read("client/src/components/会话流/ArtifactCard.jsx");
const fileIcon = read("client/src/components/文件类型图标.jsx");
const chat = read("client/src/components/ChatPanel.jsx");
const styles = read("client/src/styles.css");
const externalOpen = read("client/src/平台/外部打开.js");

console.log("工作区开始页与产物卡回归测试");

console.log("\n▶ 开始页：视图与注入");

test("画布状态登记 start 视图，且不写入持久化标签", () => {
  assert.match(canvasState, /start: \{ title: "开始", icon: "grid" \}/, "缺少 start 视图元数据");
  assert.match(canvasState, /SINGLETON_TAB_KINDS = new Set\(\["start"/, "start 必须是单例视图");
  assert.match(canvasState, /if \(kind === "start"\) return null;/, "start 不得持久化（否则每次冷启动都强制展开右栏）");
});

test("切换工作区后由恢复流程注入开始页（不会被持久化状态冲掉）", () => {
  assert.match(app, /const pendingStartPageRef = useRef\(false\);/, "缺少待注入标记");
  assert.match(app, /pendingStartPageRef\.current = true;/, "切换工作区后未标记注入");
  assert.match(app, /if \(pendingStartPageRef\.current\) \{[\s\S]{0,400}createViewTab\("start"\)/, "恢复流程未注入开始页标签");
  assert.match(app, /nextTabs = \[startTab, \.\.\.allowed\.filter\(\(tab\) => tab\.kind !== "start"\)\]/, "开始页应排在已有标签之前且去重");
});

test("开始页渲染分支、入口与 + 菜单动作都已接线", () => {
  assert.match(app, /import 工作区开始页 from "\.\/components\/工作区开始页\.jsx"/, "缺少开始页组件导入");
  assert.match(app, /canvas-body-start \$\{activeCanvasTab\?\.kind === "start"/, "缺少开始页画布分支");
  assert.match(app, /<工作区开始页[\s\S]{0,2400}entries=\{\[/, "开始页未注入入口卡片");
  assert.match(app, /if \(action === "start"\) \{ openStartPage\(\); return; \}/, "+ 菜单未接开始页动作");
  assert.match(tabbar, /onClick=\{\(\) => run\("start"\)\}[\s\S]{0,80}开始页/, "+ 菜单缺少「开始页」项");
});

test("开始页是纯展示组件：不自己 fetch，动作由 props 注入", () => {
  assert.doesNotMatch(startPage, /\bfetch\(/, "开始页不得自行请求接口");
  assert.match(startPage, /export default function 工作区开始页\(\{/, "缺少组件签名");
  for (const prop of ["entries", "moreEntries", "sessions", "onOpenSession", "onNewChat", "onSearch"]) {
    assert.ok(startPage.includes(prop), `缺少注入项 ${prop}`);
  }
});

test("「更多工具」就地展开，不引入新的向下浮层", () => {
  assert.match(startPage, /const \[showMore, setShowMore\] = React\.useState\(false\)/, "更多工具缺少就地展开状态");
  assert.match(startPage, /\{showMore && extraEntries\.map/, "更多工具未就地展开");
  assert.doesNotMatch(startPage, /<details|popover|dropdown/i, "开始页不应引入弹出层");
});

test("开始页样式与画布容器样式就位", () => {
  assert.match(styles, /\.start-page \{/, "缺少 .start-page 样式");
  assert.match(styles, /\.start-tile \{/, "缺少入口卡片样式");
  assert.match(styles, /\.canvas-body-start/, "画布未声明 start 容器");
});

console.log("\n▶ 产物卡：主要交付 + 折叠 + 打开方式");

test("默认只列 3 条主要交付物，折叠行在滚动容器之外", () => {
  assert.match(artifactCard, /const PRIMARY_LIMIT = 3;/, "首屏条数应为 3");
  assert.match(artifactCard, /const visible = expanded \? sorted : sorted\.slice\(0, PRIMARY_LIMIT\)/, "未按主要交付物截断");
  assert.match(artifactCard, /<\/div>\s*\{hidden > 0 && \(/, "折叠按钮必须放在列表容器之外（旧实现在滚动容器内会被裁掉）");
  assert.match(styles, /\.ac-card \.product-cards\.ac-files \{ max-height: none; overflow: visible; \}/, "产物卡不应再有内部滚动裁切");
  assert.match(styles, /\.ac-more \{/, "缺少折叠行样式（旧实现 .ac-more 无样式）");
});

test("排序：交付优先 + 文档类优先", () => {
  assert.match(artifactCard, /const deliverable = Number\(Boolean\(b\.item\.deliverable\)\) - Number\(Boolean\(a\.item\.deliverable\)\)/, "缺少交付优先排序");
  assert.match(artifactCard, /const KIND_RANK = \{ doc: 0, sheet: 1, slides: 2, pdf: 3/, "缺少类型优先级");
});

test("每条产物三种打开方式，且全是图标按钮（无向下浮层）", () => {
  assert.match(artifactCard, /from "\.\.\/\.\.\/平台\/外部打开\.js"/, "未复用平台外部打开适配层");
  assert.match(artifactCard, /onClick=\{\(\) => openExternally\(item\)\}/, "缺少系统默认程序打开");
  assert.match(artifactCard, /onClick=\{\(\) => revealItem\(item\)\}/, "缺少在文件夹中显示");
  assert.match(artifactCard, /className="product-card-iconbtn"[\s\S]{0,200}aria-label=\{`用系统默认应用打开/, "系统打开缺少无障碍名称");
  assert.doesNotMatch(artifactCard, /aria-haspopup/, "产物卡不应再引入弹出菜单");
  assert.match(externalOpen, /\/api\/system\/open/, "外部打开应指向真实端点 /api/system/open");
  assert.match(externalOpen, /\/api\/system\/reveal/, "文件夹定位应指向真实端点 /api/system/reveal");
  assert.doesNotMatch(externalOpen, /fetch\("\/api\/native\//, "不得再请求不存在的 native 端点（历史死代码）");
});

test("文件类型图标支持字符串入参（此前一律落回灰色通用图标的根因）", () => {
  assert.match(fileIcon, /const source = typeof file === "string" \? file : \(file\?\.name \|\| file\?\.path \|\| ""\);/, "未处理字符串入参");
  assert.match(fileIcon, /artifactTypeInfo\(source\)/, "类型解析未使用归一后的来源");
});

console.log("\n▶ 收敛：RunSummary 与图标视觉");

test("RunSummary 复用 ArtifactCard，不再内联第二份产物列表", () => {
  assert.match(chat, /<ArtifactCard products=\{productCards\} onOpenFile=\{onOpenFile\} onOpenPanel=\{onOpenArtifacts\} \/>/, "RunSummary 应复用 ArtifactCard");
  assert.doesNotMatch(chat, /productCards\.slice\(0, 6\)\.map/, "RunSummary 仍在维护内联产物列表");
});

test("类型图标视觉：实色类型底 + 白色字形（文档类型肉眼可分）", () => {
  assert.match(styles, /\.file-type-icon \{[\s\S]{0,400}?background: var\(--file-tone, var\(--file-other\)\);/, "类型图标底色应为实色类型色");
  assert.match(styles, /\.file-type-icon \{[\s\S]{0,400}?color: var\(--file-icon-fg, #fff\);/, "类型图标字形应为白色");
  assert.match(styles, /\.product-card-icon \{[^}]*background: transparent;/, "产物卡不应再叠一层灰底方块（方块套方块会吃掉类型色）");
});

if (failed) {
  console.error("工作区开始页与产物卡回归：未通过");
  process.exit(1);
}
console.log("工作区开始页与产物卡回归：通过");
