/**
 * 文档预览内的「定位」几何工具（单一事实来源）。
 *
 * 为什么需要它：Word 预览默认「适应宽度」，会对滚动容器设置 CSS `zoom`
 * （A4 794px 塞进右侧栏，常见 70–85%）。此时
 *   - `getBoundingClientRect()` 返回**视觉像素**（已被 zoom 缩放）；
 *   - 滚动容器的 `scrollTop` 是**布局像素**（未被缩放）。
 * 两者相差 1/zoom 倍，直接拿视觉差值去改 scrollTop 会**系统性滚过头**
 * （zoom 0.7 → 多滚 ~43%），表现为「目录点了停不准、批注越靠后偏得越多」。
 *
 * 因此所有「把某个元素滚进视野」的动作都必须经过这里换算，禁止各处自己算。
 */

/** 读取元素实际生效的 CSS zoom（未设置/浏览器不支持时返回 1）。 */
export function readZoomFactor(el) {
  if (!el) return 1;
  let raw = 0;
  try { raw = parseFloat(getComputedStyle(el).zoom); } catch { raw = 0; }
  if (!Number.isFinite(raw) || raw <= 0) {
    // 老浏览器 getComputedStyle().zoom 可能返回 "normal" 或空串：回退读内联样式
    raw = parseFloat(el.style?.zoom);
  }
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * 把容器内的元素滚到视野内。
 * @param {HTMLElement} container 滚动容器（有 overflow 的那个）
 * @param {HTMLElement} el 目标元素
 * @param {{offset?: number, center?: boolean, behavior?: ScrollBehavior}} [options]
 * @returns {boolean} 是否执行了滚动（容器不可滚动时返回 false）
 */
export function scrollToElementInContainer(container, el, options = {}) {
  if (!container || !el) return false;
  const { offset = 16, center = false, behavior = "auto" } = options;
  const zoomFactor = readZoomFactor(container);
  const rect = el.getBoundingClientRect();
  const base = container.getBoundingClientRect();

  if (center) {
    // 视觉中心距 → 布局像素
    const visualDelta = rect.top - base.top - (base.height - rect.height) / 2;
    const next = container.scrollTop + visualDelta / zoomFactor;
    container.scrollTo({ top: Math.max(0, next), behavior });
    return true;
  }

  if (container.scrollHeight <= container.clientHeight + 4) {
    // 容器本身不可滚动（例如外层页面滚动）：退化为原生 scrollIntoView
    el.scrollIntoView({ behavior, block: "center" });
    return true;
  }
  const layoutDelta = (rect.top - base.top) / zoomFactor;
  container.scrollTo({ top: Math.max(0, container.scrollTop + layoutDelta - offset), behavior });
  return true;
}
