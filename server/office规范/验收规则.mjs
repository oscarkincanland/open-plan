/**
 * Office 规则闸门（O-20）与模板覆盖率接入（O-15）。
 *
 * 只做确定性检查：读 docx 的 OOXML，按 9 条规则判定，不依赖模型、不联网。
 * 返回结构固定，便于 CI 与产物验证消费。
 */
import fs from "node:fs";
import JSZip from "jszip";
import { assertCoverage } from "./模板结构.mjs";

export const QA_RULES = Object.freeze([
  { id: "blank_page", label: "空白页", severity: "error" },
  { id: "cover_overflow", label: "封面溢出", severity: "error" },
  { id: "line_spacing", label: "行距一致", severity: "warn" },
  { id: "table_margins", label: "表格边距", severity: "error" },
  { id: "image_ratio", label: "图片比例", severity: "error" },
  { id: "cjk_indent", label: "中文首行缩进", severity: "warn" },
  { id: "heading_hierarchy", label: "标题层级", severity: "error" },
  { id: "placeholder", label: "占位符残留", severity: "error" },
  { id: "font_floor", label: "字号下限", severity: "error" },
  { id: "template_coverage", label: "模板覆盖率", severity: "error" },
]);

export function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

export function extractText(xml) {
  const out = [];
  for (const match of String(xml || "").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    out.push(decodeXml(match[1]));
  }
  return out.join("");
}

function paragraphs(xml) {
  return String(xml || "").match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
}

function paragraphText(p) {
  return extractText(p);
}

function isHeading(p) {
  return /<w:pStyle\b[^>]*w:val="(?:Heading|heading)[1-9]"/.test(p) || /<w:outlineLvl\b/.test(p);
}

function hasNumbering(p) {
  return /<w:numPr\b/.test(p);
}

/** 1. 空白页：连续 3 个以上空段，或连续两个分页符。 */
export function checkBlankPages(xml) {
  const issues = [];
  const list = paragraphs(xml);
  let emptyRun = 0;
  let maxEmptyRun = 0;
  for (const p of list) {
    const text = paragraphText(p).replace(/\s/g, "");
    if (!text) emptyRun += 1;
    else emptyRun = 0;
    if (emptyRun > maxEmptyRun) maxEmptyRun = emptyRun;
  }
  if (maxEmptyRun >= 3) {
    issues.push({ rule: "blank_page", severity: "error", message: `存在连续 ${maxEmptyRun} 个空段落，可能产生空白页` });
  }
  let previousBreak = false;
  for (const p of list) {
    const hasBreak = /<w:br\b[^>]*w:type="page"/.test(p);
    if (hasBreak && previousBreak) {
      issues.push({ rule: "blank_page", severity: "error", message: "存在相邻分页符，可能产生空白页" });
      break;
    }
    previousBreak = hasBreak;
  }
  return issues;
}

/** 2. 封面溢出：前 8 段内字号 > 40pt，或首个分节前空段 > 12。 */
export function checkCoverOverflow(xml) {
  const issues = [];
  const list = paragraphs(xml).slice(0, 8);
  for (const p of list) {
    for (const match of p.matchAll(/<w:sz\b[^>]*w:val="(\d+)"/g)) {
      if (Number(match[1]) > 80) {
        issues.push({ rule: "cover_overflow", severity: "error", message: `封面字号 ${Number(match[1]) / 2}pt 超过 40pt 上限` });
        return issues;
      }
    }
  }
  const beforeSection = String(xml).split("<w:sectPr")[0];
  const empty = paragraphs(beforeSection).filter((p) => !paragraphText(p).replace(/\s/g, "")).length;
  if (empty > 12) {
    issues.push({ rule: "cover_overflow", severity: "error", message: `封面区域存在 ${empty} 个空段，疑似溢出到第二页` });
  }
  return issues;
}

/** 3. 行距一致：正文行距取值不超过 2 种（标题/正文各一种）。 */
export function checkLineSpacing(xml) {
  const values = new Set();
  for (const match of String(xml).matchAll(/<w:spacing\b[^>]*w:line="(\d+)"/g)) {
    const value = Number(match[1]);
    if (value > 0 && value !== 240) values.add(value);
  }
  if (values.size > 2) {
    return [{ rule: "line_spacing", severity: "warn", message: `行距取值过多（${[...values].join(", ")}），建议统一` }];
  }
  return [];
}

/** 4. 表格边距：每个表格必须有 tblCellMar。 */
export function checkTableMargins(xml) {
  const tables = String(xml).match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) || [];
  let missing = 0;
  for (const table of tables) {
    if (!/<w:tblCellMar\b/.test(table)) missing += 1;
  }
  if (missing > 0) {
    return [{ rule: "table_margins", severity: "error", message: `${missing}/${tables.length} 个表格缺少单元格边距（tblCellMar）` }];
  }
  return [];
}

/** 5. 图片比例：wp:extent 与 a:ext 的宽高比偏差超过 2%。 */
export function checkImageRatio(xml) {
  const issues = [];
  const source = String(xml);
  const extents = [...source.matchAll(/<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/g)];
  for (const match of extents) {
    const cx = Number(match[1]);
    const cy = Number(match[2]);
    if (!cx || !cy) continue;
    const tail = source.slice(match.index, match.index + 4000);
    const inner = tail.match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (!inner) continue;
    const ratioOuter = cx / cy;
    const ratioInner = Number(inner[1]) / Number(inner[2]);
    if (Math.abs(ratioOuter - ratioInner) / ratioInner > 0.02) {
      issues.push({ rule: "image_ratio", severity: "error", message: "图片外框与图像比例不一致，可能被拉伸" });
      break;
    }
  }
  return issues;
}

