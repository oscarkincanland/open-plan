import React from "react";
import MarkdownBody from "../MarkdownBody.jsx";

/** 与 ChatPanel 的 SafeMarkdown 同一口径的超长内容保护。 */
const MAX_MARKDOWN_CHARS = 100000;

/**
 * 框外总结（会话流前端规范 v2.0 §5 + ADR 0014）：
 * 结论与详细展开合并为**一篇连续 Markdown**，无 cap、无「结论 / 详细展开」标签、无「做了什么」行。
 * 结语以模型终稿为准，complete_task.summary 仅在终稿缺失时兜底；空内容不渲染。
 * 轮次元信息（用时/步数/终态）已由 RunFoldBar 承担，这里不再重复。
 *
 * @param {string} body 连续正文（结论段 + 详细展开）
 */
export default function SummaryBlock({ body = "", onOpenFile = null, artifacts = null }) {
  const text = String(body || "").trim();
  if (!text) return null;
  return (
    <div className="sum-block">
      <div className="sum-body">
        {text.length <= MAX_MARKDOWN_CHARS
          ? <MarkdownBody onOpenFile={onOpenFile} artifacts={artifacts}>{text}</MarkdownBody>
          : <pre className="large-msg-raw">{text}</pre>}
      </div>
    </div>
  );
}
