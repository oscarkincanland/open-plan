/**
 * Markdown 输入规范化（2026-11-09）。
 *
 * 背景：模型偶尔把标题写成 `##结论`（井号后没有空格）。CommonMark/GFM 规定 ATX 标题
 * 的井号后必须跟空格，否则整行按普通段落渲染——用户看到的就是字面量 `##结论`，
 * 整篇文档的层级随之塌掉（实测事故见 2026-11-09 的「画布能力」一轮）。
 *
 * 这里只做「行首、非围栏代码块内」的最小纠偏，正文其余内容一字不动；
 * 不改写有序列表、不补编号，避免把模型表达改坏。
 */

/** 围栏代码块标记（``` 或 ~~~，允许缩进）。 */
const FENCE = /^\s*(```|~~~)/;

/** 已自带编号的标题：`一、` `1.` `（一）` `第X` / `一）` 等，视为作者自己管编号。 */
const NUMBERED_HEADING = /^(?:[一二三四五六七八九十百]+[、.．)）]|[0-9]+[、.．)）]|[（(][一二三四五六七八九十百0-9]+[）)]|第[一二三四五六七八九十百0-9]+)/;

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1→一、11→十一、23→二十三（只覆盖到 99，足够结论分节）。 */
export function toChineseNumber(value) {
  const number = Math.max(0, Math.trunc(Number(value) || 0));
  if (number < 10) return CN_DIGITS[number];
  const tens = Math.floor(number / 10);
  const ones = number % 10;
  const tensText = tens === 1 ? "十" : `${CN_DIGITS[tens]}十`;
  return ones ? `${tensText}${CN_DIGITS[ones]}` : tensText;
}

/**
 * 给二级 / 三级标题自动编号（2026-11-09，2026-11-19 增补 h3）。
 *
 * 背景：用户多次要求结论出现「一、二、三、四」的分节编号，但纯靠提示词不可靠
 * （模型经常自由发挥）。这里在渲染层做确定性兜底：
 *   - 只处理行首 `## ` / `### ` 标题，跳过围栏代码块；
 *   - h2 少于 2 个时整篇不动（单节不需要编号），其下 h3 也不编号；
 *   - 任一头（h2 或 h3）已自带编号（`一、`/`1.`/`1.1`/`（一）`/`第X`）就整体不动，避免叠加；
 *   - h2 编号按出现顺序生成，形如 `## 一、结论`；
 *   - h3 编号跟随所属 h2，形如 `### 1.1 现状`；没有父 h2 的 h3 不编号；
 *   - h2 与 h3 在同一遍扫描里完成，避免先给 h2 加「一、」后被自身判成"已编号"。
 */
export function numberTopLevelSections(source, { prefix = "" } = {}) {
  const text = String(source ?? "");
  if (!text.includes("## ")) return text;
  const lines = text.split("\n");
  const h2Indexes = [];
  const h3Indexes = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^###\s+/.test(line)) h3Indexes.push(index);
    // 只认二级标题：`## 标题`（且不是 `###`）。
    else if (/^##\s+/.test(line)) h2Indexes.push(index);
  }
  if (h2Indexes.length < 2) return text;
  const alreadyNumbered = [...h2Indexes, ...h3Indexes].some((index) => {
    const title = lines[index].replace(/^#{2,3}\s+/, "").trim();
    return NUMBERED_HEADING.test(title);
  });
  if (alreadyNumbered) return text;
  const h2Set = new Set(h2Indexes);
  const h3Set = new Set(h3Indexes);
  let sectionOrder = 0;
  let subOrder = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (h2Set.has(index)) {
      sectionOrder += 1;
      subOrder = 0;
      const title = lines[index].replace(/^##\s+/, "").trim();
      if (title) lines[index] = `## ${prefix}${toChineseNumber(sectionOrder)}、${title}`;
    } else if (h3Set.has(index)) {
      // 没有父 h2 的 h3 不编号（sectionOrder 仍为 0）。
      if (!sectionOrder) continue;
      subOrder += 1;
      const title = lines[index].replace(/^###\s+/, "").trim();
      if (title) lines[index] = `### ${sectionOrder}.${subOrder} ${title}`;
    }
  }
  return lines.join("\n");
}

/**
 * 把行首 `#{1,6}` 后紧跟非空格字符的写法补一个空格。
 * 例：`##结论` → `## 结论`；`###依据` → `### 依据`；`#######x` 不动（超过 6 级不算标题）。
 */
export function normalizeAtxHeadings(source) {
  const text = String(source ?? "");
  if (!text.includes("#")) return text;
  const lines = text.split("\n");
  let inFence = false;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const next = line.replace(/^(#{1,6})(?=[^\s#])/, "$1 ");
    if (next !== line) {
      lines[index] = next;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}
