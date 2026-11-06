/**
 * Chat 视图历史窗口计算（2026-11-03 P1-1 修复）。
 *
 * 背景：窗口最初按「原始 JSONL 条目数」裁剪（slice(总数-limit)）。一个 7 分钟
 * 的多工具 Run 会写入几十条 toolResult/assistant 条目，足以把本轮 user 提问
 * 挤出窗口——实测切回会话后「上一轮提问消失、只剩回答」，顶部却提示“历史较长”。
 *
 * 现在的口径：按「消息条数」裁剪——从尾部向前数 user/assistant 消息，数满
 * limit 条即截止；toolResult 与内部提醒属于回合内部条目，不计入上限、随窗口
 * 成组保留。窗口起点若落在孤立 toolResult（其 assistant 已在窗口外），一并跳过，
 * 避免前端把工具结果挂到不存在的工具卡上。
 *
 * 纯函数，无文件/网络依赖，供 /api/sessions/:id?view=chat 与回归测试共用。
 */
export function computeChatWindowStart(list = [], end = 0, limit = 50) {
  const items = Array.isArray(list) ? list : [];
  const upper = Math.max(0, Math.min(items.length, Number.isFinite(end) ? end : items.length));
  const pageSize = Math.max(1, Number(limit) || 50);
  let messages = 0;
  let start = upper;
  for (let i = upper - 1; i >= 0; i -= 1) {
    const role = items[i]?.message?.role;
    if (role === "user" || role === "assistant") {
      messages += 1;
      if (messages > pageSize) { start = i + 1; break; }
    }
    start = i;
  }
  while (start < upper && items[start]?.message?.role === "toolResult") start += 1;
  return Math.max(0, start);
}
