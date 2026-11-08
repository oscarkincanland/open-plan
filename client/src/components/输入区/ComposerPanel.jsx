/**
 * 统一候选面板（2026-11-08 D3，ADR-0029 §4.5）。
 *
 * 唯一出口：`/ @ # &` 共用这一个面板；顶部 tab 切组，列表按当前 query 过滤。
 * 焦点始终留在 textarea（点击 tab/选项用 onMouseDown preventDefault 保焦），
 * 因此搜索框只做只读回显——真正的过滤词来自 textarea 里符号后的输入。
 */
import React from "react";
import Icon from "../Icon.jsx";
import { REFERENCE_KIND_META } from "../../引用标记.js";
import { COMPOSER_GROUPS } from "./useComposerState.js";

function itemIcon(item) {
  if (item.kind === "command") return "terminal";
  return REFERENCE_KIND_META[item.kind]?.icon || "link";
}

function itemSymbol(item) {
  if (item.kind === "command") return "/";
  return REFERENCE_KIND_META[item.kind]?.symbol || "@";
}

export default function ComposerPanel({
  menu = null,
  items = [],
  counts = {},
  activeIndex = 0,
  loading = {},
  onGroupChange = () => {},
  onPick = () => {},
  onHover = () => {},
  onClose = () => {},
}) {
  if (!menu) return null;
  const group = COMPOSER_GROUPS.find((item) => item.id === menu.group) || COMPOSER_GROUPS[0];
  const currentLoading = Boolean(loading[group.id]);
  const listId = "composer-panel-list";
  const activeId = items[activeIndex] ? `composer-option-${activeIndex}` : undefined;
  return (
    <div className="composer-panel" role="dialog" aria-label="输入候选面板">
      <div className="composer-panel-tabs" role="tablist" aria-label="候选分组">
        {COMPOSER_GROUPS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === menu.group}
            className={tab.id === menu.group ? "active" : ""}
            title={tab.hint}
            onMouseDown={(event) => { event.preventDefault(); onGroupChange(tab.id); }}
          >
            <span>{tab.label}</span>
            {counts[tab.id] > 0 && <small>{counts[tab.id]}</small>}
          </button>
        ))}
        <button type="button" className="composer-panel-close" aria-label="关闭候选面板" title="关闭（Esc）" onMouseDown={(event) => { event.preventDefault(); onClose(); }}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="composer-panel-search" data-role="composer-search" aria-hidden="true">
        <Icon name="search" size={12} />
        <span>{menu.query ? `筛选：${menu.query}` : `搜索${group.label}…（继续输入即可筛选）`}</span>
      </div>
      {currentLoading ? (
        <div className="composer-panel-loading" role="status">
          <Icon name="loading" size={13} className="icon-loading" />
          <span>{group.id === "skill" ? "正在加载技能…" : "正在加载候选…"}</span>
        </div>
      ) : items.length > 0 ? (
        <div className="composer-panel-list" id={listId} role="listbox" aria-label={`${group.label}候选`} aria-activedescendant={activeId}>
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              id={`composer-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              title={item.hint || item.insert}
              onMouseDown={(event) => { event.preventDefault(); onPick(item); }}
              onMouseEnter={() => onHover(index)}
            >
              <span className="composer-panel-item-icon"><Icon name={itemIcon(item)} size={13} /></span>
              <span className="composer-panel-item-symbol">{itemSymbol(item)}</span>
              <span className="composer-panel-item-label">{item.label}</span>
              <small>{item.kind === "command" ? item.insert.trim() : item.hint}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="composer-panel-empty" role="status">没有匹配项，继续输入或 Tab 切组</div>
      )}
      <div className="composer-panel-footer" aria-hidden="true">
        <span>↑↓ 选择</span>
        <span>Tab 切组</span>
        <span>{group.id === "action" ? "Enter 执行" : "Enter 插入"}</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
