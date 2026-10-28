#!/usr/bin/env node
/**
 * Office 版式规范测试（O-06 / O-07 / O-08 / O-09 / O-10）。
 * 覆盖：令牌完整性、封面布局三函数、7 套配方不变量、7 个场景与选择器。
 *
 * 用法: node scripts/Office排版规范测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import {
  FONT_SIZES, LINE_SPACING, INDENT, PAGE_MARGINS, PALETTES,
  resolveFontSize, resolveLineSpacing, resolvePageMargins, assertTokenIntegrity,
} from "../server/office规范/设计令牌.mjs";
import { estimateTextWidthEm, splitTitleLines, calcTitleLayout, calcCoverSpacing } from "../server/office规范/封面布局.mjs";
import { COVER_RECIPES, selectCoverRecipe, getCoverRecipe, assertRecipeInvariants } from "../server/office规范/封面配方.mjs";
import { loadScenes, sceneIds, getScene, sceneLabels, selectScene, defaultScene } from "../server/office规范/场景选择.mjs";

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

console.log("\n▶ 版式令牌（9 例）");
test("13 档中文字号", () => assert.equal(Object.keys(FONT_SIZES).length, 13));
test("令牌完整性自检无问题", () => assert.deepEqual(assertTokenIntegrity(), []));
test("三号 = 16pt / 32 半磅", () => assert.deepEqual(resolveFontSize("三号"), { pt: 16, halfPoints: 32, name: "三号" }));
test("14pt 字符串可解析", () => assert.equal(resolveFontSize("14pt").halfPoints, 28));
test("非法字号回退 12pt", () => assert.equal(resolveFontSize("巨大").pt, 12));
test("行距四档", () => assert.equal(Object.keys(LINE_SPACING).length, 4));
test("固定 28pt 使用 exact", () => assert.equal(resolveLineSpacing("fixed28").rule, "exact"));
test("CJK 缩进 480/420", () => assert.deepEqual([INDENT.simsun, INDENT.yahei], [480, 420]));
test("页边距三套 + 12 套配色", () => {
  assert.equal(Object.keys(PAGE_MARGINS).length, 3);
  assert.equal(PALETTES.length, 12);
});

console.log("\n▶ 封面布局（15 例）");
test("长标题按标点断行", () => {
  const lines = splitTitleLines("浙江省综合交通运输发展五年规划，重点任务与实施路径研究", { maxCharsPerLine: 12 });
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((line) => line.length <= 13));
});
test("不产生单字孤行", () => {
  const lines = splitTitleLines("一二三四五六七八九十一二三", { maxCharsPerLine: 7 });
  assert.ok(lines[lines.length - 1].length !== 1);
});
test("中英混排可断行", () => {
  const lines = splitTitleLines("Open Plan 交通规划工作台使用说明", { maxCharsPerLine: 10 });
  assert.ok(lines.length >= 2);
});
test("空标题返回空数组", () => assert.deepEqual(splitTitleLines(""), []));
test("40 字标题字号在 24–40pt 且不超过 4 行", () => {
  const layout = calcTitleLayout({ title: "关于加快推进全省综合交通运输体系建设实现高质量发展的实施意见" });
  assert.ok(layout.fontSizePt >= 24 && layout.fontSizePt <= 40);
  assert.ok(layout.lineCount <= 4);
  assert.ok(layout.totalHeightTwips > 0);
});
test("超长标题标记 overflow", () => {
  const layout = calcTitleLayout({ title: "一".repeat(120), maxLines: 3 });
  assert.equal(layout.overflow, true);
});
test("宽度估算 CJK 大于拉丁", () => assert.ok(estimateTextWidthEm("中文") > estimateTextWidthEm("ab")));
test("封面留白不溢出", () => {
  const spacing = calcCoverSpacing({ contentHeightTwips: 5000 });
  assert.equal(spacing.overflow, false);
  assert.ok(spacing.top > 0 && spacing.bottom > 0);
});
test("内容超过可用高度 → overflow", () => {
  assert.equal(calcCoverSpacing({ contentHeightTwips: 20000 }).overflow, true);
});
test("7 套配方", () => assert.equal(COVER_RECIPES.length, 7));
for (const recipe of COVER_RECIPES) {
  test(`配方 ${recipe.id} 三不变量合规`, () => assert.deepEqual(assertRecipeInvariants(recipe), []));
}
test("official-doc → R1", () => assert.equal(selectCoverRecipe("official-doc").id, "R1"));
test("report → R2", () => assert.equal(selectCoverRecipe("report").id, "R2"));
test("未知类型 → R2 兜底", () => assert.equal(selectCoverRecipe("unknown-type").id, "R2"));
test("getCoverRecipe 大小写不敏感", () => assert.equal(getCoverRecipe("r3").id, "R3"));

console.log("\n▶ 场景与选择器（20 例）");
test("7 个场景", () => assert.equal(sceneIds().length, 7));
for (const id of sceneIds()) {
  test(`场景 ${id} 字段齐全`, () => {
    const scene = getScene(id);
    assert.ok(scene.label && scene.page && scene.font && scene.spacing && scene.cover);
    assert.ok(scene.structure.length > 0 && scene.keywords.length > 0 && scene.forbidden.length > 0);
  });
}
const sceneCases = [
  ["写一篇学术论文", "academic"],
  ["写一份调研报告", "report"],
  ["起草一份合同", "contract"],
  ["发一份通知", "official-doc"],
  ["更新一下简历", "resume"],
  ["出一套试卷", "exam"],
  ["写一段口播文案", "copywriting"],
];
for (const [text, expected] of sceneCases) {
  test(`选择器：${text} → ${expected}`, () => assert.equal(selectScene(text).scene, expected));
}
test("默认场景为 report", () => assert.equal(defaultScene(), "report"));
test("无命中回退默认且置信度 0", () => {
  const result = selectScene("你好");
  assert.equal(result.scene, "report");
  assert.equal(result.confidence, 0);
});
test("否定语境不误判：不是论文，是报告", () => {
  const result = selectScene("不是论文，是报告");
  assert.equal(result.scene, "report");
  assert.ok(result.negated.includes("论文"));
});
test("场景标签 7 项", () => assert.equal(sceneLabels().length, 7));
test("场景结构非空", () => assert.ok(getScene("official-doc").structure.includes("正文")));
test("未知场景返回 null", () => assert.equal(getScene("nope"), null));

console.log("\n▶ 边界（9 例）");
test("空文本选择器不抛错", () => assert.equal(selectScene("").scene, "report"));
test("超长文本可处理", () => assert.ok(selectScene("报告".repeat(500)).scene));
test("纯英文回退默认", () => assert.equal(selectScene("hello world").scene, "report"));
test("纯数字回退默认", () => assert.equal(selectScene("12345").scene, "report"));
test("行距非法值回退 normal", () => assert.equal(resolveLineSpacing("nope").line, 312));
test("页边距自定义对象", () => {
  const margins = resolvePageMargins({ top: 1000, bottom: 1000, left: 1000, right: 1000 });
  assert.equal(margins.top, 1000);
});
test("场景 JSON 可重复加载", () => assert.equal(loadScenes().scenes.report.label, "研究报告"));
test("字号数字直接可用", () => assert.equal(resolveFontSize(15).halfPoints, 30));
test("配方背景/标题色合法", () => {
  for (const recipe of COVER_RECIPES) {
    assert.match(recipe.background, /^#[0-9a-f]{6}$/i);
    assert.match(recipe.titleColor, /^#[0-9a-f]{6}$/i);
  }
});

process.exitCode = failed ? 1 : 0;
