/**
 * 封面布局纯函数（O-07）。
 *
 * 目标：把"封面标题多长、几行、用多大字号、上下留多少空"变成可测试的计算，
 * 而不是让模型每次自由发挥。三个函数互相独立，便于单测与复用。
 */

/** 估算文本宽度（单位：em）。CJK 记 1，拉丁字母/数字/标点按比例折算。 */
export function estimateTextWidthEm(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) width += 1;
    else if (ch === " ") width += 0.3;
    else if (/[0-9]/.test(ch)) width += 0.5;
    else if (/[A-Z]/.test(ch)) width += 0.65;
    else if (/[a-z]/.test(ch)) width += 0.52;
    else if (/[，。；：、！？（）《》【】]/.test(ch)) width += 1;
    else width += 0.5;
  }
  return width;
}

/**
 * 按语义边界拆标题行。
 * - 优先在 、，。；：/空格/连字符 处断行；
 * - 不产生单字孤行（末行只有 1 个字时，从上一行借一个字）。
 * @returns {string[]}
 */
export function splitTitleLines(title, { maxCharsPerLine = 12 } = {}) {
  const text = String(title ?? "").trim();
  if (!text) return [];
  const limit = Math.max(2, Math.floor(Number(maxCharsPerLine) || 12));
  if (text.length <= limit) return [text];

  const lines = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const mark of ["、", "，", "；", "：", "。", " ", "-", "—", "/", "（", "("]) {
      const idx = window.lastIndexOf(mark);
      if (idx >= Math.floor(limit * 0.5)) {
        cut = Math.max(cut, idx + 1);
      }
    }
    if (cut <= 0) cut = limit;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines.push(rest);

  // 末行单字：从上一行借一个字，避免"孤字成行"
  if (lines.length >= 2 && lines[lines.length - 1].length === 1) {
    const prev = lines[lines.length - 2];
    if (prev.length > 2) {
      lines[lines.length - 1] = prev.slice(-1) + lines[lines.length - 1];
      lines[lines.length - 2] = prev.slice(0, -1);
    }
  }
  return lines;
}

/**
 * 计算封面标题版式。
 * @param {object} input
 * @param {string} input.title 标题
 * @param {number} [input.maxWidthTwips] 可用宽度（twips），默认 A4 减去左右页边距
 * @param {number} [input.maxLines] 最多行数
 * @param {number} [input.maxPt] 起始字号
 * @param {number} [input.minPt] 最小字号
 * @returns {{fontSizePt:number, halfPoints:number, lines:string[], lineCount:number, totalHeightTwips:number}}
 */
export function calcTitleLayout({
  title,
  maxWidthTwips = 8306,
  maxLines = 4,
  maxPt = 40,
  minPt = 24,
} = {}) {
  const text = String(title ?? "").trim();
  const width = Math.max(1200, Number(maxWidthTwips) || 8306);
  const limitLines = Math.max(1, Number(maxLines) || 4);
  let start = Math.max(minPt, Math.min(72, Number(maxPt) || 40));
  const floor = Math.max(16, Math.min(start, Number(minPt) || 24));

  for (let pt = start; pt >= floor; pt -= 2) {
    const charsPerLine = Math.max(2, Math.floor(width / (pt * 20)));
    const lines = splitTitleLines(text, { maxCharsPerLine: charsPerLine });
    if (lines.length <= limitLines) {
      return {
        fontSizePt: pt,
        halfPoints: pt * 2,
        lines,
        lineCount: lines.length,
        // 行高按 1.4 倍估算，单位 twips
        totalHeightTwips: Math.round(lines.length * pt * 1.4 * 20),
      };
    }
  }

  // 最小字号仍放不下：按最小字号强制拆分，交由调用方提示"标题过长"
  const charsPerLine = Math.max(2, Math.floor(width / (floor * 20)));
  const lines = splitTitleLines(text, { maxCharsPerLine: charsPerLine });
  return {
    fontSizePt: floor,
    halfPoints: floor * 2,
    lines,
    lineCount: lines.length,
    totalHeightTwips: Math.round(lines.length * floor * 1.4 * 20),
    overflow: true,
  };
}

/**
 * 计算封面纵向留白。
 * @param {object} input
 * @param {number} input.contentHeightTwips 封面内容总高
 * @param {number} [input.pageHeightTwips] 页面高度
 * @param {number} [input.safetyTwips] 安全边距（防止打印裁切）
 * @returns {{top:number, gap:number, bottom:number, overflow:boolean, availableTwips:number}}
 */
export function calcCoverSpacing({
  contentHeightTwips,
  pageHeightTwips = 16838,
  safetyTwips = 1200,
} = {}) {
  const page = Math.max(2000, Number(pageHeightTwips) || 16838);
  const safety = Math.max(0, Number(safetyTwips) || 0);
  const content = Math.max(0, Number(contentHeightTwips) || 0);
  const available = page - safety;
  if (content >= available) {
    return { top: 0, gap: 0, bottom: 0, overflow: true, availableTwips: available };
  }
  const remaining = available - content;
  // 上 45% / 下 55% 的视觉重心，gap 取剩余量的 12%
  const top = Math.round(remaining * 0.45);
  const bottom = Math.max(0, remaining - top);
  const gap = Math.round(remaining * 0.12);
  return { top, gap, bottom, overflow: false, availableTwips: available };
}
