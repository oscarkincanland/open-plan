import React, { useMemo, useState } from "react";
import Icon from "../Icon.jsx";
import 文件类型图标 from "../文件类型图标.jsx";
import { buildArtifactIndex } from "../../产物类型.js";
import { 用系统打开, 在文件夹中显示 } from "../../平台/外部打开.js";

/** 首屏只列主要交付物；其余折叠成一行明细（计划 2026-11-11-011）。 */
const PRIMARY_LIMIT = 3;

/** 主要交付物排序：交付优先 → 文档类优先 → 保持原有顺序。 */
const KIND_RANK = { doc: 0, sheet: 1, slides: 2, pdf: 3, html: 4, md: 5, code: 6, image: 7, map: 8, archive: 9, text: 10, other: 11 };

function rankArtifacts(list = []) {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const deliverable = Number(Boolean(b.item.deliverable)) - Number(Boolean(a.item.deliverable));
      if (deliverable) return deliverable;
      const kind = (KIND_RANK[a.item.kind] ?? KIND_RANK.other) - (KIND_RANK[b.item.kind] ?? KIND_RANK.other);
      if (kind) return kind;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * 本轮产物卡（计划 2026-11-11-011 重做）。
 *
 * 与原实现的差别：
 *   1. 默认只列 3 条**主要交付物**，其余折叠成「还有 N 个文件」一行——折叠行在滚动容器之外，
 *      不再被 320px 内部滚动裁掉（旧实现 MAX_VISIBLE_FILES=8 且折叠按钮会被滚出视野）。
 *   2. 每条产物提供**常驻打开方式**：内置预览 / 系统默认程序 / 在文件夹中显示，
 *      全是图标按钮，不产生任何向下浮层。
 *   3. 头部把口径写成「本轮产物 N 个文件 · 主要交付 X · 待确认 Y」。
 */
export default function ArtifactCard({ products = [], onOpenFile = null, onOpenPanel = null, onNotice = null }) {
  const [expanded, setExpanded] = useState(false);
  const list = useMemo(() => buildArtifactIndex(products).list, [products]);
  const sorted = useMemo(() => rankArtifacts(list), [list]);
  if (!sorted.length) return null;

  const visible = expanded ? sorted : sorted.slice(0, PRIMARY_LIMIT);
  const hidden = Math.max(0, sorted.length - PRIMARY_LIMIT);
  const deliverableCount = sorted.filter((item) => item.deliverable).length;
  const provisionalCount = sorted.filter((item) => !item.confirmed).length;

  const openExternally = async (item) => {
    const result = await 用系统打开(item.path);
    if (!result.ok) onNotice?.(`无法用系统应用打开 ${item.name || item.path}：${result.error || "未知原因"}`);
  };
  const revealItem = async (item) => {
    const result = await 在文件夹中显示(item.path);
    if (!result.ok) onNotice?.(`无法在文件夹中显示 ${item.name || item.path}：${result.error || "未知原因"}`);
  };

  return (
    <div className="ac-card">
      <div className="ac-head">
        <span className="ac-title">
          <Icon name="flow" size={13} />
          本轮产物
          <span className="ac-meta">{sorted.length} 个文件</span>
          {deliverableCount > 0 && <span className="ac-chip deliverable">主要交付 {deliverableCount}</span>}
          {provisionalCount > 0 && <span className="ac-chip provisional">待确认 {provisionalCount}</span>}
        </span>
        {onOpenPanel && (
          <button type="button" className="product-cards-link" onClick={() => onOpenPanel()} title="在右侧「产物」面板查看版本与固定">
            在产物面板查看
          </button>
        )}
      </div>
      <div className="product-cards ac-files">
        {visible.map((item) => (
          <div className={`product-card${item.deliverable ? " deliverable" : ""}${item.confirmed ? "" : " provisional"}`} key={item.path}>
            <button type="button" className="product-card-main" onClick={() => onOpenFile?.(item.path)} title={`${item.path}\n点击在内置预览中打开`}>
              <span className="product-card-icon"><文件类型图标 file={item.path} size={18} /></span>
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
            <span className="product-card-actions">
              <button type="button" className="product-card-open" onClick={() => onOpenFile?.(item.path)} title={`在内置预览中打开 ${item.path}`}>
                打开
              </button>
              <button
                type="button"
                className="product-card-iconbtn"
                onClick={() => openExternally(item)}
                aria-label={`用系统默认应用打开 ${item.name || item.path}`}
                title="用系统默认应用打开"
              >
                <Icon name="externalLink" size={13} />
              </button>
              <button
                type="button"
                className="product-card-iconbtn"
                onClick={() => revealItem(item)}
                aria-label={`在文件夹中显示 ${item.name || item.path}`}
                title="在文件夹中显示"
              >
                <Icon name="folderOpen" size={13} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="ac-more"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? "收起其余产物" : "展开其余产物"}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
          {expanded ? "收起其余文件" : `还有 ${hidden} 个文件`}
          <small>{expanded ? "只看主要交付" : "其余产物与线索"}</small>
        </button>
      )}
    </div>
  );
}
