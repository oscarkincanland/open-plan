#!/usr/bin/env node
/**
 * 产物文件类型图标测试。
 *
 * 问题（2026-11-02）：右栏「工作产物」面板对所有文件都画同一个通用 file 图标，
 * .docx / .xlsx / .pptx / .png 在产物列表里看不出区别；而文件树与对话里的产物卡
 * 用的是 文件类型图标.jsx 的彩色分型图标（实色底 + 字形），两处不一致。
 *
 * 本测试守护：
 *   1. 扩展名 → 语义类别（产物类型.js）的映射正确；
 *   2. 每个语义类别都有对应字形（没有字形就会静默回退成 "other"）；
 *   3. 产物面板与改动面板确实使用 文件类型图标，而不是通用 Icon。
 *
 * 第 3 条是**结构断言**（读源码），它验证"调用了正确的组件"，
 * 不验证渲染出来的像素效果；渲染效果由人工在界面上核对。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { artifactTypeInfo, artifactTypeLabel, EXT_KINDS } from "../client/src/产物类型.js";

const ROOT = path.resolve(import.meta.dirname, "..");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("docx 归到文档类别（用户反馈的原问题）", () => {
  const info = artifactTypeInfo("规划报告.docx");
  assert.equal(info.kind, "doc");
  assert.equal(info.label, "文档");
  assert.equal(info.tone, "doc");
  assert.equal(artifactTypeLabel("规划报告.docx"), "文档 · DOCX");
});

test("常见扩展名的语义类别正确", () => {
  const cases = [
    ["a.xlsx", "sheet"], ["a.xls", "sheet"], ["a.csv", "sheet"],
    ["a.pptx", "slides"], ["a.ppt", "slides"],
    ["a.pdf", "pdf"], ["a.md", "md"], ["a.html", "html"],
    ["a.png", "image"], ["a.jpg", "image"], ["a.svg", "image"],
    ["a.shp", "map"], ["a.geojson", "map"], ["a.zip", "archive"],
    ["a.txt", "text"], ["a.js", "code"], ["a.py", "code"],
    ["a.unknown", "other"], ["无扩展名", "other"],
  ];
  for (const [file, kind] of cases) {
    assert.equal(artifactTypeInfo(file).kind, kind, `${file} 应归到 ${kind}`);
  }
});

test("doc 与 docx 共用文档类别（Word 老格式也要有图标）", () => {
  assert.equal(artifactTypeInfo("a.doc").kind, "doc");
  assert.equal(EXT_KINDS.doc.icon, EXT_KINDS.docx.icon);
});

test("每个语义类别都有对应字形（否则会静默回退成 other）", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "components", "文件类型图标.jsx"), "utf8");
  const glyphBlock = source.slice(source.indexOf("const GLYPHS = {"), source.indexOf("export default function"));
  const glyphs = new Set([...glyphBlock.matchAll(/^\s{2}([a-zA-Z]+):\s*Icon[A-Za-z0-9_]+,/gm)].map((m) => m[1]));
  assert.ok(glyphs.size >= 10, `字形表解析异常，只读到 ${glyphs.size} 个`);
  // 按每个扩展名还原出实际用到的 kind，逐一核对字形存在。
  const usedKinds = new Set();
  for (const ext of Object.keys(EXT_KINDS)) usedKinds.add(artifactTypeInfo(`a.${ext}`).kind);
  for (const kind of usedKinds) {
    assert.ok(glyphs.has(kind), `缺少 kind="${kind}" 的字形，文件类型图标.jsx 会回退成 other`);
  }
});

test("产物面板使用 文件类型图标，而不是通用 file 图标", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "components", "工作产物面板.jsx"), "utf8");
  assert.match(source, /import 文件类型图标 from "\.\/文件类型图标\.jsx"/, "产物面板应引入 文件类型图标");
  const rowBlock = source.slice(source.indexOf("const renderArtifactRow"), source.indexOf("if (segment === \"links\")"));
  assert.match(rowBlock, /<文件类型图标 file=\{artifact\.path\}/, "产物行应按文件类型渲染图标");
  assert.doesNotMatch(rowBlock, /<Icon name="file"/, "产物行不应再用通用 file 图标");
});

test("改动面板同样使用 文件类型图标", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "components", "FileChangesPanel.jsx"), "utf8");
  assert.match(source, /import 文件类型图标 from "\.\/文件类型图标\.jsx"/, "改动面板应引入 文件类型图标");
  assert.match(source, /<文件类型图标 file=\{change\.relativePath\}/, "改动行应按文件类型渲染图标");
});

if (failed) {
  console.error("\n产物文件类型图标测试：存在失败项");
  process.exit(1);
}
console.log("\n产物文件类型图标测试：全部通过");
