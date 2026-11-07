/**
 * 计算一次展示帧应揭示的字符数。
 * 常规流式保持可感知的逐字节奏；当供应商只在结束时给出整段文本时，
 * 自动追赶积压，避免动画反而拖慢任务完成。
 */
export function 计算展示字符数({ remaining = 0, elapsedMs = 16, reducedMotion = false } = {}) {
  const total = Math.max(0, Number(remaining) || 0);
  if (!total) return 0;
  if (reducedMotion) return total;
  const normalPerSecond = 90;
  const catchUpPerSecond = Math.ceil(total / 0.24);
  const rate = Math.max(normalPerSecond, catchUpPerSecond);
  return Math.min(total, Math.max(1, Math.ceil(rate * Math.max(1, elapsedMs) / 1000)));
}

/**
 * 从一条历史消息中提取真正显示在回复气泡里的文本。
 * Pi 历史可能把正文放在 blocks，也可能只保留旧版 text 字段；两者不能叠加，
 * 否则 run_finished 用权威全文补齐时会把同一结论再次追加一遍。
 */
export function 提取消息展示文本(message) {
  const blockText = (Array.isArray(message?.blocks) ? message.blocks : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text || ""))
    .join("");
  return blockText || String(message?.text || "");
}

/**
 * 把流式文本块追加到 blocks 序列尾部。
 *
 * 尾部若已是 text 块就并入该块，否则新开一块。
 */
export function 追加文本块(blocks = [], text = "") {
  const arr = [...(blocks || [])];
  const value = String(text || "");
  if (!value) return arr;
  const last = arr[arr.length - 1];
  if (last && last.type === "text") {
    last.text = (last.text || "") + value;
    return arr;
  }
  // 纯空白增量不新开文本块：否则时间流会多出一块看不见的 .textblock，
  // 在工具卡与下一条之间撑出空白（2026-11-07 实测）。
  if (!value.trim()) return arr;
  arr.push({ type: "text", text: value });
  return arr;
}

/**
 * 把尚未落定的流式文本并回**上一段**文本块（跨越中间的工具卡）。
 *
 * 模型的一次连续输出会被工具调用切成多段（text → tool → text）。
 * 若第二段因尾部已是 tool 块而新开 text 块，同一句话会在界面上裂成几截
 * （末段常常只剩一两个字）。工具边界让路时先把未落定的文本并回上一段，
 * 句子保持完整，工具卡仍留在文本之间。
 */
export function 并回上一段文本块(blocks = [], text = "") {
  const arr = [...(blocks || [])];
  const value = String(text || "");
  if (!value) return arr;
  for (let index = arr.length - 1; index >= 0; index -= 1) {
    const block = arr[index];
    if (block?.type !== "text") continue;
    arr[index] = { ...block, text: (block.text || "") + value };
    return arr;
  }
  // 没有可并回的文本块且增量只有空白：不新开空块。
  if (!value.trim()) return arr;
  arr.push({ type: "text", text: value });
  return arr;
}

/**
 * 追加一段流式文本：尾部是 text 块就并入；尾部不是 text 块（如工具卡）时，
 * 若「工具卡之前那段 text」与新文本仍属同一句话，就并回那一段，
 * 否则新开一段。
 *
 * 这是「同一句话被工具卡切成两截」的修复点：SSE 事件流里 tool_start
 * 可能早于最后几个 text token 到达，工具卡插进句子中间；
 * 随后来到的 token 必须并回原句，而不是在工具卡后另起一段。
 */
export function 追加流式文本块(blocks = [], text = "") {
  const arr = [...(blocks || [])];
  const value = String(text || "");
  if (!value) return arr;
  const last = arr[arr.length - 1];
  if (last && last.type === "text") {
    last.text = (last.text || "") + value;
    return arr;
  }
  // 尾部不是 text 块且增量只有空白：属于轮次之间的换行/缩进，不构成可见正文。
  // 新开一块会渲染成空的 .textblock（有 padding 却无内容），表现为工具卡后的空白。
  if (!value.trim()) return arr;
  // 尾部不是 text 块：向前找最近的一段 text，判断新文本是否它的同句延续。
  for (let index = arr.length - 1; index >= 0; index -= 1) {
    const block = arr[index];
    if (block?.type !== "text") continue;
    if (属于同一句话(block.text || "", value)) {
      arr[index] = { ...block, text: (block.text || "") + value };
      return arr;
    }
    break;
  }
  arr.push({ type: "text", text: value });
  return arr;
}

