#!/usr/bin/env node
/**
 * 界面一致性守护（DESIGN §5.8 / §12）：
 *   1) 除 Feedback.jsx 的兜底实现外，禁止 window.alert / confirm / prompt；
 *   2) 功能代码不得用 emoji 充当图标；
 *   3) 功能代码不得用 ▸ / ▾ / ↗ 字符箭头（折叠区优先 chevron 图标或 CSS 三角）；
 *   4) JSX/JS 里的界面色值必须走设计令牌；只有数据可视化色板/品牌图形可硬编码，
 *      且按文件冻结数量（只降不增）。
 *
 * 运行：node scripts/界面一致性守护测试.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "client", "src");
const 反馈白名单 = path.join(SRC, "components", "Feedback.jsx");

/**
 * 数据可视化色板 / 品牌图形的硬编码白名单（2026-10-29 实测数量）。
 * 这些色值会写进图层 paint、图表节点、文档字体色板或品牌渐变，不是界面主题色，
 * 换成 var() 会在 MapLibre/Canvas/SVG 属性里失效或改变导出结果，因此允许保留；
 * 但数量只允许下降，新增任何一项都要先确认语义。
 */
const 色值白名单 = new Map([
  ["client/src/components/AgentMarket.jsx", { 数量: 1, 理由: "智能体默认头像色（持久化数据）" }],
  ["client/src/components/DocxViewer.jsx", { 数量: 31, 理由: "文档字体/高亮色板（用户可选数据）" }],
  ["client/src/components/KnowledgeGraph.jsx", { 数量: 21, 理由: "知识图谱分类色板" }],
  ["client/src/components/LayerPanel.jsx", { 数量: 37, 理由: "图层配色方案与默认 paint" }],
  ["client/src/components/Logo.jsx", { 数量: 3, 理由: "品牌图形渐变" }],
  ["client/src/components/MapPanel.jsx", { 数量: 47, 理由: "地图默认样式与专题图配色" }],
  ["client/src/components/MapViewer.jsx", { 数量: 43, 理由: "地图默认样式" }],
  ["client/src/components/MindMap.jsx", { 数量: 7, 理由: "思维导图节点色板" }],
  ["client/src/components/内置浏览器面板.jsx", { 数量: 2, 理由: "浏览器品牌标记" }],
  ["client/src/components/地图导出视图.jsx", { 数量: 3, 理由: "导出视图固定白底（打印语义）" }],
  ["client/src/components/桌面端Agent原型.jsx", { 数量: 8, 理由: "风格预览色卡（演示数据）" }],
  ["client/src/界面外观.js", { 数量: 2, 理由: "跑马灯配色提示文案" }],
]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(jsx|js)$/.test(entry.name)) yield p;
  }
}

const 问题 = { 原生弹窗: [], emoji: [], 字符箭头: [], 色值: [] };
const 色值统计 = new Map();
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const loc = `${rel}:${index + 1}`;
    if (file !== 反馈白名单 && /window\.(alert|confirm|prompt)\s*\(/.test(line)) {
      问题.原生弹窗.push(`${loc} ${line.trim()}`);
    }
    const emoji = line.match(/\p{Extended_Pictographic}/gu);
    if (emoji) 问题.emoji.push(`${loc} ${[...new Set(emoji)].join(" ")}`);
    if (/[▸▾↗]/.test(line)) 问题.字符箭头.push(`${loc} ${line.trim().slice(0, 90)}`);
  });
  const 色值命中 = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].length;
  if (色值命中) 色值统计.set(rel, 色值命中);
}

// 色值：白名单文件按冻结数量校验；其余文件必须为 0（界面色值走令牌）
let 色值增长 = 0;
for (const [rel, 数量] of 色值统计) {
  const 允许 = 色值白名单.get(rel);
  if (!允许) {
    问题.色值.push(`${rel} 有 ${数量} 处硬编码色值（不在数据/品牌白名单内）`);
    色值增长 += 数量;
  } else if (数量 > 允许.数量) {
    问题.色值.push(`${rel} 硬编码色值 ${数量} 处 > 冻结 ${允许.数量}（${允许.理由}）`);
    色值增长 += 数量 - 允许.数量;
  }
}
const 色值总数 = [...色值统计.values()].reduce((和, 值) => 和 + 值, 0);

let failed = 0;
const 报告 = (名称, 列表, 提示) => {
  if (!列表.length) {
    console.log(`  ✓ ${名称}`);
    return;
  }
  failed = 1;
  console.error(`  ✗ ${名称}：${列表.length} 处`);
  for (const item of 列表.slice(0, 12)) console.error(`    ${item}`);
  if (列表.length > 12) console.error(`    … 其余 ${列表.length - 12} 处`);
  console.error(`    ${提示}`);
};

console.log("▶ 界面一致性守护");
报告("无原生 alert/confirm/prompt（Feedback.jsx 兜底除外）", 问题.原生弹窗, "改用 Feedback.jsx 的 notify / askConfirm / askText。");
报告("功能代码无 emoji 图标", 问题.emoji, "改用 Icon.jsx 中的线性图标。");
报告("功能代码无 ▸/▾/↗ 字符箭头", 问题.字符箭头, "改用 chevronRight / chevronDown / externalLink 图标或 CSS 三角。");
报告("界面色值走令牌（白名单按数量冻结）", 问题.色值, "非数据/品牌用途的色值改用 var(--token)；确属色板的先登记白名单并说明理由。");
if (!问题.色值.length) {
  console.log(`    · JSX/JS 硬编码色值 ${色值总数} 处，全部属于数据可视化/品牌白名单`);
}
console.log(failed ? "\n界面一致性守护：存在失败" : "\n界面一致性守护：通过");
process.exitCode = failed ? 1 : 0;
