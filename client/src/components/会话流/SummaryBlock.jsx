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

/**
 * 框外总结（落地文档 2026-10-31-001 §5.2 G3）：
 * 无框直接排文 —— 本轮总结 cap → 做了什么 → 结论（大字）→ 详细展开（summary 全文，含表格/代码块）。
 * 结论/做了什么由 splitCompletionSummary 拆分；summary 缺失时回退最终答复文本。
 */
export default function SummaryBlock({ conclusion = "", what = "", detail = "", durationMs = null, onOpenFile = null, artifacts = null }) {
  if (!conclusion && !detail) return null;
  return (
    <div className="sum-block">
      <span className="sum-cap">本轮总结{durationMs ? ` · 运行 ${Math.max(1, Math.round(durationMs / 1000)) < 60 ? `${Math.round(durationMs / 1000)} 秒` : ""}` : ""}</span>
      {what && <div className="sum-what"><b>做了什么</b>：{what}</div>}
      {conclusion && (
        <>
          <div className="sum-label"><Icon name="check" size={13} />结论</div>
          <div className="sum-conclusion">{conclusion}</div>
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