/**
 * 计算一段权威全文相对「已入队文本」的缺口。
 *
 * `queued` 是本轮已入队的原始文本累积（= 已揭示 + 待揭示）。
 * 权威全文 `text` 与它粒度相同（同一轮的完整文本），
 * 因此缺口必须相对 queued 定位——用已揭示长度去裁剪会落到错误偏移，
 * 在多块场景下造成内容丢失或重复。
 *
 * 返回 mode：
 *   - none     两者一致，无需追加
 *   - suffix   权威全文以 queued 为前缀，缺失段为 missing
 *   - replay   尚未入队任何文本，允许从权威全文清空重播
 *   - conflict 权威全文不包含 queued（多回合累积），保留已显示内容不动
 */
export function 计算权威文本缺口(text = "", queued = "") {
  const full = String(text || "");
  const base = String(queued || "");
  if (!full) return { mode: "none", missing: "" };
  if (!base) return { mode: "replay", missing: full };
  if (full === base) return { mode: "none", missing: "" };
  if (full.startsWith(base)) return { mode: "suffix", missing: full.slice(base.length) };
  if (base.startsWith(full)) return { mode: "none", missing: "" };
  const at = full.indexOf(base);
  if (at >= 0) return { mode: "suffix", missing: full.slice(at + base.length) };
  return { mode: "conflict", missing: "" };
}

/**
 * 判断一段待揭示文本是否属于**前一段** text 块的同一句话。
 *
 * 判据：前一段以未闭合的句子结束（不以句号等终止标点收尾），
 * 待揭示文本是它的自然延续。典型形态是「先说了一半，工具卡插进来，
 * 剩下几个字补完」——服务端 content 里这段文字是完整的，但 SSE 事件流里
 * tool_start 可能早于最后几个 text token 到达，工具卡就插进了句子中间。
 *
 * 若前一段已以终止标点收尾，说明那是一句完整的话，
 * 待揭示文本属于模型新的一段输出，不应并入。
 */
export function 属于同一句话(previous = "", pending = "") {
  const prev = String(previous || "").trimEnd();
  const next = String(pending || "");
  if (!prev || !next) return false;
  // 前一段已完整收尾（新段落），不是同一句话。
  if (/[。！？!?…；;：:，,、）)\]】」》]$/u.test(prev)) return false;
  return true;
}

/**
 * 按事件顺序构建一条 assistant 消息的 blocks 序列。
 *
 * 复现并修掉「同一句话被工具卡切成两截」：
 * SSE 事件流里 tool_start 可能早于最后几个 text token 到达，
 * 工具卡就插进了句子中间；随后到达的 token 因为尾部已是工具卡，
 * 只能新开一段，同一句话在界面上就裂成几截（末段常只剩一两个字）。
 *
 * 本函数按组件的真实时序建模：
 *   - 文本事件逐个到达（与组件里 token 逐帧揭示一致）；
 *   - 非文本事件插队时，把已到达的文本落定在工具卡之前；
 *   - 工具卡之后到达的文本，用追加流式文本块判断是并回原句还是另起一段。
 *
 * @param {Array} blocks 现有 blocks 序列
 * @param {Array} events 事件序列，每项为 { kind: "text"|"block", text?, block? }
 * @returns {Array} 新的 blocks 序列
 */
export function 构建流式块序列(blocks = [], events = []) {
  let current = [...(blocks || [])];
  let pending = "";
  for (const event of events || []) {
    if (!event || event.kind === "text") {
      // 文本逐帧到达：先攒进 pending，再按帧揭示（与组件的 reveal 一致）。
      pending += String(event?.text || "");
      continue;
    }
    // 非文本块插队：先把缓冲里的文本落定在工具卡之前（组件的 flushTextReveal）。
    if (pending) {
      current = 追加流式文本块(current, pending);
      pending = "";
    }
    if (event.block) current = [...current, event.block];
  }
  if (pending) current = 追加流式文本块(current, pending);
  return current;
}
