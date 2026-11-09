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
