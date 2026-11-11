import React, { useEffect, useMemo } from "react";
import Icon from "./Icon.jsx";
import { 板缩略数据, 默认板标题 } from "../画布/画布模型.js";

/**
 * 创作画布全览浮层（2026-11-11-004 §3.6 / DESIGN §8.4「全览浮层」）。
 *
 * 职责边界：
 *   - 只做总览与跳转：按页分节展示全部画板缩略卡片，点击卡片由父组件定位并关闭。
 *   - 缩略复用 板缩略数据 轻量色块近似；不做编辑、不取数。
 *   - 挂载在 .oaw-canvas-shell 内（position:relative），与版本历史/播放覆盖层同一基座，不用 portal。
 *   - Esc 关闭；卡片可 Tab 聚焦、Enter 选择。
 */
export default function 画布全览({
  boards = [],
  boardData = {},
  activePath = "",
  pages = [],
  onSelect,
  onFitAll,
  onClose,
}) {
  // Esc 关闭（对话框自持监听，挂载期生效）。
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 按页分节：页分组结果优先，未归属任何已知页的板进「未分组」。
  const 分节 = useMemo(() => {
    const 列表 = Array.isArray(boards) ? boards : [];
    const 页列表 = Array.isArray(pages) ? pages : [];
    const 已知页 = new Set(页列表.map((页) => String(页?.id || "")));
    const 按页 = 页列表.map((页) => ({
      id: String(页?.id || ""),
      name: String(页?.name || 页?.id || "页"),
      items: 列表.filter((板) => String(板.page || "") === String(页?.id || "")),
    }));
    const 未分组 = 列表.filter((板) => !已知页.has(String(板.page || "")));
    const 结果 = 按页.filter((节) => 节.items.length);
    if (未分组.length) 结果.push({ id: "", name: "未分组", items: 未分组 });
    return 结果;
  }, [boards, pages]);

  const 渲染卡片 = (板, 序号) => {
    const 缩略 = 板缩略数据(boardData[板.path]);
    const 是当前 = 板.path === activePath;
    return (
      <button
        key={板.path}
        type="button"
        className={`oaw-canvas-overview-card ${是当前 ? "active" : ""}`}
        onClick={() => onSelect?.(板.path)}
        title={`${序号 + 1} · ${板.title || 默认板标题(板.path)}`}
        aria-current={是当前 || undefined}
      >
        <span
          className="oaw-canvas-strip-thumb"
          style={缩略?.background ? { background: 缩略.background } : undefined}
          aria-hidden="true"
        >
          {(缩略?.blocks || []).map((块, i) => {
            const 板宽 = Number(板.w) || 1;
            const 板高 = Number(板.h) || 1;
            const 块样式 = {
              left: `${(块.x / 板宽) * 100}%`,
              top: `${(块.y / 板高) * 100}%`,
              width: `${Math.max((块.w / 板宽) * 100, 1.5)}%`,
              height: 块.kind === "text" ? undefined : `${Math.max((块.h / 板高) * 100, 1.5)}%`,
              background: 块.color || undefined,
            };
            return <i key={i} className={`oaw-canvas-strip-block ${块.kind}`} style={块样式} />;
          })}
          {!缩略 && <span className="oaw-canvas-strip-skeleton" />}
        </span>
        <span className="oaw-canvas-overview-label">
          <b>{序号 + 1} · 片</b>
          <span>{板.title || 默认板标题(板.path)}</span>
        </span>
      </button>
    );
  };

  const 总数 = (Array.isArray(boards) ? boards : []).length;

  return (
    <div className="oaw-canvas-overview-mask" onClick={onClose}>
      <div
        className="oaw-canvas-overview"
        role="dialog"
        aria-modal="true"
        aria-label="画板全览"
        onClick={(事件) => 事件.stopPropagation()}
      >
        <div className="oaw-canvas-overview-head">
          <Icon name="grid" size={14} />
          <strong>画板全览</strong>
          <span className="oaw-canvas-overview-sub">{总数} 板</span>
          <button type="button" className="btn-xs" onClick={onFitAll} title="缩放适配显示全部画板">适应全部</button>
          <button type="button" className="btn-xs" onClick={onClose} aria-label="关闭全览"><Icon name="close" size={12} /></button>
        </div>
        <div className="oaw-canvas-overview-body">
          {分节.length ? 分节.map((节) => (
            <div className="oaw-canvas-overview-section" key={节.id || "__ungrouped"}>
              <div className="oaw-canvas-overview-section-name">{节.name}</div>
              <div className="oaw-canvas-overview-grid">
                {节.items.map((板) => 渲染卡片(板, boards.indexOf(板)))}
              </div>
            </div>
          )) : (
            <div className="oaw-canvas-overview-empty">画布还没有画板</div>
          )}
        </div>
      </div>
    </div>
  );
}
