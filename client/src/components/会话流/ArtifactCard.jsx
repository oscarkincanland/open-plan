import React, { useState } from "react";
import Icon from "../Icon.jsx";
import { buildArtifactIndex } from "../../产物类型.js";

const MAX_VISIBLE_FILES = 8;

/**
 * 本轮产物卡（落地文档 2026-10-31-001 §5.2 G4）：
 * 只有产物本身 —— 头行（本轮产物 · N 个文件）+ 文件行（类型图标 + 名称 + 徽标 + 路径 + 大小 + 打开/定位/回滚）。
 * 不再有目标达成/文件变更/验证三格网格；超过 8 个文件折叠为「+N」摘要行。
 */
export default function ArtifactCard({ products = [], onOpenFile = null, onLocate = null, onRollback = null }) {
  const [showAll, setShowAll] = useState(false);
  const list = buildArtifactIndex(products).list;
  if (!list.length) return null;
  const visible = showAll ? list : list.slice(0, MAX_VISIBLE_FILES);
  const hidden = list.length - visible.length;
  return (
    <div className="ac-card">
      <div className="ac-head">
        <span className="ac-title"><Icon name="flow" size={13} />本轮产物</span>
        <span className="ac-meta">{list.length} 个文件</span>
      </div>
      <div className="ac-files">
        {visible.map((item) => (
          <div className="ac-file-row" key={item.path}>
            <span className="ac-file-icon" aria-hidden="true"><Icon name={item.icon} size={18} /></span>
            <div className="ac-file-main">
              <div className="ac-file-name">
                {item.name}
                {!item.attributed && <span className="ac-badge warn">待确认</span>}
                {item.deliverable && <span className="ac-badge">交付</span>}
              </div>
              <div className="ac-file-path" title={item.path}>{item.path}</div>
            </div>
            <span className="ac-file-meta">{item.sizeText}</span>
            <span className="ac-file-actions">
              {onOpenFile && <button type="button" onClick={() => onOpenFile(item.path)}><Icon name="externalLink" size={11} />打开</button>}
              {onLocate && <button type="button" onClick={() => onLocate()}><Icon name="locate" size={11} />定位</button>}
              {onRollback && <button type="button" onClick={() => onRollback()}><Icon name="refresh" size={11} />回滚</button>}
            </span>
          </div>
        ))}
        {hidden > 0 && (
          <button type="button" className="ac-more" onClick={() => setShowAll(true)} aria-expanded={false}>
            还有 {hidden} 个文件，点击全部展开
          </button>
        )}
      </div>
    </div>
  );
}
