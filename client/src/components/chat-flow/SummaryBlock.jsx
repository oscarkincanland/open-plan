import React from "react";
import Icon from "../Icon.jsx";
import MarkdownBody from "../MarkdownBody.jsx";
import { parseInlineSegments, formatElapsedText } from "../../chat-flow-layout.js";

/** 与 ChatPanel 的 SafeMarkdown 同一口径的超长内容保护。 */
const MAX_MARKDOWN_CHARS = 100000;

function SafeSummary({ text, onOpenFile, artifacts }) {
  if (!text) return null;
  if (text.length <= MAX_MARKDOWN_CHARS) return <MarkdownBody onOpenFile={onOpenFile} artifacts={artifacts}>{text}</MarkdownBody>;
  return <pre className="large-msg-raw">{text}</pre>;
}

/** 把 parseInlineSegments 的结果映射成 React 元素（解析逻辑见 会话流排版.js，纯函数可单测）。 */
function renderInlineMarkdown(text) {
  const { segments } = parseInlineSegments(text);
  return segments.map((segment, index) => {
    if (segment.type === "code") return <code key={index}>{segment.text}</code>;
    if (segment.type === "strong") return <strong key={index}>{segment.text}</strong>;
    if (segment.type === "link") {
      return <a key={index} href={segment.href} target="_blank" rel="noreferrer noopener">{segment.text}</a>;
    }
    return <React.Fragment key={index}>{segment.text}</React.Fragment>;
  });
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
  const elapsedText = formatElapsedText(elapsedMs);
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
