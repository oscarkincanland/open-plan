/**
 * Event Protocol V2：统一事件信封、通道代际与生命周期/增量分层。
 *
 * 背景：Runtime/会话重建会创建新的 event channel，其序号从 1 重新开始。
 * 前端若继续携带旧代际游标，新通道的前 N 个事件会在 SSE 出口被整段过滤。
 * 因此每个通道带有独立 streamId，前端按 thread + streamId 保存游标。
 *
 * 同时：token/thinking/tool_output 属于高频增量，历史窗口溢出时它们应
 * 先被淘汰；工具边界、错误、终态等生命周期事件必须保留，保证断线回放
 * 能重建完整执行轨迹。
 *
 * 事件清单本身来自 ./事件注册表.mjs（唯一事实来源），本文件只保留协议逻辑。
 */
import crypto from "node:crypto";
import { DELTA_EVENT_TYPES, LIFECYCLE_EVENT_TYPES } from "./事件注册表.mjs";

export const PROTOCOL_VERSION = 2;

export { DELTA_EVENT_TYPES, LIFECYCLE_EVENT_TYPES };

/** 通道历史默认上限（生命周期为主，增量可淘汰）。 */
export const CHANNEL_HISTORY_LIMIT = 4000;

export function createStreamId() {
  return `stream_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * 计算 SSE 回放起始游标。
 *
 * - 客户端携带的 streamId 与服务端通道代际不一致（Runtime/会话重建）→ 清零；
 * - 客户端未携带代际但游标超过当前通道序号（旧代际遗留）→ 清零；
 * - 否则取请求游标。
 */
export function resolveReplayCursor({ clientStreamId = "", channelStreamId = "", lastId = 0, channelSeq = 0 } = {}) {
  const normalizedLastId = Number(lastId) > 0 ? Number(lastId) : 0;
  const generationChanged = Boolean(clientStreamId) && Boolean(channelStreamId) && clientStreamId !== channelStreamId;
  const unknownGeneration = !clientStreamId && normalizedLastId > Number(channelSeq || 0);
  if (generationChanged || unknownGeneration) return 0;
  return normalizedLastId;
}

/**
 * Qoder P2-5：通道历史淘汰遥测——按类型累计被语义化淘汰挤出历史窗口的事件量。
 * 进程内只读计数，不落盘、不参与任何业务判定，不改变淘汰语义与回放行为。
 * 投递/落盘量在 事件存储.mjs 的 typeStats（appendEvent 记账），本表只记「淘汰」这一半。
 */
const channelEvictionStats = new Map();

/** 按淘汰量倒序返回各事件类型的淘汰统计（诊断接口用）。 */
export function channelEvictionStatsSnapshot({ limit = 60 } = {}) {
  const size = Number.isFinite(limit) && limit > 0 ? limit : 60;
  return [...channelEvictionStats.entries()]
    .map(([type, evicted]) => ({ type, evicted }))
    .sort((a, b) => b.evicted - a.evicted || a.type.localeCompare(b.type))
    .slice(0, size);
}

/**
 * 写入通道历史并对超限做语义化淘汰：优先丢弃最早的高频增量，
 * 只有全为生命周期事件时才退回 FIFO。生命周期事件（工具边界、错误、
 * assistant_final、run_finished 等）因此不会被 token 洪水挤出窗口。
 */
export function pushChannelEvent(channel, event) {
  channel.history.push(event);
  const limit = Number(channel.historyLimit) > 0 ? Number(channel.historyLimit) : CHANNEL_HISTORY_LIMIT;
  while (channel.history.length > limit) {
    const deltaIndex = channel.history.findIndex((item) => DELTA_EVENT_TYPES.has(item?.type));
    const removed = deltaIndex >= 0 ? channel.history.splice(deltaIndex, 1)[0] : channel.history.shift();
    // P2-5：淘汰量按类型记账（含 FIFO 兜底淘汰的生命周期事件）。
    if (removed) {
      const key = String(removed?.type || "unknown");
      channelEvictionStats.set(key, (channelEvictionStats.get(key) || 0) + 1);
    }
  }
}

/** 历史窗口是否已无法覆盖请求游标之后的事件（需要 stream_resync）。 */
export function isHistoryTruncated({ lastId = 0, earliestId = 0 } = {}) {
  const cursor = Number(lastId) || 0;
  const earliest = Number(earliestId) || 0;
  return cursor > 0 && earliest > 0 && cursor + 1 < earliest;
}
