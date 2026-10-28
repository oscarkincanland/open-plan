#!/usr/bin/env node
/**
 * 界面一致性守护（DESIGN §5.8 / §12）：
 *   1) 除 Feedback.jsx 的兜底实现外，禁止 window.alert / confirm / prompt；
 *   2) 功能代码不得用 emoji 充当图标；
 *   3) 功能代码不得用 ▸ / ▾ / ↗ 字符箭头（折叠区优先 chevron 图标或 CSS 三角）。
 *
 * 运行：node scripts/界面一致性守护测试.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "client", "src");
const 反馈白名单 = path.join(SRC, "components", "Feedback.jsx");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(jsx|js)$/.test(entry.name)) yield p;
  }
}

const 问题 = { 原生弹窗: [], emoji: [], 字符箭头: [] };
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const loc = `${rel}:${index + 1}`;
    if (file !== 反馈白名单 && /window\.(alert|confirm|prompt)\s*\(/.test(line)) {
      问题.原生弹窗.push(`${loc} ${line.trim()}`);
    }
    const emoji = line.match(/\p{Extended_Pictographic}/gu);
    if (emoji) 问题.emoji.push(`${loc} ${[...new Set(emoji)].join(" ")}`);
    if (/[▸▾↗]/.test(line)) 问题.字符箭头.push(`${loc} ${line.trim().slice(0, 90)}`);
  });
}

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
console.log(failed ? "\n界面一致性守护：存在失败" : "\n界面一致性守护：通过");
process.exitCode = failed ? 1 : 0;
