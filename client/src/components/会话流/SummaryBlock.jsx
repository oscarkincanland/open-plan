import React from "react";
import Icon from "../Icon.jsx";
import MarkdownBody from "../MarkdownBody.jsx";

/** 与 ChatPanel 的 SafeMarkdown 同一口径的超长内容保护。 */
const MAX_MARKDOWN_CHARS = 100000;

function SafeSummary({ text, onOpenFile, artifacts }) {
  if (!text) return null;
  if (text.length <= MAX_MARKDOWN_CHARS) return <MarkdownBody onOpenFile={onOpenFile} artifacts={artifacts}>{text}</MarkdownBody>;
  return <pre className="large-msg-raw">{text}</pre>;
}

/** 块级标记（标题/列表/表格/引用/围栏代码）：结论是一段话，出现这些就整体降级为纯文本。 */
const BLOCK_MARKDOWN = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|\||>|```|~~~)/;

/**
 * 结论的行内 Markdown 子集渲染。
 *
 * 背景：结论此前是纯文本插值，模型终稿里的 `` `PowerShell` ``、`**重点**`、`[链接]`
 * 会原样显示标记符（用户反馈"格式奇怪"）。
 *
 * 约束（规范 §2「总结无框排文」+ §4 字号表）：
 *   - 只支持行内语法：行内代码、粗体、链接；不渲染块级元素，避免一段结论被拆成列表/表格；
 *   - 出现块级标记时整体降级为纯文本，保持版式不被破坏；
 *   - 全程用 React 元素拼接，不注入 HTML（无 XSS 面）。
 *
 * @param {string} text 结论原文
 * @returns {React.ReactNode}
 */
function renderInlineMarkdown(text) {
  const source = String(text || "");
  if (!source) return null;
  if (BLOCK_MARKDOWN.test(source)) return source;

  const nodes = [];
  // 先按行内代码切分：代码片段内部不再解析粗体/链接。
  const codeParts = source.split(/(`[^`]*`)/);
  codeParts.forEach((part, partIndex) => {
    if (!part) return;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      nodes.push(<code key={`c${partIndex}`}>{part.slice(1, -1)}</code>);
      return;
    }
    // 粗体：**text** 或 __text__
    const boldParts = part.split(/(\*\*[^*]+\*\*|__[^_]+__)/);
    boldParts.forEach((segment, boldIndex) => {
      if (!segment) return;
      const isBold = (/^\*\*[^*]+\*\*$/.test(segment) || /^__[^_]+__$/.test(segment));
      if (isBold) {
        nodes.push(<strong key={`b${partIndex}-${boldIndex}`}>{segment.slice(2, -2)}</strong>);
        return;
      }
      // 链接：[label](url) —— 只保留 http/https，其余按纯文本显示。
      const linkParts = segment.split(/(\[[^\]]+\]\([^)]+\))/);
      linkParts.forEach((chunk, linkIndex) => {
        if (!chunk) return;
        const match = chunk.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (match && /^https?:\/\//i.test(match[2])) {
          nodes.push(
            <a key={`a${partIndex}-${boldIndex}-${linkIndex}`} href={match[2]} target="_blank" rel="noreferrer noopener">{match[1]}</a>,
          );
          return;
        }
        nodes.push(<React.Fragment key={`t${partIndex}-${boldIndex}-${linkIndex}`}>{chunk}</React.Fragment>);
      });
    });
  });
  return nodes;
}

/**
 * 框外总结（规范 docs/规范/会话流前端规范.md §5）：
 * 无框直接排文 —— 本轮总结 cap → 做了什么 → 结论（正文色加粗）→ 详细展开（模型终稿全文，含表格/代码块）。
 * 结语以模型终稿为准，complete_task.summary 仅在终稿缺失时兜底；空内容不渲染。
 *
 * @param {number} [elapsedMs] 本轮用时；运行结束后由调用方传入，折进 cap 行（不再单占一行）。
 */
export default function SummaryBlock({ conclusion = "", what = "", detail = "", elapsedMs = 0, onOpenFile = null, artifacts = null }) {
  if (!conclusion && !detail) return null;
  const elapsedText = Number(elapsedMs) > 0 ? formatElapsed(elapsedMs) : "";
  return (
    <div className="sum-block">
      <span className="sum-cap">本轮总结{elapsedText ? ` · ${elapsedText}` : ""}</span>
      {what && <div className="sum-what"><b>做了什么</b>：{what}</div>}
      {conclusion && (
        <>
          <div className="sum-label"><Icon name="check" size={13} />结论</div>
          <div className="sum-conclusion">{renderInlineMarkdown(conclusion)}</div>
        </>
      )}
      {detail && (
        <>
          <div className="sum-label"><Icon name="list" size={13} />详细展开</div>
          <div className="sum-detail md-body"><SafeSummary text={detail} onOpenFile={onOpenFile} artifacts={artifacts} /></div>
        </>
      )}
    </div>
  );
}

/** 用时文案：45 秒 / 3 分 12 秒 / 1 小时 2 分（与运行轨迹.js formatDuration 同口径）。 */
function formatElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (total < 60) return `用时 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `用时 ${seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`}`;
  return `用时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
