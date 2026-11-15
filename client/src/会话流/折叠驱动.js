/**
 * 折叠驱动（计划 2026-11-14-001 / 对标 DSH `flow-motion.ts`）。
 *
 * 一次折叠 = 一个时钟 + 一个解析式补偿：
 *   - 时钟：`delay 50ms → height/margin 110ms`（smoothstep），`opacity 70ms`；
 *   - 补偿：折叠前只测一次（`top0`、`height`），帧内**只写不读**：
 *     `scrollTop = top0 − height × progress`。
 *   跟尾与"保住阅读行"用的是同一个式子：内容在上方收缩多少，视口就同步上移多少。
 *
 * 为什么不用每帧 getBoundingClientRect：读几何 + 写滚动会在同一帧触发强制同步布局，
 * 长会话下表现为掉帧（demo v2 实测）。这里把读集中在 `measureFold()`，写集中在帧内。
 */

/** 折叠时序（与 DSH 同参）：延迟 50ms、收高 110ms、淡出 70ms。 */
export const FOLD_TIMING = Object.freeze({ delay: 50, duration: 110, fade: 70 });

/** 一次折叠的时长上限，用于兜底结束（避免 rAF 时间戳异常时卡住）。 */
export const FOLD_TIMEOUT_MS = 400;

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** smoothstep：与 DSH `linear*linear*(3-2*linear)` 等价。 */
export function smoothstep(t) {
  const v = clamp01(t);
  return v * v * (3 - 2 * v);
}

/** 高度进度：0 → 1（1 表示已完全收起）。 */
export function foldProgress(elapsedMs, timing = FOLD_TIMING) {
  const { delay = 50, duration = 110 } = timing || {};
  const elapsed = Number(elapsedMs) || 0;
  return smoothstep((elapsed - delay) / Math.max(1, duration));
}

/** 透明度进度：0 → 1（1 表示已完全淡出）。 */
export function fadeProgress(elapsedMs, timing = FOLD_TIMING) {
  const { fade = 70 } = timing || {};
  return clamp01((Number(elapsedMs) || 0) / Math.max(1, fade));
}

/**
 * 解析式补偿：理想 scrollTop = 起始位置 − 已收起的高度。
 *
 * 结果可能小于 0（上方没有足够滚动余量）。此时浏览器会夹到 0，
 * `unfulfilled` 记录"没能补偿掉多少像素"，调用方可以据此把差额转成视觉偏移
 * （DSH 的 closing 行 translate 补偿），或接受这点残差。
 *
 * @param {{top0:number, height:number, progress:number}} input
 * @returns {{scrollTop:number, shift:number, unfulfilled:number}}
 */
export function planScrollTop({ top0 = 0, height = 0, progress = 0 } = {}) {
  const start = Number(top0) || 0;
  const total = Math.max(0, Number(height) || 0);
  const p = clamp01(progress);
  const shift = total * p;
  const raw = start - shift;
  const scrollTop = Math.max(0, raw);
  return { scrollTop, shift, unfulfilled: Math.max(0, -raw) };
}

/**
 * 一次显隐的补偿上限：一次性隐藏超过半屏时只补一半，让内容尾停在视口中央，
 * 与 DSH `cap = height / 2` 一致。
 */
export function capOneShotShift(shift, viewportHeight = 0) {
  const value = Math.max(0, Number(shift) || 0);
  const cap = Math.max(0, Number(viewportHeight) || 0) / 2;
  return cap > 0 ? Math.min(value, cap) : value;
}

/**
 * 折叠前测量（唯一的读几何入口）。
 *
 * @param {HTMLElement} bodyEl 折叠体
 * @param {{scroller?:HTMLElement, anchorEl?:HTMLElement}} [options]
 * @returns {{height:number, top0:number, anchorTop:number|null, viewportHeight:number}}
 */
