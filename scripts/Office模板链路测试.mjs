#!/usr/bin/env node
/**
 * Office 模板链路测试（O-13 / O-14 / O-15 / O-16）。
 * 覆盖：14 个模板目录、13 条文体命中、显式引用优先、结构抽取、覆盖率、场景映射、只读性。
 *
 * 用法: node scripts/Office模板链路测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  templateCatalog, matchTemplate, templateForScene, sceneTemplateMap, TEMPLATE_DIR,
} from "../server/office规范/模板匹配.mjs";
import { parseTemplateStructure, assertCoverage } from "../server/office规范/模板结构.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

function hashTemplates() {
  const entries = fs.readdirSync(TEMPLATE_DIR).filter((name) => name.endsWith(".md")).sort();
  return entries.map((name) => {
    const buffer = fs.readFileSync(path.join(TEMPLATE_DIR, name));
    return `${name}:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
  }).join("\n");
}

const before = hashTemplates();
const catalog = templateCatalog();
const gongke = catalog.find((item) => item.file.startsWith("04_"));
const structure = parseTemplateStructure(fs.readFileSync(gongke.absPath, "utf8"));

console.log("\n▶ 模板目录与命中（15 例）");
test("模板目录 14 个 md", () => assert.equal(catalog.length, 14));
test("04 工可模板可定位", () => assert.ok(gongke && gongke.relPath.includes("templates/traffic-material/")));
const hits = [
  ["写一个工可材料", /04_/],
  ["做线位论证", /05_/],
  ["选址论证报告", /06_/],
  ["交通影响评价", /07_/],
  ["年度工作报告", /01_/],
  ["五年发展规划", /02_/],
  ["条文式规划文本", /03_/],
  ["汇报材料", /08_/],
  ["物流园区规划", /09_/],
  ["规划研究报告", /10_/],
  ["PPT汇报", /11_/],
  ["素材库整理", /12_/],
  ["通用规范", /00_总览/],
];
for (const [text, pattern] of hits) {
  test(`命中：${text}`, () => {
    const hit = matchTemplate({ text });
    assert.ok(hit, "应命中模板");
    assert.match(hit.file, pattern);
  });
}
test("格式数据汇总在目录中（无文体关键词）", () => assert.ok(catalog.some((item) => item.file.includes("格式数据汇总"))));

console.log("\n▶ 显式引用与反例（8 例）");
test("@模板 显式引用优先于关键词", () => {
  const hit = matchTemplate({ text: "写个方案，@模板[04_工程可行性研究报告模板.md]" });
  assert.equal(hit.source, "explicit");
  assert.match(hit.file, /04_/);
});
test("结构化模板引用优先", () => {
  const hit = matchTemplate({ text: "帮我写", references: [{ kind: "template", target: "08_汇报材料模板.md" }] });
  assert.equal(hit.source, "explicit");
  assert.match(hit.file, /08_/);
});
for (const text of ["写个方案", "做个网页", "写个通知", "随便聊聊", "分析一下数据", "翻译这段文字"]) {
  test(`反例不误命中：${text}`, () => assert.equal(matchTemplate({ text }), null));
}

console.log("\n▶ 结构抽取（8 例）");
test("工可十章", () => assert.equal(structure.chapters.length, 10));
test("必备图 11 张", () => assert.equal(structure.figures.length, 11));
test("必备表 8 张", () => assert.equal(structure.tables.length, 8));
test("必备小节 ≥ 30", () => assert.ok(structure.requiredSections.length >= 30));
test("可选小节 ≥ 3", () => assert.ok(structure.optionalSections.length >= 3));
test("常见错误 ≥ 16", () => assert.ok(structure.pitfalls.length >= 16));
test("格式规则 ≥ 10", () => assert.ok(structure.formatRules.length >= 10));
test("标题可解析", () => assert.match(structure.title, /工程可行性研究报告/));

console.log("\n▶ 覆盖率（5 例）");
const fullText = [...structure.chapters, ...structure.requiredSections, ...structure.figures, ...structure.tables].join(" ");
test("完整文本覆盖率 100%", () => {
  const coverage = assertCoverage(structure, fullText);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.coverage, 1);
});
test("漏一章 → 报错并定位", () => {
  const missingChapter = structure.chapters[0];
  const text = fullText.replace(missingChapter, "");
  const coverage = assertCoverage(structure, text);
  assert.equal(coverage.ok, false);
  assert.ok(coverage.missing.includes(missingChapter));
});
test("缺一张必备表 → 报错", () => {
  const table = structure.tables[0];
  const coverage = assertCoverage(structure, fullText.replace(table, ""));
  assert.ok(coverage.missing.includes(table));
});
test("可选章节缺失不报错", () => {
  const coverage = assertCoverage({ ...structure, requiredSections: [], chapters: [], figures: [], tables: [] }, "");
  assert.equal(coverage.ok, true);
  assert.equal(coverage.skipped, true);
});
test("空结构跳过覆盖率", () => {
  const coverage = assertCoverage({}, "");
  assert.equal(coverage.ok, true);
});

console.log("\n▶ 场景映射与只读性（5 例）");
test("7 个场景映射齐全", () => assert.equal(Object.keys(sceneTemplateMap()).length, 7));
test("非空映射目标存在", () => {
  const map = sceneTemplateMap();
  for (const [scene, relPath] of Object.entries(map)) {
    if (!relPath) continue;
    assert.ok(catalog.some((item) => item.relPath === relPath), `${scene} 映射目标不存在：${relPath}`);
  }
});
test("report → 08 汇报材料", () => assert.match(templateForScene("report").file, /08_/));
test("contract 无模板（null）", () => assert.equal(templateForScene("contract"), null));
test("模板文件哈希未变化（只读）", () => assert.equal(hashTemplates(), before));

console.log("\n▶ 08 汇报材料结构（5 例）");
const tpl08 = catalog.find((item) => item.file.startsWith("08_"));
const structure08 = parseTemplateStructure(fs.readFileSync(tpl08.absPath, "utf8"));
test("08 解析出四段式章节", () => assert.equal(structure08.chapters.length, 4));
test("08 必备/可选来自标注表", () => {
  assert.ok(structure08.requiredSections.length >= 8);
  assert.ok(structure08.optionalSections.length >= 1);
});
test("08 必备图表 3 表 2 图", () => {
  assert.equal(structure08.tables.length, 3);
  assert.equal(structure08.figures.length, 2);
});
test("08 覆盖率完整文本 100%", () => {
  const text = [...structure08.chapters, ...structure08.requiredSections, ...structure08.figures, ...structure08.tables].join(" ");
  const coverage = assertCoverage(structure08, text);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.coverage, 1);
});
test("08 漏一章 → 报错", () => {
  const missing = structure08.chapters[0];
  const key = missing.replace(/^[一二三四五六七八九十]+、\s*/, "");
  const text = [
    ...structure08.chapters.slice(1),
    ...structure08.requiredSections.filter((item) => !item.includes(key)),
    ...structure08.figures,
    ...structure08.tables,
  ].join(" ");
  const coverage = assertCoverage(structure08, text);
  assert.equal(coverage.ok, false);
});

process.exitCode = failed ? 1 : 0;
