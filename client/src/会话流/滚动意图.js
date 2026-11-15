/**
 * 滚动意图（计划 2026-11-14-001 / 对标 DSH `use-scroll-follow.ts`）。
 *
 * 只表达"读者想不想跟尾"这一件事，不碰 DOM、不碰 React：
 *   - `following` 是**意图**，不是"当前是否贴底"；
 *   - 用户手势（滚轮/触摸/按键）立即退出跟尾；
 *   - 程序滚动（跟底、恢复位置、折叠补偿）不得改变意图；
 *   - 折叠等批量几何变化期间用 `lock()` 冻结意图，结束后 `unlock()`。
 *
 * 阈值灰度：默认 40px（DSH 为 24px），常量集中在这里，回滚只改一处。
 */

/** 灰度期阈值（px）：先放宽，观察一周再收紧。 */
export const FOLLOW_THRESHOLD_GRAY = 40;
/** 目标阈值（px）：对齐 DSH 的 24px（+1 容差由 isNearBottom 内部处理）。 */
export const FOLLOW_THRESHOLD_FINAL = 24;

/** 距离底部还有多少像素（负数表示已越界，按 0 处理）。 */
export function distanceFromBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const distance = Number(scrollHeight) - Number(scrollTop) - Number(clientHeight);
  return Number.isFinite(distance) ? Math.max(0, distance) : 0;
}

/** 是否贴底：距离 ≤ 阈值（含 1px 亚像素容差）。 */
export function isNearBottom(metrics, threshold = FOLLOW_THRESHOLD_GRAY) {
  const limit = Math.max(0, Number(threshold) || 0) + 1;
  return distanceFromBottom(metrics) <= limit;
}

/**
 * 创建一个意图状态机。
 *
 * @param {{threshold?:number}} [options]
 */
export function createScrollIntent({ threshold = FOLLOW_THRESHOLD_GRAY } = {}) {
  let following = true;
  let lockCount = 0;
  let limit = Math.max(0, Number(threshold) || FOLLOW_THRESHOLD_GRAY);

  const api = {
    isFollowing: () => following,
    state: () => (following ? "following" : "reader"),
    threshold: () => limit,
    setThreshold(value) {
      const next = Number(value);
      if (Number.isFinite(next) && next >= 0) limit = next;
      return limit;
    },
    /** 意图置为跟尾（回到底部按钮、用户发送）。 */
    toBottom() {
      following = true;
    },
    /** 用户手势：立即退出跟尾。 */
    interrupt() {
      following = false;
    },
    /** 程序滚动 / 折叠期间冻结意图判定。 */
    lock() {
      lockCount += 1;
    },
    unlock() {
      lockCount = Math.max(0, lockCount - 1);
    },
    isLocked: () => lockCount > 0,
    /**
     * 滚动事件采样：只有未冻结时才根据位置重算意图。
     * @returns {boolean} 采样后的意图
     */
    onScroll(metrics) {
      if (lockCount > 0) return following;
      following = isNearBottom(metrics, limit);
      return following;
    },
  };
  return api;
}

/**
 * 滚动恢复：从记录位置恢复时要不要跟尾。
 * 记录值为 null/undefined 表示"上次停在底部"，应继续跟尾。
 */
export function restoreFollow(recordedTop) {
  return recordedTop === null || recordedTop === undefined;
}
