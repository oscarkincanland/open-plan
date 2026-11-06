/**
 * 终稿边界纯函数（计划 2026-11-05-017）。
 *
 * 模型的 assistant message 可能只有 thinking、没有 text；Pi 会把它当作正常 stop，
 * 工作台必须识别出来并显式处理，不能把上一段进度文本当成最终答复。
 */
export function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("");
}

export function finalAnswerState(message) {
  const content = message?.content;
  const parts = Array.isArray(content) ? content : [];
  const text = assistantText(message).trim();
  const toolCalls = parts.filter((part) => part?.type === "toolCall");
  const thinking = parts.filter((part) => part?.type === "thinking")
    .map((part) => String(part.thinking || part.text || ""))
    .join("").trim();
  return {
    hasText: Boolean(text),
    hasToolCall: toolCalls.length > 0,
    hasThinking: Boolean(thinking),
    thinkingOnly: Boolean(thinking) && !text && toolCalls.length === 0,
    text,
  };
}
