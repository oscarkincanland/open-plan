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

/**
 * 清除模型偶尔写进终稿的"预填前缀"：重复的 `Final summary.` / `Summary:` /
 * `最终总结：`。真实样本里出现过 `Final summary.Final summary.Final summary.`
 * 连续重复，会直接顶在结论区第一行。
 *
 * 只处理行首、且只认这几个明确的预填标记，避免误删用户要求正文以"总结："开头的内容。
 */
const ANSWER_PREFILL_PATTERNS = [
  /^\s*final\s+summary\s*[.。:：]\s*/i,
  /^\s*summary\s*[.。:：]\s*/i,
  /^\s*最终总结\s*[.。:：]\s*/,
];

export function stripAnswerPrefill(text) {
  let out = String(text || "");
  // 连续重复的前缀逐轮剥离（上限 10 轮，防御异常输入死循环）。
  for (let guard = 0; guard < 10; guard += 1) {
    const before = out;
    for (const pattern of ANSWER_PREFILL_PATTERNS) out = out.replace(pattern, "");
    out = out.replace(/^\s*\n+/, "");
    if (out === before) break;
  }
  return out.trim();
}
