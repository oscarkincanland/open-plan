/**
 * 封面配方 R1–R7（O-08）。
 *
 * 设计意图：封面不允许自由布局，只能从 7 套已验证配方中选择。
 * 每套配方都带三个不可协商项（margin=0 / 行高 exact / 无边框），
 * 由 assertRecipeInvariants 统一守护，避免"看起来能打开、打印却溢页"。
 */
import { PAGE_SIZE, resolvePalette } from "./设计令牌.mjs";

const BASE_RULE = Object.freeze({
  marginZero: true,
  wrapperHeightTwips: PAGE_SIZE.height,
  rowRule: "exact",
  borders: "none",
});

function recipe({ id, name, docTypes, palette, titleColor, subtitleColor, accentColor, titleAlign = "center", accentStyle = "none", note = "" }) {
  return Object.freeze({
    id,
    name,
    docTypes: Object.freeze(docTypes),
    palette: palette.id,
    background: palette.background,
    titleColor: titleColor || palette.primary,
    subtitleColor: subtitleColor || palette.text,
    accentColor: accentColor || palette.accent,
    titleAlign,
    accentStyle,
    note,
    rule: BASE_RULE,
  });
}

export const COVER_RECIPES = Object.freeze([
  recipe({
    id: "R1",
    name: "政务红头",
    docTypes: ["official-doc", "gov", "notice"],
    palette: resolvePalette("warm-red"),
    titleColor: "#8C1C13",
    accentStyle: "top-rule",
    note: "红头文件/通知：标题居中、上方细红线、无背景色块",
  }),
  recipe({
    id: "R2",
    name: "规划报告",
    docTypes: ["report", "plan", "research"],
    palette: resolvePalette("traffic"),
    accentStyle: "left-band",
    titleAlign: "left",
    note: "规划/研究报告：左侧色带 + 左下角信息块",
  }),
  recipe({
    id: "R3",
    name: "学术论文",
    docTypes: ["academic", "thesis", "paper"],
    palette: resolvePalette("academic"),
    accentStyle: "none",
    note: "论文/开题：纯白底、居中、无装饰",
  }),
  recipe({
    id: "R4",
    name: "合同协议",
    docTypes: ["contract", "agreement", "nda"],
    palette: resolvePalette("ink"),
    accentStyle: "double-rule",
    note: "合同：标题上下双细线、正文纯黑",
  }),
  recipe({
    id: "R5",
    name: "简历单页",
    docTypes: ["resume", "cv"],
    palette: resolvePalette("slate"),
    accentStyle: "top-bar",
    titleAlign: "left",
    note: "简历：顶部窄色条、左对齐、单页填充",
  }),
  recipe({
    id: "R6",
    name: "试卷答题",
    docTypes: ["exam", "quiz"],
    palette: resolvePalette("ink"),
    accentStyle: "none",
    note: "试卷：极简、无装饰、密封线由正文区处理",
  }),
  recipe({
    id: "R7",
    name: "文案口播",
    docTypes: ["copywriting", "script", "speech"],
    palette: resolvePalette("plum"),
    accentStyle: "bottom-block",
    titleAlign: "left",
    note: "文案/口播：大标题 + 底部色块信息区",
  }),
]);

const DOC_TYPE_TO_RECIPE = Object.freeze({
  "official-doc": "R1",
  gov: "R1",
  notice: "R1",
  report: "R2",
  plan: "R2",
  research: "R2",
  academic: "R3",
  thesis: "R3",
  paper: "R3",
  contract: "R4",
  agreement: "R4",
  nda: "R4",
  resume: "R5",
  cv: "R5",
  exam: "R6",
  quiz: "R6",
  copywriting: "R7",
  script: "R7",
  speech: "R7",
});

/** 按文档类型选择配方；未知类型回落到报告配方。 */
export function selectCoverRecipe(docType, industry = "") {
  const key = String(docType || "").trim().toLowerCase();
  const id = DOC_TYPE_TO_RECIPE[key] || "R2";
  const found = COVER_RECIPES.find((item) => item.id === id) || COVER_RECIPES[1];
  return { ...found, industry: String(industry || ""), requestedType: key || null };
}

export function getCoverRecipe(id) {
  return COVER_RECIPES.find((item) => item.id === String(id || "").toUpperCase()) || null;
}

/** 三不变量校验：返回违规项（空数组=合规）。 */
export function assertRecipeInvariants(recipeLike) {
  const recipe = recipeLike || {};
  const rule = recipe.rule || {};
  const problems = [];
  if (rule.marginZero !== true) problems.push("封面必须 margin=0");
  if (Number(rule.wrapperHeightTwips) !== PAGE_SIZE.height) problems.push(`封面外层行高必须为 ${PAGE_SIZE.height} twips`);
  if (rule.rowRule !== "exact") problems.push('封面行高必须使用 rule="exact"');
  if (rule.borders !== "none") problems.push("封面外层表格必须无边框");  if (!/^#[0-9a-f]{6}$/i.test(String(recipe.background || ""))) problems.push("封面背景色非法");
  if (!/^#[0-9a-f]{6}$/i.test(String(recipe.titleColor || ""))) problems.push("封面标题色非法");
  return problems;
}
