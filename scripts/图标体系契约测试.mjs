#!/usr/bin/env node
/**
 * 图标体系契约测试（2026-11-04 / 计划 015）。
 *
 * 守护：
 *   1) 业务图标全部映射到 Tabler，且映射目标唯一（同一语义不重复占用字形）；
 *   2) 所有 `<Icon name="...">` 字面量都能解析；
 *   3) 除白名单（Logo/供应商/图例/浏览器光标/上下文圆环）外不再有裸 <svg>；
 *   4) Word 预览翻页使用 Tabler 箭头，不再出现 ‹ ›；
 *   5) 依赖已声明。
 *
 * 用法: node scripts/图标体系契约测试.mjs
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
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

const iconSource = read("client/src/components/Icon.jsx");
const iconBlock = iconSource.slice(iconSource.indexOf("const ICONS = {"), iconSource.indexOf("// 兼容旧调用名"));
const entries = [...iconBlock.matchAll(/^\s{2}([A-Za-z0-9_]+): (Icon[A-Za-z0-9_]+),/gm)].map((match) => [match[1], match[2]]);
const map = new Map(entries);
const targets = entries.map(([, target]) => target);

console.log("\n▶ Tabler 映射");

test("83 个旧名全部有 Tabler 映射（penTool 合并到 edit）", () => {
  assert.equal(map.size, 82, `映射条目应为 82（83 个旧名 - penTool 合并），实际 ${map.size}`);
  assert.match(iconSource, /const ICON_ALIASES = Object\.freeze\(\{ penTool: "edit" \}\)/, "penTool 应作为兼容别名指向 edit");
  assert.match(iconSource, /export const ICON_NAMES = Object\.keys\(ICONS\);/, "应导出 ICON_NAMES");
});

test("映射目标唯一，不重复占用同一 Tabler 字形", () => {
  assert.equal(new Set(targets).size, targets.length, `重复映射：${targets.filter((x, i) => targets.indexOf(x) !== i).join(", ")}`);
});

test("依赖已声明且使用 named import", () => {
  const pkg = JSON.parse(read("client/package.json"));
  assert.ok(pkg.dependencies?.["@tabler/icons-react"], "client/package.json 应声明 @tabler/icons-react");
  assert.match(iconSource, /from "@tabler\/icons-react"/, "Icon.jsx 应从 Tabler 命名导入");
});

console.log("\n▶ 调用点");

test("所有字面量 Icon name 都能解析", () => {
  const roots = ["client/src/components", "client/src"];
  const used = new Set();
  for (const dir of roots) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/<Icon\s+name="([A-Za-z0-9_-]+)"/g)) used.add(match[1]);
    }
  }
  const missing = [...used].filter((name) => !map.has(name) && name !== "penTool");
  assert.deepEqual(missing, [], `未映射的 Icon name：${missing.join(", ")}`);
});

test("penTool 调用点已统一为 edit", () => {
  const used = [];
  for (const file of walk(path.join(ROOT, "client/src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (/<Icon\s+name="penTool"/.test(text)) used.push(path.relative(ROOT, file));
  }
  assert.deepEqual(used, [], `仍在使用 penTool：${used.join(", ")}`);
});

console.log("\n▶ 白名单与 Word 预览");

test("除白名单外的组件不再有裸 svg", () => {
  // CadViewer 用 SVG 画 DXF 几何（线段/折线），不是功能图标，按白名单放行。
  const allow = new Set(["Logo.jsx", "Icon.jsx", "LayerPanel.jsx", "内置浏览器面板.jsx", "ChatPanel.jsx", "CadViewer.jsx"]);
  const violations = [];
  for (const file of walk(path.join(ROOT, "client/src/components"))) {
    if (allow.has(path.basename(file))) continue;
    if (/<svg\b/.test(fs.readFileSync(file, "utf8"))) violations.push(path.relative(ROOT, file));
  }
  assert.deepEqual(violations, [], `仍有裸 svg：${violations.join(", ")}`);
});

test("Word 预览翻页改用 Tabler 箭头", () => {
  const docx = read("client/src/components/DocxViewer.jsx");
  assert.match(docx, /<Icon name="chevronLeft" size=\{14\} \/>/, "上一页应使用 Tabler 左箭头");
  assert.match(docx, /<Icon name="chevronRight" size=\{14\} \/>/, "下一页应使用 Tabler 右箭头");
  assert.doesNotMatch(docx, /title="上一页">‹/, "不应再出现文字 ‹");
  assert.doesNotMatch(docx, /title="下一页">›/, "不应再出现文字 ›");
});

test("文件类型图标保留彩色底、使用 Tabler 字形", () => {
  const fileIcons = read("client/src/components/文件类型图标.jsx");
  assert.match(fileIcons, /from "@tabler\/icons-react"/);
  assert.match(fileIcons, /className=\{`file-type-icon/);
  assert.doesNotMatch(fileIcons, /<svg\b/, "文件类型图标不应再有裸 svg");
});

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(jsx|js)$/.test(entry.name)) yield full;
  }
}

console.log(failed ? "\n图标体系契约测试：存在失败\n" : "\n图标体系契约测试：全部通过\n");
process.exit(failed ? 1 : 0);
