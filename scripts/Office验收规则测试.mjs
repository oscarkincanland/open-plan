#!/usr/bin/env node
/**
 * Office 规则闸门测试（O-15 / O-20 / O-21）。
 * 覆盖：9 条规则的红/绿 fixture、模板覆盖率、产物验证接入。
 *
 * 用法: node scripts/Office验收规则测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  runDocxQa, checkBlankPages, checkCoverOverflow, checkLineSpacing, checkTableMargins,
  checkImageRatio, checkCjkIndent, checkHeadingHierarchy, checkPlaceholders, checkFontFloor,
} from "../server/office规范/验收规则.mjs";
import { buildDocxFromBlocks } from "../server/文档引擎.mjs";
import { validateArtifactFile } from "../server/产物验证.mjs";

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (error) => { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); },
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-qa-"));
let seq = 0;
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

async function makeDocx(bodyXml) {
  seq += 1;
  const file = path.join(tmp, `fixture-${seq}.docx`);
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

const paragraph = (text, extra = "") => `<w:p>${extra}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const heading = (level, text) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

console.log("\n▶ 9 条规则（18 例）");
await test("空白页：连续 3 空段 → 报错", async () => {
  const file = await makeDocx("<w:p/><w:p/><w:p/>");
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file("word/document.xml").async("string");
  assert.ok(checkBlankPages(xml).some((i) => i.rule === "blank_page"));
});
await test("空白页：正常文档不报错", async () => {
  const file = await makeDocx(paragraph("正文") + paragraph("第二段"));
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file("word/document.xml").async("string");
  assert.equal(checkBlankPages(xml).length, 0);
});
await test("封面溢出：首段 48pt → 报错", async () => {
  const xml = `<w:p><w:r><w:rPr><w:sz w:val="96"/></w:rPr><w:t>标题</w:t></w:r></w:p>`;
  assert.ok(checkCoverOverflow(xml).some((i) => i.rule === "cover_overflow"));
});
await test("封面溢出：40pt 不报错", async () => {
  const xml = `<w:p><w:r><w:rPr><w:sz w:val="80"/></w:rPr><w:t>标题</w:t></w:r></w:p>`;
  assert.equal(checkCoverOverflow(xml).length, 0);
});
await test("行距：3 种以上取值 → 告警", () => {
  const xml = [312, 360, 400].map((line) => `<w:p><w:pPr><w:spacing w:line="${line}"/></w:pPr></w:p>`).join("");
  assert.ok(checkLineSpacing(xml).some((i) => i.rule === "line_spacing"));
});
await test("行距：统一 312 不告警", () => {
  const xml = [1, 2, 3].map(() => `<w:p><w:pPr><w:spacing w:line="312"/></w:pPr></w:p>`).join("");
  assert.equal(checkLineSpacing(xml).length, 0);
});
await test("表格边距：缺 tblCellMar → 报错", () => {
  const xml = "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>";
  assert.ok(checkTableMargins(xml).some((i) => i.rule === "table_margins"));
});
await test("表格边距：有 tblCellMar 不报错", () => {
  const xml = "<w:tbl><w:tblPr><w:tblCellMar><w:top w:w=\"80\"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>";
  assert.equal(checkTableMargins(xml).length, 0);
});
await test("图片比例：外框与图像不一致 → 报错", () => {
  const xml = '<w:p><w:r><w:drawing><wp:extent cx="1000" cy="1000"/><a:ext cx="1000" cy="500"/></w:drawing></w:r></w:p>';
  assert.ok(checkImageRatio(xml).some((i) => i.rule === "image_ratio"));
});
await test("图片比例：一致不报错", () => {
  const xml = '<w:p><w:r><w:drawing><wp:extent cx="1000" cy="500"/><a:ext cx="1000" cy="500"/></w:drawing></w:r></w:p>';
  assert.equal(checkImageRatio(xml).length, 0);
});
await test("中文缩进：3 段无缩进 → 告警", () => {
  const xml = [1, 2, 3].map((i) => paragraph(`这是第${i}段正文内容足够长`)).join("");
  assert.ok(checkCjkIndent(xml).some((i) => i.rule === "cjk_indent"));
});
await test("中文缩进：480 twips 不告警", () => {
  const xml = [1, 2, 3].map((i) => `<w:p><w:pPr><w:ind w:firstLine="480"/></w:pPr><w:r><w:t>这是第${i}段正文内容足够长</w:t></w:r></w:p>`).join("");
  assert.equal(checkCjkIndent(xml).length, 0);
});
await test("标题层级：H1 → H3 跳级 → 报错", () => {
  assert.ok(checkHeadingHierarchy(heading(1, "一") + heading(3, "三")).some((i) => i.rule === "heading_hierarchy"));
});
await test("标题层级：H1 → H2 不报错", () => {
  assert.equal(checkHeadingHierarchy(heading(1, "一") + heading(2, "二")).length, 0);
});
await test("占位符：{{title}} → 报错", () => assert.ok(checkPlaceholders("标题 {{title}}").some((i) => i.rule === "placeholder")));
await test("占位符：正常文本不报错", () => assert.equal(checkPlaceholders("正常正文").length, 0));
await test("字号下限：8pt → 报错", () => {
  const xml = '<w:p><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>正文</w:t></w:r></w:p>';
  assert.ok(checkFontFloor(xml).some((i) => i.rule === "font_floor"));
});
await test("字号下限：10.5pt 不报错", () => {
  const xml = '<w:p><w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t>正文</w:t></w:r></w:p>';
  assert.equal(checkFontFloor(xml).length, 0);
});

console.log("\n▶ 模板覆盖率（4 例）");
const structure = {
  chapters: ["第一章 概述"],
  requiredSections: ["1.1 项目概况"],
  optionalSections: [],
  figures: ["图1-1"],
  tables: ["表1-1"],
};
await test("覆盖完整 → 通过", async () => {
  const file = await makeDocx(paragraph("第一章 概述 1.1 项目概况 图1-1 表1-1"));
  const result = await runDocxQa(file, { structure });
  assert.equal(result.passed, true);
});
await test("漏章节 → 覆盖率报错", async () => {
  const file = await makeDocx(paragraph("第一章 概述 图1-1 表1-1"));
  const result = await runDocxQa(file, { structure });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.rule === "template_coverage"));
});
await test("缺图表 → 覆盖率报错", async () => {
  const file = await makeDocx(paragraph("第一章 概述 1.1 项目概况 表1-1"));
  const result = await runDocxQa(file, { structure });
  assert.ok(result.issues.some((i) => i.rule === "template_coverage" && i.message.includes("图1-1")));
});
await test("空结构 → 跳过覆盖率", async () => {
  const file = await makeDocx(paragraph("正文"));
  const result = await runDocxQa(file, { structure: {} });
  assert.equal(result.passed, true);
});

console.log("\n▶ 端到端与产物验证（4 例）");
await test("合规文档（场景+封面+目录+页码）→ 通过", async () => {
  const file = path.join(tmp, "green.docx");
  await buildDocxFromBlocks(file, [
    { type: "heading", text: "第一章 概述", level: 1 },
    { type: "paragraph", text: "这是正文段落，用于验证中文首行缩进与行距设置是否生效。" },
    { type: "table", rows: [["项目", "数值"], ["投资", "100"]] },
  ], { scene: "report", toc: true, pageNumbers: true, cover: { title: "测试文档标题", subtitle: "副标题" } });
  const result = await runDocxQa(file);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});
await test("产物验证接入 QA：失败产物标记 failed", async () => {
  const file = await makeDocx('<w:p><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>正文</w:t></w:r></w:p>');
  const qa = await runDocxQa(file);
  const artifact = validateArtifactFile(file, tmp, path.basename(file), { qa });
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.qa.passed, false);
});
await test("产物验证：无 QA 时保持旧行为", async () => {
  const file = await makeDocx(paragraph("正文"));
  const artifact = validateArtifactFile(file, tmp, path.basename(file));
  assert.equal(artifact.status, "passed");
});
await test("不存在的文件 → 明确失败", async () => {
  const result = await runDocxQa(path.join(tmp, "missing.docx"));
  assert.equal(result.passed, false);
  assert.equal(result.issues[0].rule, "file");
});

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
