import React from "react";

/**
 * 运行态"扫光"文字（计划 2026-11-14-001 §4.1 / 对标 DSH `TextShimmer`）。
 *
 * 结构：可见文字 + 一份文字副本，副本上盖 105° 渐变遮罩，只有窄带可见，
 * 由 `transcript-shimmer-sweep` 从 -100% 扫到 +100%（1.5s / steps(48) / delay .3s）。
 *
 * 约定：
 * - 只有字符串子节点才复制文字；非字符串（图标/富文本）按原样渲染，不做扫光；
 * - `active=false` 时不渲染装饰层（DOM 里不留空壳），由 CSS 保持纯色；
 * - 减少动效由统一闸门压掉（`[data-reduce-motion]` / `[data-motion-level="off"]`），
 *   组件本身不做媒体查询，避免两处口径漂移。
 */
export default function TextShimmer({ active = false, className = "", title, children }) {
  if (!active || typeof children !== "string") {
    return <span className={className} title={title}>{children}</span>;
  }
  return (
    <span className={`tl-shimmer ${className}`.trim()} title={title}>
      <span className="tl-shimmer-text">{children}</span>
      <span className="tl-shimmer-deco" aria-hidden="true">
        <span className="tl-shimmer-sweep">{children}</span>
      </span>
    </span>
  );
}
