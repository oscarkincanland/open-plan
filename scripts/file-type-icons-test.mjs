#!/usr/bin/env node
/**
 * P2 文件类型扁平图标契约测试：
 * 扩展名 → 语义类别/颜色令牌；文件树与预览页文件树共用同一组件；
 * 图标为实色底 + 白色字形（扁平），颜色全部来自 --file-* 令牌。
 *
 * 用法: node scripts/file-type-icons-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const { artifactTypeInfo } = await import(new URL("../client/src/产物类型.js", import.meta.url).href);

console.log("\n▶ 类型映射");

test("Word / Excel / PPT / PDF / 网页 / Markdown / 代码 的类别与色调", () => {
  assert.deepEqual([artifactTypeInfo("a.docx").kind, artifactTypeInfo("a.docx").tone], ["doc", "doc"]);
  assert.deepEqual([artifactTypeInfo("a.xlsx").kind, artifactTypeInfo("a.xlsx").tone], ["sheet", "sheet"]);
  assert.deepEqual([artifactTypeInfo("a.pptx").kind, artifactTypeInfo("a.pptx").tone], ["slides", "slides"]);
  assert.deepEqual([artifactTypeInfo("a.pdf").kind, artifactTypeInfo("a.pdf").tone], ["pdf", "pdf"]);
  assert.deepEqual([artifactTypeInfo("a.html").kind, artifactTypeInfo("a.html").tone], ["html", "html"]);
  assert.deepEqual([artifactTypeInfo("a.md").kind, artifactTypeInfo("a.md").tone], ["md", "md"]);
  assert.deepEqual([artifactTypeInfo("a.js").kind, artifactTypeInfo("a.js").tone], ["code", "code"]);
  assert.deepEqual([artifactTypeInfo("a.png").kind, artifactTypeInfo("a.png").tone], ["image", "image"]);
  assert.deepEqual([artifactTypeInfo("a.zip").kind, artifactTypeInfo("a.zip").tone], ["archive", "archive"]);
  assert.deepEqual([artifactTypeInfo("a.unknown").kind, artifactTypeInfo("a.unknown").tone], ["other", "other"]);
});

console.log("\n▶ 组件与覆盖范围");

test("扁平图标组件使用实色底 + 白色字形，不走线性 Icon", () => {
  const component = read("client/src/components/FileTypeIcon.jsx");
  assert.match(component, /fill="currentColor"/);
  assert.match(component, /var\(--file-icon-fg\)/);
  assert.doesNotMatch(component, /<Icon\b/);
  assert.match(component, /data-kind=\{info\.kind\}/);
});

test("左栏文件树与预览页文件树共用文件类型图标", () => {
  const sidebar = read("client/src/components/SessionSidebar.jsx");
  const canvasTree = read("client/src/components/FileTreeDrawer.jsx");
  assert.match(sidebar, /import 文件类型图标 from "\.\/FileTypeIcon\.jsx"/);
  assert.match(sidebar, /<文件类型图标 file=\{file\} size=\{size\} \/>/);
  assert.match(canvasTree, /import 文件类型图标 from "\.\/FileTypeIcon\.jsx"/);
  assert.match(canvasTree, /<文件类型图标 file=\{entry\} size=\{15\} \/>/);
  assert.doesNotMatch(canvasTree, /<Icon name=\{CODE_EXT\.test/);
});

test("产物卡与命令面板共用扁平文件图标", () => {
  const chat = read("client/src/components/ChatPanel.jsx");
  const palette = read("client/src/components/CommandPalette.jsx");
  assert.match(chat, /import 文件类型图标 from "\.\/FileTypeIcon\.jsx"/);
  assert.match(chat, /<文件类型图标 file=\{item\.path\} size=\{15\} \/>/);
  assert.match(palette, /import 文件类型图标 from "\.\/FileTypeIcon\.jsx"/);
  assert.match(palette, /<文件类型图标 file=\{it\.file\} size=\{14\} \/>/);
});

test("明暗主题都有 --file-* 颜色令牌", () => {
  const css = read("client/src/styles.css");
  assert.match(css, /--file-doc:\s*#3b77e0;/);
  assert.match(css, /--file-sheet:\s*#2e9e5b;/);
  assert.match(css, /--file-pdf:\s*#d9534f;/);
  assert.match(css, /--file-doc:\s*#2f6fed;/);
  assert.match(css, /\[data-kind="doc"\] \{ --file-tone: var\(--file-doc\); \}/);
  assert.match(css, /color-mix\(in srgb, var\(--file-tone, var\(--file-other\)\) 14%, transparent\)/);
});

console.log(failed ? "\n✗ 文件类型图标测试存在失败" : "\n✓ 文件类型图标测试全部通过");
process.exitCode = failed ? 1 : 0;
