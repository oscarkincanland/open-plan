import React from "react";
import Icon from "../Icon.jsx";

const CHANGE_TYPE_LABEL = {
  added: "新增",
  created: "新增",
  deleted: "删除",
  removed: "删除",
  renamed: "重命名",
  modified: "修改",
  changed: "修改",
  updated: "修改",
};
const CHANGE_TYPE_CLASS = {
  新增: "added",
  删除: "deleted",
  重命名: "renamed",
  修改: "modified",
  变更: "modified",
};

/** 改动类型 → { label, className }；未知类型按「变更」处理，不编造语义。 */
function changeTypeOf(change) {
  if (!change) return { label: "变更", className: "modified" };
  const label = change.from ? "重命名" : (CHANGE_TYPE_LABEL[String(change.status || "").toLowerCase()] || "变更");
  return { label, className: CHANGE_TYPE_CLASS[label] || "modified" };
}

/**
 * 本轮改动卡（020 计划 P2-1，对齐 DSH 的 changed-files card）。
 *
 * 数据来自 Run 展示投影的 `changes`（服务端 before/after 快照 + 运行窗口内 mtime 扫描），
 * 只做「本轮改了哪些文件」的入口；逐文件 diff 由右侧「改动」面板承担
 * （`FileChangesPanel` + `/api/runs/:id/changes/:changeId/diff`）。
 * 不折叠、不放进过程折叠体：它是结论旁边的交付事实（规范 §2 折叠体外常显）。
 */
export default function RunChangesCard({ changes = [], onOpenChanges, onOpenFile }) {
  const list = Array.isArray(changes) ? changes.filter((item) => item?.path) : [];
  if (!list.length) return null;
  const shown = list.slice(0, 6);
  const hidden = list.length - shown.length;
  return (
    <div className="rc-card" aria-label="本轮改动">
      <div className="rc-head">
        <Icon name="edit" size={12} />
        <span className="rc-title">本轮改动 · {list.length} 个文件</span>
        {onOpenChanges && (
          <button type="button" className="rc-open" onClick={onOpenChanges}>查看 diff</button>
        )}
      </div>
      <ul className="rc-list">
        {shown.map((change, index) => {
          const type = changeTypeOf(change);
          return (
            <li className="rc-row" key={`${change.path}:${index}`}>
              <button
                type="button"
                className="rc-path"
                title={change.path}
                onClick={() => onOpenFile?.(change.path)}
              >{change.path}</button>
              <span className={`rc-status is-${type.className}`}>{type.label}</span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <div className="rc-more">{onOpenChanges ? `还有 ${hidden} 个文件，查看 diff` : `还有 ${hidden} 个文件`}</div>
      )}
    </div>
  );
}
