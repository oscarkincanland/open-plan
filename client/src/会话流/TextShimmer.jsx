import React from "react";

/**
 * 运行态「渐变文字流」（计划 2026-11-18-005 / 替代 2026-11-14-001 的扫光）。
 *
 * 结构：单个 `<span>`，不再渲染 aria-hidden 的文字副本。渐变由 CSS
 * （`.tl-shimmer` 的 `background-image` + `background-clip: text`）沿文字横向流动，
 * 无位移、无遮罩，读屏只读到一份文字。
 *
 * 约定：
 * - 只有字符串子节点才上样式；非字符串（图标/富文本）按原样渲染；
 * - `active=false` 时不加类名，DOM 不留空壳；
 * - 减少动效由统一闸门压掉（`[data-reduce-motion]` / `[data-motion-level="off"]`），
 *   组件本身不做媒体查询，避免两处口径漂移；
 * - 不支持 `background-clip` / `color-mix` 的浏览器由 CSS `@supports` 整块跳过，
 *   文字保持纯色可读。
 */
export default function TextShimmer({ active = false, className = "", title, children }) {
  if (!active || typeof children !== "string") {
    return <span className={className} title={title}>{children}</span>;
  }
  return (
    <span className={`tl-shimmer ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}
