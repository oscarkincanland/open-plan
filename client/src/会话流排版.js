/**
 * 会话流排版纯逻辑（可单测，无 React 依赖）。
 *
 * 背景：结论此前是纯文本插值，模型终稿里的 `` `PowerShell` ``、`**重点**`、`[链接]`
 * 会原样显示标记符（用户反馈"格式奇怪"）。这里提供行内 Markdown 子集的**解析**，
 * 由 components/会话流/SummaryBlock.jsx 负责映射成 React 元素。
 *
 * 约束（规范 docs/规范/会话流前端规范.md §2「总结无框排文」+ §4 字号表）：
 *   - 只支持行内语法：行内代码、粗体、http(s) 链接；
 *   - 出现块级标记时整体降级为纯文本，保持"结论是一段话"的版式；
 *   - 返回纯数据，不拼接 HTML（无 XSS 面）。
 */

/** 块级标记（标题/列表/表格/引用/围栏代码）。 */
const BLOCK_MARKDOWN = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|\||>|```|~~~)/;

/**
 * 解析结论的行内 Markdown 子集。
 *
 * @param {string} text 结论原文
 * @returns {{block: boolean, segments: Array<{type:"text"|"code"|"strong"|"link", text:string, href?:string}>}}
 */
export function parseInlineSegments(text) {
  const source = String(text || "");
  if (!source) return { block: false, segments: [] };
  if (BLOCK_MARKDOWN.test(source)) return { block: true, segments: [{ type: "text", text: source }] };

  const segments = [];
  const pushText = (value) => { if (value) segments.push({ type: "text", text: value }); };

  // 行内代码优先：代码片段内部不再解析粗体/链接。
  for (const part of source.split(/(`[^`]*`)/)) {
    if (!part) continue;
    if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
      segments.push({ type: "code", text: part.slice(1, -1) });
      continue;
    }
    // 粗体：**text** 或 __text__
    for (const chunk of part.split(/(\*\*[^*]+\*\*|__[^_]+__)/)) {
      if (!chunk) continue;
      if (/^(\*\*[^*]+\*\*|__[^_]+__)$/.test(chunk)) {
        segments.push({ type: "strong", text: chunk.slice(2, -2) });
        continue;
      }
      // 链接：[label](url)，只保留 http/https
      for (const piece of chunk.split(/(\[[^\]]+\]\([^)]+\))/)) {
        if (!piece) continue;
        const match = piece.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (match && /^https?:\/\//i.test(match[2])) {
          segments.push({ type: "link", text: match[1], href: match[2] });
          continue;
        }
        pushText(piece);
      }
    }
  }
  return { block: false, segments };
}

/** 用时文案（与 运行轨迹.js formatDuration 同口径，带"用时"前缀）。 */
export function formatElapsedText(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (total <= 0) return "";
  if (total < 60) return `用时 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `用时 ${seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`}`;
  return `用时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
