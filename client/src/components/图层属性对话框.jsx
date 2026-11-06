import React, { useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import 提示气泡 from "./提示气泡.jsx";

const TYPE_NAMES = { boundary: "面", road: "线", point: "点" };
const KIND_NAMES = { builtin: "内置", import: "导入", agent: "Agent 生成", analysis: "分析结果" };

function fmtTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/**
 * 图层属性对话框（GIS 工程化 · T2.2）
 *
 * 元数据可追溯（来源/格式/要素数/范围/时间）、锁定、导出 GeoJSON、替换数据。
 * 锁定后的图层由 Agent 侧拒绝写入；用户的属性编辑仍可解除锁定。
 */
export default function 图层属性对话框({ project, layer, registry, groups = [], onClose, onSave, onReplaced, conversationMode = "chat" }) {
  const meta = layer || {};
  const registryLayer = (registry?.layers || []).find((l) => String(l.id) === String(meta.id));
  const merged = registryLayer ? { ...meta, ...registryLayer } : meta;
  const [name, setName] = useState(merged.name || merged.id || "");
  const [group, setGroup] = useState(merged.group || "其他");
  const [locked, setLocked] = useState(Boolean(merged.locked));
  const [opacity, setOpacity] = useState(typeof merged.opacity === "number" ? merged.opacity : 1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  const stats = merged.stats || null;
  const source = merged.source || {};
  const groupOptions = useMemo(() => {
    const names = groups.map((g) => (typeof g === "string" ? g : g?.name)).filter(Boolean);
    if (merged.group && !names.includes(merged.group)) names.push(merged.group);
    return names.length ? names : ["其他"];
  }, [groups, merged.group]);

  const dirty = name !== (merged.name || merged.id || "")
    || group !== (merged.group || "其他")
    || locked !== Boolean(merged.locked)
    || Number(opacity) !== (typeof merged.opacity === "number" ? merged.opacity : 1);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      await onSave?.(merged.id, { name: name.trim() || merged.id, group, locked, opacity: Number(opacity) });
      setMsg("已保存");
    } catch (e) {
      setMsg(`保存失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportLayer = async () => {
    setMsg("");
    try {
      const resp = await fetch(`/api/map/project/${encodeURIComponent(project)}/layer/${encodeURIComponent(merged.id)}/export`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${merged.id}.geojson`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg("已导出 GeoJSON");
    } catch (e) {
      setMsg(`导出失败：${e.message}`);
    }
  };

  const replaceFile = async (file) => {
    if (!file) return;
    if (conversationMode === "chat") {
      setMsg("Chat 只读：替换数据请切换到 Work 模式");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const text = await file.text();
      let geojson;
      try { geojson = JSON.parse(text); } catch { throw new Error("只支持 GeoJSON / JSON 文件"); }
      const result = await onReplaced?.(merged.id, geojson, file.name.toLowerCase().endsWith(".json") ? "json" : "geojson");
      setMsg(`已替换：${result?.features ?? geojson.features?.length ?? 0} 个要素，旧数据已入回收站`);
    } catch (e) {
      setMsg(`替换失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mp-iso-backdrop" onClick={onClose}>
      <div className="mp-iso-panel mp-layer-props" role="dialog" aria-modal="true" aria-label={`图层属性 ${merged.name || merged.id}`} onClick={(e) => e.stopPropagation()}>
        <div className="mp-iso-head">
          <span><Icon name="layers" size={14} /> 图层属性</span>
          <提示气泡 label="关闭图层属性">
            <button className="mp-op" type="button" aria-label="关闭图层属性" onClick={onClose}><Icon name="close" size={14} /></button>
          </提示气泡>
        </div>
        <div className="mp-iso-body">
          <div className="mp-props-grid">
            <div className="mp-props-row"><span>图层 id</span><code>{merged.id}</code></div>
            <div className="mp-props-row"><span>类型</span><span>{TYPE_NAMES[merged.type] || merged.type || "—"}</span></div>
            <div className="mp-props-row"><span>来源</span><span>{KIND_NAMES[source.kind] || source.kind || "—"}{source.format ? ` · ${source.format.toUpperCase()}` : ""}</span></div>
            <div className="mp-props-row"><span>数据文件</span><span>{source.path || "（内置瓦片源）"}</span></div>
            <div className="mp-props-row"><span>要素数</span><span>{stats?.statsOmitted ? "大图层（未统计）" : stats?.features != null ? Number(stats.features).toLocaleString() : "—"}</span></div>
            <div className="mp-props-row"><span>范围</span><span>{stats?.bbox ? stats.bbox.map((n) => Number(n).toFixed(4)).join(", ") : stats?.statsOmitted ? "大图层（未统计）" : "—"}</span></div>
            <div className="mp-props-row"><span>导入时间</span><span>{fmtTime(source.importedAt)}</span></div>
            <div className="mp-props-row"><span>更新时间</span><span>{fmtTime(merged.updatedAt)}</span></div>
            <div className="mp-props-row"><span>基线</span><span>{registryLayer?.inBaseline ? "基线图层" : "基线后新增"}</span></div>
          </div>

          <div className="mp-props-form">
            <label className="mp-iso-row">
              <span className="mp-iso-label">名称</span>
              <input className="mp-iso-range mp-iso-ranges" value={name} onChange={(e) => setName(e.target.value)} aria-label="图层名称" />
            </label>
            <label className="mp-iso-row">
              <span className="mp-iso-label">分组</span>
              <select className="mp-iso-range" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="图层分组">
                {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <div className="mp-iso-row">
              <span className="mp-iso-label">透明度</span>
              <input className="mp-iso-range" type="range" min="0" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="图层透明度" />
              <span className="mp-props-value">{Math.round(Number(opacity) * 100)}%</span>
            </div>
            <div className="mp-iso-row">
              <span className="mp-iso-label">锁定</span>
              <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} aria-label="锁定图层" />
              <span className="mp-props-value">{locked ? "Agent 不得修改该图层" : "允许 Agent 修改"}</span>
            </div>
          </div>

          {msg && <div className="mp-iso-info" style={{ marginTop: 8 }}>{msg}</div>}

          <div className="mp-iso-actions mp-props-actions">
            <button className="btn-sm" type="button" onClick={exportLayer} title="导出单层 GeoJSON"><Icon name="download" size={13} /> 导出</button>
            <button className="btn-sm" type="button" onClick={() => fileRef.current?.click()} disabled={busy} title="用 GeoJSON 替换该图层数据（旧数据进回收站）"><Icon name="upload" size={13} /> 替换数据</button>
            <input ref={fileRef} type="file" accept=".geojson,.json" style={{ display: "none" }} onChange={(e) => { replaceFile(e.target.files?.[0]); e.target.value = ""; }} />
            <span className="mp-props-spacer" />
            <button className="btn-sm" type="button" onClick={onClose}>关闭</button>
            <button className="btn primary" type="button" onClick={save} disabled={busy || !dirty}>{busy ? "保存中…" : "保存"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
