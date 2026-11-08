/**
 * 输入区统一面板外壳（2026-11-08 D3，ADR-0029）。
 *
 * 组成：未识别标记提示条 → 引用 chip 条（可删，与 textarea 标记双向同步）→ 候选面板。
 * textarea 仍由 ChatPanel 持有（8k 行组件里抽 textarea 的回归风险高于收益），
 * 本组件只负责“输入态 chip + 唯一面板”，因此 flag 关闭时完全不渲染。
 */
import React from "react";
import Icon from "../Icon.jsx";
import ComposerPanel from "./ComposerPanel.jsx";
import { REFERENCE_KIND_META, referenceChipLabel, referenceStatusTone } from "../../引用标记.js";

const STATUS_TEXT = { resolved: "已解析", pending: "待解析", missing: "缺失" };

function ChipStatusIcon({ tone }) {
  if (tone === "resolved") return <Icon name="check" size={11} />;
  if (tone === "missing") return <Icon name="warning" size={11} />;
  return <Icon name="more" size={11} />;
}

/** 输入栏引用 chip：类型图标 + 标签 + 三态 + 删除（删除时由父组件同步删 textarea 标记）。 */
function ReferenceChip({ item, onRemove }) {
  const meta = REFERENCE_KIND_META[item.kind] || REFERENCE_KIND_META.file;
  const tone = referenceStatusTone(item);
  const label = referenceChipLabel(item);
  return (
    <span className={`composer-chip is-${tone}`} title={`${meta.label}：${item.target} · ${STATUS_TEXT[tone]}`}>
      <Icon name={meta.icon} size={11} />
      <span className="composer-chip-symbol">{meta.symbol}</span>
      <span className="composer-chip-label">{label}</span>
      <span className="composer-chip-status" aria-label={STATUS_TEXT[tone]}><ChipStatusIcon tone={tone} /></span>
      <button type="button" onClick={() => onRemove?.(item)} aria-label={`移除${meta.label} ${label}`} title="移除引用（同时删除输入框里的标记）">
        <Icon name="close" size={10} />
      </button>
    </span>
  );
}

export default function Composer({
  menu = null,
  items = [],
  counts = {},
  activeIndex = 0,
  loading = {},
  onGroupChange = () => {},
  onPick = () => {},
  onHover = () => {},
  onClose = () => {},
  references = [],
  agentMentions = [],
  onRemoveReference = () => {},
  notice = null,
  onDismissNotice = () => {},
}) {
  const chips = [...references, ...agentMentions];
  return (
    <div className="composer-unified">
      {notice && (
        <div className={`composer-notice ${notice.tone || "warning"}`} role="status" aria-live="polite">
          <Icon name="warning" size={12} />
          <span>{notice.text}</span>
          <button type="button" onClick={onDismissNotice} aria-label="关闭提示" title="关闭提示">
            <Icon name="close" size={10} />
          </button>
        </div>
      )}
      {chips.length > 0 && (
        <div className="composer-chip-bar" aria-label="本轮引用">
          <span className="composer-chip-bar-label">引用</span>
          {chips.map((item) => (
            <ReferenceChip key={item.id || `${item.kind}:${item.target}`} item={item} onRemove={onRemoveReference} />
          ))}
        </div>
      )}
      {menu && (
        <ComposerPanel
          menu={menu}
          items={items}
          counts={counts}
          activeIndex={activeIndex}
          loading={loading}
          onGroupChange={onGroupChange}
          onPick={onPick}
          onHover={onHover}
          onClose={onClose}
        />
      )}
    </div>
  );
}
