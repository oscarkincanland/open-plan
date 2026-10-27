/**
 * 模板结构抽取与覆盖率验收（O-14 / O-15）。
 *
 * 把 Markdown 模板里的「必备章节 / 可选章节 / 必备图表 / 格式规则 / 常见错误」
 * 解析成结构化对象，供写作与验收共用；模板正文本身只读。
 */

function splitLines(markdown) {
  return String(markdown || "").split(/\r?\n/);
}

/** 取二级章节正文（从匹配行到下一个 `## `）。 */
function level2Section(lines, startRe) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** 取三级章节正文（从匹配行到下一个 `### ` 或 `## `）。 */
function level3Section(lines, startRe) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

function unique(list) {
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

function parseMarkedItems(sectionText, mark) {
  const out = [];
  for (const line of splitLines(sectionText)) {
    const match = line.match(/^\s*[-*]\s*([✅🔧])\s*(.+)$/u);
    if (!match || match[1] !== mark) continue;
    out.push(cleanTitle(match[2]));
  }
  return unique(out);
}

function parseTableFirstColumn(sectionText) {
  const rows = [];
  for (const line of splitLines(sectionText)) {
    if (!/^\s*\|/.test(line)) continue;
    if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (!cells.length) continue;
    if (/^(错误|序号|章节|图件|表格|项目)$/.test(cells[0])) continue;
    rows.push(cells[0]);
  }
  return unique(rows);
}

function parseFigureNumbers(sectionText) {
  const out = [];
  for (const match of String(sectionText || "").matchAll(/图\s?(\d+)\s?-\s?(\d+)/g)) {
    out.push(`图${match[1]}-${match[2]}`);
  }
  return unique(out);
}

function parseTableNumbers(sectionText) {
  const out = [];
  for (const match of String(sectionText || "").matchAll(/表\s?(\d+)\s?-\s?(\d+)/g)) {
    out.push(`表${match[1]}-${match[2]}`);
  }
  return unique(out);
}

/**
 * 解析模板结构。
 * @param {string} markdown 模板正文
 * @returns {{title:string, requiredSections:string[], optionalSections:string[], chapters:string[], figures:string[], tables:string[], formatRules:string[], pitfalls:string[]}}
 */
export function parseTemplateStructure(markdown) {
  const text = String(markdown || "");
  const lines = splitLines(text);
  const title = (text.match(/^#\s+(.+)$/m)?.[1] || "").trim();

  const structureSection = level2Section(lines, /^##\s*二、\s*结构骨架/);
  const chapters = unique(
    [...structureSection.matchAll(/^###\s+(第[一二三四五六七八九十百]+章[^\n]*)$/gm)]
      .map((match) => cleanTitle(match[1])),
  );
  const requiredSections = parseMarkedItems(structureSection, "✅");
  const optionalSections = parseMarkedItems(structureSection, "🔧");

  const figureSection = level3Section(lines, /^###\s*5\.2\s*必备图件清单/);
  const tableSection = level3Section(lines, /^###\s*5\.3\s*必备表格清单/);
  const figures = parseFigureNumbers(figureSection);
  const tables = parseTableNumbers(tableSection);

  const formatSection = level2Section(lines, /^##\s*三、\s*格式规范/);
  const formatRules = unique(
    splitLines(formatSection)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line && /(字号|行距|缩进|页边距|磅|pt|twips)/i.test(line)),
  ).slice(0, 40);

  const pitfallSection = level2Section(lines, /^##\s*七、\s*常见错误/);
  const pitfalls = parseTableFirstColumn(pitfallSection).slice(0, 40);

  return { title, chapters, requiredSections, optionalSections, figures, tables, formatRules, pitfalls };
}

function normalize(text) {
  return String(text || "").replace(/[\s\u3000]+/g, "");
}

/**
 * 模板覆盖率验收。
 * @param {object} structure parseTemplateStructure 的结果
 * @param {string} producedText 产物文本（view text/outline 的输出）
 * @returns {{ok:boolean, total:number, covered:number, coverage:number, missing:string[]}}
 */
export function assertCoverage(structure, producedText) {
  const produced = normalize(producedText);
  const required = Array.isArray(structure?.requiredSections) ? structure.requiredSections : [];
  const chapters = Array.isArray(structure?.chapters) ? structure.chapters : [];
  const figures = Array.isArray(structure?.figures) ? structure.figures : [];
  const tables = Array.isArray(structure?.tables) ? structure.tables : [];

  // 模板没有结构标记时跳过覆盖率（避免误报）
  if (!required.length && !chapters.length && !figures.length && !tables.length) {
    return { ok: true, total: 0, covered: 0, coverage: 1, missing: [], skipped: true };
  }

  const missing = [];
  let total = 0;
  let covered = 0;

  for (const chapter of chapters) {
    total += 1;
    const number = chapter.match(/第[一二三四五六七八九十百]+章/)?.[0] || "";
    const name = cleanTitle(chapter.replace(/^第[一二三四五六七八九十百]+章\s*/, ""));
    if ((number && produced.includes(number)) || (name && produced.includes(normalize(name)))) covered += 1;
    else missing.push(chapter);
  }

  for (const section of required) {
    total += 1;
    const number = section.match(/^\d+(?:\.\d+)+/)?.[0] || "";
    const name = cleanTitle(section.replace(/^\d+(?:\.\d+)+\s*/, ""));
    if ((number && produced.includes(number)) || (name && produced.includes(normalize(name)))) covered += 1;
    else missing.push(section);
  }

  for (const figure of figures) {
    total += 1;
    if (produced.includes(figure)) covered += 1;
    else missing.push(figure);
  }

  for (const table of tables) {
    total += 1;
    if (produced.includes(table)) covered += 1;
    else missing.push(table);
  }

  const coverage = total ? Number((covered / total).toFixed(4)) : 1;
  return { ok: missing.length === 0, total, covered, coverage, missing };
}
