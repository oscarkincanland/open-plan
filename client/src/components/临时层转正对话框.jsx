import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import 提示气泡 from "./提示气泡.jsx";

/** 临时层转正：确认名称与分组后写为正式图层（写操作在 Work 模式）。 */
export default function 临时层转正对话框({ item, groups = [], onClose, onConfirm }) {
  const initial = useMemo(() => String(item?.label || "分析结果").replace(/[^\w\u4e00-\u9fa5-]/g, "-"), [item]);
  const [name, setName] = useState(initial);
  const groupOptions = useMemo(() => {
    const names = groups.map((g) => (typeof g === "string" ? g : g?.name)).filter(Boolean);
    return names.length ? names : ["其他"];
  }, [groups]);
  const [group, setGroup] = useState(groupOptions[0]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const confirm = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setMsg("");
    try {
      await onConfirm?.({ name: name.trim(), group });
    } catch (e) {
      setMsg(`转正失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mp-iso-backdrop" onClick={onClose}>
      <div className="mp-iso-panel" role="dialog" aria-modal="true" aria-label="临时层保存为正式图层" onClick={(e) => e.stopPropagation()}>
        <div className="mp-iso-head">
          <span><Icon name="download" size={14} /> 保存为正式图层</span>
          <提示气泡 label="关闭保存对话框">
            <button className="mp-op" type="button" aria-label="关闭保存对话框" onClick={onClose}><Icon name="close" size={14} /></button>
          </提示气泡>
        </div>
        <div className="mp-iso-body">
          <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 10 }}>
            当前结果来自「{item?.label || "临时层"}」，保存后写入项目图层与瓦片；写入需在 Work 模式并经审批。
          </div>
          <div className="mp-iso-row">
            <span className="mp-iso-label">图层名称</span>
            <input className="mp-iso-range mp-iso-ranges" value={name} onChange={(e) => setName(e.target.value)} aria-label="正式图层名称" />
          </div>
          <div className="mp-iso-row">
            <span className="mp-iso-label">分组</span>
            <select className="mp-iso-range" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="正式图层分组">
              {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          {msg && <div className="mp-iso-info" style={{ marginTop: 8 }}>{msg}</div>}
          <div className="mp-iso-actions">
            <button className="btn-sm" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="btn primary" type="button" onClick={confirm} disabled={busy || !name.trim()}>{busy ? "保存中…" : "保存为正式图层"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
