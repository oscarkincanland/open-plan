/**
 * 清洗正文里误输出的工具调用标签。
 *
 * 模型偶尔会把 `<ask_user .../>`、`<tool .../>` 等工具意图写进 text，
 * 这些内容不是给用户看的答复；按 Markdown 原样渲染会变成“推理变成果”。
 * 这里只做保守的标签剥离，不尝试解析成真实工具调用。
 */
export function stripToolMarkup(text) {
  return String(text || "")
    .replace(/<ask_user\b[\s\S]*?\/>/gi, "")
    .replace(/<tool(?:_call)?\b[\s\S]*?\/>/gi, "")
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<antml:function_calls>[\s\S]*?<\/antml:function_calls>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasToolMarkup(text) {
  return /<ask_user\b|<tool(?:_call)?\b|<function_calls>|<antml:function_calls>/i.test(String(text || ""));
}
