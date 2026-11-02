import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import 提示气泡 from "./提示气泡.jsx";

/**
 * 三级重置对话框（GIS 工程化 · T2.3）
 *
 * tree    恢复基线：图层顺序/分组/显隐/透明度/样式回到基线，保留基线后新增的正式层
 * temp    清空临时层：只清本次会话的临时可视化，不动正式层
 * baseline 恢复基线并清理：在 tree 基础上，把基线后新增的正式层移入 .trash
 *
 * 危险级别递增；baseline 必须输入项目名二次确认（ADR 0015）。
 */
const LEVELS = [
  {
    id: "tree",
    label: "重置图层树",
    icon: "layers",
    desc: "恢复基线的图层顺序、分组、显隐、透明度与样式；基线后新增的正式层保留。",
    danger: false,
  },
  {
    id: "temp",
    label: "清空临时层",
    icon: "star",
    desc: "移除本次会话生成的分析/OD/等时圈/绘制等临时可视化，正式层不受影响。",
    danger: false,
  },
  {
    id: "baseline",
    label: "恢复基线并清理",
    icon: "refresh",
    desc: "先恢复基线，再把基线后新增的正式层移入项目回收站（.trash），可人工恢复。",
    danger: true,
  },
];

export default function 重置对话框({ project, registry, tempCount = 0, baselineAt = "", onClose, onReset }) {
  const [level, setLevel] = useState("tree");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);

  const layers = registry?.layers || [];
  const counts = registry?.counts || {};
  const addedAfterBaseline = counts.addedAfterBaseline ?? layers.filter((l) => !l.inBaseline).length;
  const baselineLayers = Math.max(0, layers.length - addedAfterBaseline);
  const impact = useMemo(() => {
    if (level === "tree") return { restore: baselineLayers, keep: addedAfterBaseline, remove: 0, temp: 0 };
    if (level === "temp") return { restore: 0, keep: 0, remove: 0, temp: tempCount };
    return { restore: baselineLayers, keep: 0, remove: addedAfterBaseline, temp: tempCount };
  }, [level, baselineLayers, addedAfterBaseline, tempCount]);

  const canRun = level !== "baseline" || confirmName.trim() === project;
  const selected = LEVELS.find((item) => item.id === level) || LEVELS[0];

  const run = async () => {
    if (!canRun || busy) return;
    setBusy(true);
    try { await onReset?.(level); } finally { setBusy(false); }
  };

  return (
    <div className="mp-iso-backdrop" onClick={onClose}>
      <div className="mp-iso-panel mp-reset-panel" role="dialog" aria-modal="true" aria-label="重置地图项目" onClick={(e) => e.stopPropagation()}>
        <div className="mp-iso-head">
          <span><Icon name="refresh" size={14} /> 重置「{project}」</span>
          <提示气泡 label="关闭重置对话框">
            <button className="mp-op" type="button" aria-label="关闭重置对话框" onClick={onClose}><Icon name="close" size={14} /></button>
          </提示气泡>
        </div>
        <div className="mp-iso-body">
          <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 10 }}>
            基线时间：{baselineAt ? new Date(baselineAt).toLocaleString() : "未设置基线（先在项目菜单「设为基线」）"}
          </div>
          <div className="mp-reset-levels" role="radiogroup" aria-label="重置级别">
            {LEVELS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={level === item.id}
                className={`mp-reset-level ${level === item.id ? "active" : ""} ${item.danger ? "danger" : ""}`}
                onClick={() => { setLevel(item.id); setConfirmName(""); }}
              >
                <Icon name={item.icon} size={14} />
                <span className="mp-reset-level-text">
                  <strong>{item.label}</strong>
                  <span>{item.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mp-reset-impact" aria-live="polite">
            {level === "temp"
              ? `将清空 ${impact.temp} 个临时层，正式图层 0 个受影响。`
              : `将恢复 ${impact.restore} 个基线图层；保留 ${impact.keep} 个新增层；移除 ${impact.remove} 个新增层。`}
            {level !== "temp" && impact.temp > 0 && level === "baseline" ? ` 同时清空 ${impact.temp} 个临时层。` : ""}
          </div>
          {level === "baseline" && (
            <div className="mp-iso-row">
              <span className="mp-iso-label">输入项目名确认</span>
              <input
                className="mp-iso-range mp-iso-ranges"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={project}
                aria-label="输入项目名以确认恢复基线"
              />
            </div>
          )}
          {baselineAt === "" && level !== "temp" && (
            <div className="mp-iso-info" style={{ marginTop: 8 }}>当前项目还没有基线；请先在项目菜单执行「设为基线」。</div>
          )}
          <div className="mp-iso-actions">
            <button className="btn-sm" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button
              className={`btn ${selected.danger ? "danger" : "primary"}`}
              type="button"
              disabled={!canRun || busy || (level !== "temp" && !baselineAt)}
              onClick={run}
              title={!canRun ? "需输入完整项目名" : selected.label}
            >
              {busy ? "执行中…" : selected.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