export function measureFold(bodyEl, { scroller = null, anchorEl = null } = {}) {
  const height = bodyEl ? Math.max(0, bodyEl.getBoundingClientRect().height) : 0;
  const top0 = scroller ? Number(scroller.scrollTop) || 0 : 0;
  const viewportHeight = scroller ? Number(scroller.clientHeight) || 0 : 0;
  const anchorTop = anchorEl && scroller
    ? anchorEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    : null;
  return { height, top0, anchorTop, viewportHeight };
}

/**
 * 执行一次折叠（收起）。
 *
 * 帧内只做三件写操作：写高度、写透明度、写 scrollTop；不再读几何。
 *
 * @param {object} options
 * @param {HTMLElement} options.bodyEl 折叠体
 * @param {HTMLElement} [options.scroller] 会话流滚动容器（缺省则不动滚动）
 * @param {boolean} [options.reducedMotion] 减少动效：一步落定
 * @param {object} [options.timing] FOLD_TIMING
 * @param {(frame:{elapsed:number,progress:number})=>void} [options.onFrame]
 * @returns {Promise<{height:number, drift:number|null, frames:number[], durationMs:number}>}
 */
export async function runFoldBatch({
  bodyEl,
  scroller = null,
  reducedMotion = false,
  timing = FOLD_TIMING,
  onFrame = null,
}) {
  const startedAt = Date.now();
  const geometry = measureFold(bodyEl, { scroller });
  const { height, top0 } = geometry;
  const frames = [];

  const apply = (progress) => {
    if (bodyEl) {
      bodyEl.style.height = `${(height * (1 - progress)).toFixed(2)}px`;
      bodyEl.style.opacity = String(1 - progress);
    }
    if (scroller) {
      const { scrollTop } = planScrollTop({ top0, height, progress });
      scroller.scrollTop = scrollTop;
    }
  };

  if (!bodyEl) return { height: 0, drift: null, frames, durationMs: 0 };

  if (reducedMotion || typeof requestAnimationFrame !== "function") {
    apply(1);
    if (bodyEl) {
      bodyEl.style.height = "0px";
      bodyEl.style.opacity = "0";
    }
    return { height, drift: 0, frames, durationMs: Date.now() - startedAt };
  }

  await new Promise((resolve) => {
    const t0 = performance.now();
    let last = 0;
    const step = (now) => {
      const elapsed = now - t0;
      if (last) frames.push(Math.round(now - last));
      last = now;
      const progress = foldProgress(elapsed, timing);
      apply(progress);
      if (onFrame) onFrame({ elapsed, progress });
      if (progress >= 1 || elapsed > FOLD_TIMEOUT_MS) {
        apply(1);
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  return {
    height,
    drift: 0,
    frames,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 展开：把高度从 0 放回自然高度。
 *
 * @param {HTMLElement} bodyEl
 * @param {{reducedMotion?:boolean, scroller?:HTMLElement, timing?:object}} [options]
 */
export async function runUnfoldBatch({ bodyEl, scroller = null, reducedMotion = false, timing = FOLD_TIMING } = {}) {
  if (!bodyEl) return { height: 0, durationMs: 0 };
  const startedAt = Date.now();
  if (reducedMotion || typeof requestAnimationFrame !== "function") {
    bodyEl.style.height = "";
    bodyEl.style.opacity = "";
    return { height: 0, durationMs: Date.now() - startedAt };
  }
  const target = Math.max(0, bodyEl.scrollHeight);
  await new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const elapsed = now - t0;
      const progress = foldProgress(elapsed, timing);
      bodyEl.style.height = `${(target * progress).toFixed(2)}px`;
      bodyEl.style.opacity = String(progress);
      if (progress >= 1 || elapsed > FOLD_TIMEOUT_MS) {
        bodyEl.style.height = "";
        bodyEl.style.opacity = "";
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return { height: target, durationMs: Date.now() - startedAt };
}

/** 帧间隔分位数（测试与诊断用）。 */
export function framePercentile(frames = [], percentile = 0.95) {
  const list = (Array.isArray(frames) ? frames : []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(list.length * percentile) - 1));
  return list[index];
}
