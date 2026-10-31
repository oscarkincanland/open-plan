import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import 提示气泡 from "./提示气泡.jsx";

const DEFAULT_PROMPT = (name) => `我在空白地图画布「${name}」上开始做图。请先列出当前可用的数据源与导入方式，然后按我的要求逐步生成图层；结果先作为临时层预览，确认后再保存为正式图层。`;

/** 从中文名称推导项目标识：保留英文数字，其余转短横线。 */
function suggestId(name) {
  const ascii = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (ascii) return ascii.slice(0, 48);
  return `ai-canvas-${Date.now().toString(36).slice(-5)}`;
}

/**
 * AI 画布向导（GIS 工程化 · T3.1）
 *
 * 空白工程 = 只含底图，不继承任何业务图层；基线为空图层清单，
 * 之后所有正式层都是“基线后新增”，一键恢复基线即可全部清回回收站。
 */
export default function AI画布向导({ onCreate, onClose }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const effectiveId = (idTouched ? id : suggestId(name)).trim();
  const defaultPrompt = useMemo(() => DEFAULT_PROMPT(name.trim() || "新画布"), [name]);
  const finalPrompt = prompt.trim() || defaultPrompt;
  const valid = Boolean(name.trim()) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(effectiveId);

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setMsg("正在创建空白画布…");
    try {
      await onCreate?.({ project: effectiveId, name: name.trim(), description: description.trim(), prompt: finalPrompt });
    } catch (e) {
      setMsg(`创建失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mp-iso-backdrop" onClick={onClose}>
      <div className="mp-iso-panel mp-ai-canvas" role="dialog" aria-modal="true" aria-label="新建 AI 画布" onClick={(e) => e.stopPropagation()}>
        <div className="mp-iso-head">
          <span><Icon name="plus" size={14} /> 新建 AI 画布</span>
          <提示气泡 label="关闭新建 AI 画布">
            <button className="mp-op" type="button" aria-label="关闭新建 AI 画布" onClick={onClose}><Icon name="close" size={14} /></button>
          </提示气泡>
        </div>
        <div className="mp-iso-body">
          <div className="mp-iso-hint" style={{ border: "none", padding: 0, marginBottom: 10 }}>
            空白画布只含底图，不继承浙江业务图层；创建后自动绑定当前会话，Agent 生成的图层先进入临时层，确认后转正。
          </div>
          <div className="mp-iso-row">
            <span className="mp-iso-label">画布名称</span>
            <input className="mp-iso-range mp-iso-ranges" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：义乌充电站选址" aria-label="画布名称" />
          </div>
          <div className="mp-iso-row">
            <span className="mp-iso-label">项目标识</span>
            <input
              className="mp-iso-range mp-iso-ranges"
              value={idTouched ? id : suggestId(name)}
              onChange={(e) => { setIdTouched(true); setId(e.target.value); }}
              placeholder="英文/数字/下划线/短横线"
              aria-label="项目标识"
            />
          </div>
          <div className="mp-iso-row">
            <span className="mp-iso-label">说明</span>
            <input className="mp-iso-range mp-iso-ranges" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选：这个画布要解决什么问题" aria-label="画布说明" />
          </div>
          <label className="mp-iso-col" style={{ display: "block", marginTop: 8 }}>
            <span className="mp-iso-label">起步提示（发送到对话栏，可编辑）</span>
            <textarea
              className="mp-ai-prompt"
              value={prompt || defaultPrompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              aria-label="起步提示"
            />
          </label>
          {!valid && name.trim() && <div className="mp-iso-info" style={{ marginTop: 8 }}>项目标识需为 1-64 位英文、数字、下划线或短横线，且以字母或数字开头。</div>}
          {msg && <div className="mp-iso-info" style={{ marginTop: 8 }}>{msg}</div>}
          <div className="mp-iso-actions">
            <button className="btn-sm" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="btn primary" type="button" onClick={create} disabled={!valid || busy}>{busy ? "创建中…" : "创建画布并开始"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
