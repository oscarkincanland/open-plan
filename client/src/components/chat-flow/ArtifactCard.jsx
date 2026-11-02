import React, { useState } from "react";
import Icon from "../Icon.jsx";
import { buildArtifactIndex } from "../../产物类型.js";

const MAX_VISIBLE_FILES = 8;

/**
 * 本轮产物卡（精修计划 2026-10-31-002 F6）：
 * 恢复既有产物行格式（与 RunSummary 产物页签同源同类名）：
 * product-card 行 = 类型图标 + 名称 + 类型·格式·大小 + 「交付/待确认」徽标 + 打开按钮；整行可点击打开。
 * 卡头 = 「本轮产物 N 个文件」+「在产物面板查看」链接；>8 个文件折叠为「+N」。
 */
export default function ArtifactCard({ products = [], onOpenFile = null, onOpenPanel = null }) {
  const [showAll, setShowAll] = useState(false);
  const list = buildArtifactIndex(products).list;
  if (!list.length) return null;
  const visible = showAll ? list : list.slice(0, MAX_VISIBLE_FILES);
  const hidden = list.length - visible.length;
  return (
    <div className="ac-card">
      <div className="ac-head">
        <span className="ac-title"><Icon name="flow" size={13} />本轮产物<span className="ac-meta">{list.length} 个文件</span></span>
        {onOpenPanel && (
          <button type="button" className="product-cards-link" onClick={() => onOpenPanel()} title="在右侧「产物」面板查看版本与固定">
            在产物面板查看
          </button>
        )}
      </div>
      <div className="product-cards ac-files">
        {visible.map((item) => (
          <div className={`product-card${item.deliverable ? " deliverable" : ""}${item.confirmed ? "" : " provisional"}`} key={item.path}>
            <button type="button" className="product-card-main" onClick={() => onOpenFile?.(item.path)} title={item.path}>
              <span className={`product-card-icon artifact-kind-${item.icon}`}><Icon name={item.icon} size={15} /></span>
              <span className="product-card-meta">
                <strong>{item.name}</strong>
                <small>{item.typeLabel}{item.sizeText ? ` · ${item.sizeText}` : ""}</small>
              </span>
              {item.deliverable && <span className="product-card-badge">交付</span>}
              {!item.confirmed && (
                <span
                  className="product-card-badge provisional"
                  title="本轮没有把该文件写进台账（bash / officecli 写文件不回报路径），按「本轮确有写入 + 文件在运行窗口内变化」归属到本轮；若同一工作区有并行运行，也可能来自它"
                >待确认</span>
              )}
            </button>
            <button type="button" className="product-card-open" onClick={() => onOpenFile?.(item.path)} title={`打开 ${item.path}`}>打开</button>
          </div>
        ))}
        {hidden > 0 && (
          <button type="button" className="ac-more" onClick={() => setShowAll(true)} aria-expanded={showAll}>
            还有 {hidden} 个文件，点击全部展开
          </button>
        )}
      </div>
    </div>
  );
}
