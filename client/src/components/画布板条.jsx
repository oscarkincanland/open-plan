import React from "react";
import Icon from "./Icon.jsx";
import { 板缩略数据, 默认板标题 } from "../画布/画布模型.js";

/**
 * 创作画布底部板条（2026-11-11-004 §3.6 / DESIGN §8.4「底部板条」）。
 *
 * 职责边界：
 *   - 只做导航：点击卡片把对应画板设为当前板并居中定位（定位逻辑在 创作画布.jsx 的 onSelect）。
 *   - 缩略为轻量色块近似（板缩略数据）：元素矩形/图片为色块、文本为细条；未加载板显示骨架占位。
 *   - 不做编辑、不取数：boardData 由 创作画布 传入（既有懒加载结果），组件不发任何请求。
 *
 * 折叠状态是用户级偏好：localStorage `oaw_canvas_strip_collapsed`（"1"/"0"），由父组件持有。
 */
export default function 画布板条({
  boards = [],
  boardData = {},
  activePath = "",
  agentBoard = "",
  agentActive = false,
  collapsed = false,
  onToggleCollapsed,
  onSelect,
}) {
  if (!Array.isArray(boards) || !boards.length) return null;
  return (
    <div className="oaw-canvas-strip" role="toolbar" aria-label="画板导航条">
      <button
        type="button"
        className={`oaw-canvas-strip-toggle ${collapsed ? "collapsed" : ""}`}
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "展开画板导航条" : "折叠画板导航条"}
        title={collapsed ? "展开画板导航条" : "折叠画板导航条"}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {!collapsed && (
        <div className="oaw-canvas-strip-scroll">
          {boards.map((板, 序号) => {
            const 缩略 = 板缩略数据(boardData[板.path]);
            const 是当前 = 板.path === activePath;
            const 是agent板 = Boolean(agentActive) && 板.path === agentBoard;
            return (
              <button
                key={板.path}
                type="button"
                className={`oaw-canvas-strip-card ${是当前 ? "active" : ""} ${是agent板 ? "agent-editing" : ""}`}
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
                <span className="oaw-canvas-strip-label">{序号 + 1} · 片</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