/** 6. 中文首行缩进：正文段落（非标题、非列表）应设置 firstLine >= 420 twips。 */
export function checkCjkIndent(xml) {
  const list = paragraphs(xml);
  let body = 0;
  let missing = 0;
  for (const p of list) {
    const text = paragraphText(p);
    if (text.replace(/\s/g, "").length < 10) continue;
    if (isHeading(p) || hasNumbering(p)) continue;
    if (/<w:tc\b/.test(p)) continue;
    body += 1;
    const indent = p.match(/<w:ind\b[^>]*w:firstLine="(\d+)"/);
    const chars = p.match(/<w:ind\b[^>]*w:firstLineChars="(\d+)"/);
    const ok = (indent && Number(indent[1]) >= 420) || (chars && Number(chars[1]) >= 200);
    if (!ok) missing += 1;
  }
  if (body >= 3 && missing > 0) {
    return [{ rule: "cjk_indent", severity: "warn", message: `${missing}/${body} 个正文段落缺少中文首行缩进` }];
  }
  return [];
}

/** 7. 标题层级：不允许跳级（H1 → H3）。 */
export function checkHeadingHierarchy(xml) {
  const levels = [];
  for (const match of String(xml).matchAll(/<w:pStyle\b[^>]*w:val="Heading(\d)"/g)) levels.push(Number(match[1]));
  for (const match of String(xml).matchAll(/<w:outlineLvl\b[^>]*w:val="(\d)"/g)) levels.push(Number(match[1]) + 1);
  let previous = 0;
  for (const level of levels) {
    if (previous && level > previous + 1) {
      return [{ rule: "heading_hierarchy", severity: "error", message: `标题层级跳级：H${previous} → H${level}` }];
    }
    previous = level;
  }
  return [];
}

/** 8. 占位符残留。 */
export function checkPlaceholders(text) {
  const issues = [];
  const source = String(text || "");
  for (const token of ["{{", "}}", "TODO", "【待补】", "待补充"]) {
    if (source.includes(token)) issues.push({ rule: "placeholder", severity: "error", message: `产物含未替换占位符：${token}` });
  }
  return issues;
}

/** 9. 字号下限：正文不小于 10.5pt（21 半磅）。 */
export function checkFontFloor(xml) {
  const small = [];
  for (const match of String(xml).matchAll(/<w:sz\b[^>]*w:val="(\d+)"/g)) {
    const value = Number(match[1]);
    if (value > 0 && value < 21) small.push(value / 2);
  }
  if (small.length) {
    return [{ rule: "font_floor", severity: "error", message: `存在小于 10.5pt 的字号：${[...new Set(small)].join(", ")}pt` }];
  }
  return [];
}

/**
 * 运行 docx 规则闸门。
 * @param {string} file docx 绝对路径
 * @param {{structure?:object}} [options] 模板结构（提供时追加覆盖率检查）
 */
export async function runDocxQa(file, { structure = null, coverageMode = "balanced" } = {}) {
  const checks = [];
  const issues = [];
  if (!fs.existsSync(file)) {
    return { passed: false, issues: [{ rule: "file", severity: "error", message: "产物文件不存在" }], checks, text: "" };
  }
  let zip;
  let xml = "";
  try {
    zip = await JSZip.loadAsync(await fs.promises.readFile(file));
    const entry = zip.file("word/document.xml");
    if (!entry) {
      return { passed: false, issues: [{ rule: "file", severity: "error", message: "缺少 word/document.xml（非有效 docx）" }], checks, text: "" };
    }
    xml = await entry.async("string");
    checks.push("document.xml 可读");
  } catch (error) {
    return { passed: false, issues: [{ rule: "file", severity: "error", message: `docx 解析失败：${String(error?.message || error).slice(0, 200)}` }], checks, text: "" };
  }

  const text = extractText(xml);
  checks.push(`正文 ${text.length} 字`);

  const groups = [
    checkBlankPages(xml),
    checkCoverOverflow(xml),
    checkLineSpacing(xml),
    checkTableMargins(xml),
    checkImageRatio(xml),
    checkCjkIndent(xml),
    checkHeadingHierarchy(xml),
    checkPlaceholders(text),
    checkFontFloor(xml),
  ];
  for (const group of groups) issues.push(...group);

  if (structure) {
    const coverage = assertCoverage(structure, text);
    checks.push(`模板覆盖率 ${(coverage.coverage * 100).toFixed(0)}%（${coverage.covered}/${coverage.total}）`);
    const sectionSeverity = coverage.inferred || coverageMode === "advisory" ? "warn" : "error";
    const assetSeverity = coverage.inferred || coverageMode !== "strict" ? "warn" : "error";
    for (const item of (coverage.missingSections || []).slice(0, 20)) {
      issues.push({ rule: "template_coverage", severity: sectionSeverity, message: `模板必备章节缺失：${item}` });
    }
    for (const item of (coverage.missingAssets || []).slice(0, 20)) {
      issues.push({ rule: "template_coverage", severity: assetSeverity, message: `模板必备图表缺失：${item}` });
    }
  }

  const hasError = issues.some((item) => item.severity === "error");
  return { passed: !hasError, issues, checks, text };
}
