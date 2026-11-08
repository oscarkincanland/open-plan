import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import 提示气泡 from "./提示气泡.jsx";
import OverlayPortal from "./OverlayPortal.jsx";

const DEFAULT_STYLE = {
  color: "#2563eb",
  opacity: 0.85,
  width: 2.2,
  radius: 6,
  fillOpacity: 0.18,
  stroke: "#ffffff",
  dashed: true,
};

/**
 * 草稿层样式对话框：颜色 / 线宽或半径 / 透明度 / 填充透明度 / 描边 / 虚线。
 * 只改草稿自身的 style（保存到 agent/drafts），不写正式图层。
 */
export default function 草稿样式对话框({ draft, onClose, onSave }) {
  const geometry = String(draft?.geometryType || "point");
  const initial = useMemo(() => ({ ...DEFAULT_STYLE, ...(draft?.style || {}) }), [draft]);
  const [style, setStyle] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const set = (key, value) => setStyle((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      await onSave?.({ ...style, width: Number(style.width), radius: Number(style.radius), opacity: Number(style.opacity), fillOpacity: Number(style.fillOpacity) });
      onClose?.();
    } catch (e) {
      setMsg(`保存失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayPortal>
    <div className="mp-iso-backdrop" onClick={onClose}>
      <div className="mp-iso-panel" role="dialog" aria-modal="true" aria-label="草稿层样式" onClick={(e) => e.stopPropagation()}>
        <div className="mp-iso-head">
          <span><Icon name="tool" size={14} /> 草稿样式 · {draft?.name || draft?.id}</span>
          <提示气泡 label="关闭草稿样式">
            <button className="mp-op" type="button" aria-label="关闭草稿样式" onClick={onClose}><Icon name="close" size={14} /></button>
          </提示气泡>
        </div>
        <div className="mp-iso-body">
          <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 10 }}>
            只调整这条草稿的显示样式，不写入正式图层；确认固化后样式会一起带入正式图层。
          </div>
          <div className="mp-iso-row">
            <span className="mp-iso-label">颜色</span>
            <input type="color" className="mp-iso-color" value={style.color} onChange={(e) => set("color", e.target.value)} aria-label="草稿颜色" />
          </div>
          {geometry === "point" && (
            <div className="mp-iso-row">
              <span className="mp-iso-label">点半径</span>
              <input type="range" className="mp-iso-range" min="1" max="20" step="0.5" value={style.radius} onChange={(e) => set("radius", e.target.value)} aria-label="点半径" />
              <span className="mp-iso-val">{Number(style.radius).toFixed(1)}</span>
            </div>
          )}
          {geometry !== "point" && (
            <div className="mp-iso-row">
              <span className="mp-iso-label">线宽</span>
              <input type="range" className="mp-iso-range" min="0.4" max="10" step="0.2" value={style.width} onChange={(e) => set("width", e.target.value)} aria-label="线宽" />
              <span className="mp-iso-val">{Number(style.width).toFixed(1)}</span>
            </div>
          )}
          <div className="mp-iso-row">
            <span className="mp-iso-label">透明度</span>
            <input type="range" className="mp-iso-range" min="0.1" max="1" step="0.05" value={style.opacity} onChange={(e) => set("opacity", e.target.value)} aria-label="透明度" />
            <span className="mp-iso-val">{Math.round(Number(style.opacity) * 100)}%</span>
          </div>
          {geometry === "polygon" && (
            <div className="mp-iso-row">
              <span className="mp-iso-label">填充透明度</span>
              <input type="range" className="mp-iso-range" min="0" max="0.8" step="0.02" value={style.fillOpacity} onChange={(e) => set("fillOpacity", e.target.value)} aria-label="填充透明度" />
              <span className="mp-iso-val">{Math.round(Number(style.fillOpacity) * 100)}%</span>
            </div>
          )}
          {geometry === "point" && (
            <div className="mp-iso-row">
              <span className="mp-iso-label">描边色</span>
              <input type="color" className="mp-iso-color" value={style.stroke} onChange={(e) => set("stroke", e.target.value)} aria-label="描边色" />
            </div>
          )}
          {geometry !== "point" && (
            <div className="mp-iso-row">
              <span className="mp-iso-label">虚线</span>
              <input type="checkbox" checked={style.dashed !== false} onChange={(e) => set("dashed", e.target.checked)} aria-label="虚线" />
            </div>
          )}
          {msg && <div className="mp-iso-info" style={{ marginTop: 8 }}>{msg}</div>}
          <div className="mp-iso-actions">
            <button className="btn-sm" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="btn primary" type="button" onClick={save} disabled={busy}>{busy ? "保存中…" : "应用样式"}</button>
          </div>
        </div>
      </div>
    </div>
    </OverlayPortal>
  );
}
