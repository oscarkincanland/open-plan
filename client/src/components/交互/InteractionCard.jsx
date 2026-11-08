import React, { useEffect, useMemo, useState } from "react";
import Icon from "../Icon.jsx";
import {
  KIND_ICONS,
  countdownText,
  isActiveInteraction,
  kindLabel,
  normalizeInteraction,
  questionText,
  receiptText,
} from "./交互模型.js";

/**
 * 消息流内的人机协作卡片（D2，DESIGN §6.4）。
 *
 * 三种形态：
 *   1) 字段表单（payload.fields：text/select/radio/checkbox/file，必填内联校验）；
 *   2) 选项 + 自由输入（payload.options 可点选，也可直接输入）；
 *   3) 草稿预览（payload.previewFile → 打开预览 + 确认/暂不/改）。
 * 已结算/超时/取消：收成一行回执（含假设与"改一下"入口），不再占可交互大卡片。
 * 组件本身不发请求：onSettle / onAssume / onOpenFile 由 ChatPanel 提供。
 */
export default function InteractionCard({
  interaction,
  busy = false,
  onSettle,
  onAssume,
  onOpenFile,
}) {
  const item = useMemo(() => normalizeInteraction(interaction), [interaction]);
  const [text, setText] = useState("");
  const [formValues, setFormValues] = useState({});
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [editingAssumption, setEditingAssumption] = useState(false);
  const [assumptionDraft, setAssumptionDraft] = useState(String(item.assumption || ""));

  const active = isActiveInteraction(item);
  const countdown = countdownText(item, now);
  const nearDeadline = Boolean(countdown);

  useEffect(() => {
    if (!active) return undefined;
    // 进入最后 5 分钟才走秒级刷新，其余时间 15s 足够，避免常驻高频计时。
    const timer = window.setInterval(() => setNow(Date.now()), nearDeadline ? 1000 : 15000);
    return () => window.clearInterval(timer);
  }, [active, nearDeadline]);

  if (!item.interactionId) return null;

  const runSettle = async (payload) => {
    if (sending || busy) return;
    setSending(true);
    setError("");
    try {
      const result = await onSettle?.(item, payload);
      if (result && result.ok === false && !result.ignored) setError("提交失败或交互已失效，请稍后重试");
    } finally {
      setSending(false);
    }
  };

  const submitAssumption = async () => {
    const next = String(assumptionDraft || "").trim();
    if (!next || busy) return;
    setSending(true);
    try {
      await onAssume?.(item, next);
      setEditingAssumption(false);
    } finally {
      setSending(false);
    }
  };

  // ---- 已决：一行回执（已回答 / 已按假设继续 / 已超时 / 已跳过 / 已取消） ----
  if (!active) {
    const receipt = receiptText(item);
    const canRevise = Boolean(item.assumption) || item.settledReason === "assumed";
    return (
      <div className={`interaction-receipt ${item.status} reason-${item.settledReason || "unknown"}`} data-interaction-id={item.interactionId} role="status" title={questionText(item)}>
        <Icon name={item.status === "settled" ? "check" : "info"} size={12} />
        <span className="interaction-receipt-question">{questionText(item)}</span>
        <span className="interaction-receipt-status">{receipt || "已结算"}</span>
        {canRevise && (
          <button type="button" className="btn-xs interaction-receipt-revise" onClick={() => { setEditingAssumption(true); setAssumptionDraft(String(item.assumption || "")); }}>改一下</button>
        )}
        {editingAssumption && (
          <div className="interaction-assumption-edit">
            <input
              className="interaction-assumption-input"
              value={assumptionDraft}
              placeholder="修改假设后重新记录…"
              onChange={(event) => setAssumptionDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); void submitAssumption(); }
                if (event.key === "Escape") { event.preventDefault(); setEditingAssumption(false); }
              }}
            />
            <button type="button" className="btn-xs" disabled={!assumptionDraft.trim() || sending} onClick={() => void submitAssumption()}>保存</button>
            <button type="button" className="btn-xs" onClick={() => setEditingAssumption(false)}>取消</button>
          </div>
        )}
      </div>
    );
  }

  // ---- 活动：三种形态 ----
  const fields = item.fields;
  const options = item.options;
  const isApproval = item.kind === "approval";
  const isConfirm = item.kind === "confirm";

  const submitText = (value) => {
    const answer = String(value ?? text).trim();
    if (!answer) return;
    void runSettle({ answer });
  };

  const submitForm = () => {
    const missing = fields.find((field) => {
      const value = formValues[field.id];
      return field.required && (Array.isArray(value) ? value.length === 0 : !String(value ?? "").trim());
    });
    if (missing) {
      setError(`请填写：${missing.label}`);
      return;
    }
    const values = {};
    for (const field of fields) {
      const value = formValues[field.id];
      values[field.id] = Array.isArray(value) ? value : String(value ?? "");
    }
    const answer = fields
      .map((field) => `${field.label}：${Array.isArray(values[field.id]) ? values[field.id].join("、") : values[field.id]}`)
      .join("\n");
    void runSettle({ answer, values });
  };

  return (
    <div className={`interaction-card kind-${item.kind || "clarify"}`} data-interaction-id={item.interactionId} tabIndex={-1}>
      <div className="interaction-card-head">
        <Icon name={KIND_ICONS[item.kind] || "comment"} size={12} />
        <span className="interaction-card-title">{kindLabel(item.kind)}</span>
        {item.owner?.kind === "subagent" && <span className="interaction-owner">来自子代理</span>}
        {countdown && <span className="interaction-card-countdown" role="timer">{countdown}</span>}
      </div>
      <div className="interaction-card-question">{questionText(item)}</div>

      {item.kind === "review" && item.previewFile && (
        <div className="interaction-card-preview">
          <button type="button" className="btn" onClick={() => onOpenFile?.(item.previewFile)} title={item.previewFile}>
            <Icon name="eye" size={12} /> 查看草稿预览
          </button>
          <span className="interaction-card-preview-name">{item.previewFile}</span>
        </div>
      )}

      {isApproval ? (
        <div className="interaction-card-approval-note" role="note">
          审批保留独立安全语义（允许一次 / 总是允许 / 拒绝），请在输入栏上方的审批入口处理；自动批准不会覆盖显式拒绝。
        </div>
      ) : fields.length ? (
        <div className="interaction-card-form">
          {fields.map((field) => (
            <label className="interaction-field" key={field.id}>
              <span className="interaction-field-label">{field.label}{field.required ? " *" : ""}</span>
              {field.type === "select" ? (
                <select
                  className="interaction-field-input"
                  value={String(formValues[field.id] ?? "")}
                  onChange={(event) => setFormValues((previous) => ({ ...previous, [field.id]: event.target.value }))}
                >
                  <option value="">请选择…</option>
                  {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : field.type === "radio" ? (
                <span className="interaction-field-options">
                  {field.options.map((option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name={`${item.interactionId}:${field.id}`}
                        checked={String(formValues[field.id] ?? "") === option}
                        onChange={() => setFormValues((previous) => ({ ...previous, [field.id]: option }))}
                      />
                      {option}
                    </label>
                  ))}
                </span>
              ) : field.type === "checkbox" ? (
                <span className="interaction-field-options">
                  {field.options.map((option) => {
                    const selected = Array.isArray(formValues[field.id]) ? formValues[field.id] : [];
                    return (
                      <label key={option}>
                        <input
                          type="checkbox"
                          checked={selected.includes(option)}
                          onChange={() => setFormValues((previous) => ({
                            ...previous,
                            [field.id]: selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option],
                          }))}
                        />
                        {option}
                      </label>
                    );
                  })}
                </span>
              ) : field.type === "file" ? (
                <input
                  className="interaction-field-input"
                  type="file"
                  accept={field.accept || undefined}
                  onChange={(event) => setFormValues((previous) => ({ ...previous, [field.id]: event.target.files?.[0]?.name || "" }))}
                />
              ) : (
                <input
                  className="interaction-field-input"
                  placeholder={field.placeholder || "请输入…"}
                  value={String(formValues[field.id] ?? "")}
                  onChange={(event) => setFormValues((previous) => ({ ...previous, [field.id]: event.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <div className="interaction-card-options">
              {options.map((option) => (
                <button key={option} type="button" className="interaction-option" disabled={sending || busy} onClick={() => submitText(option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="interaction-card-input-row">
            <input
              className="interaction-card-input"
              placeholder={item.kind === "review" ? "需要改什么？也可以直接确认…" : "输入你的回答…"}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent?.isComposing) { event.preventDefault(); submitText(); } }}
            />
          </div>
        </>
      )}

      {(error || item.assumption) && (
        <div className="interaction-card-meta">
          {error && <span className="interaction-card-error" role="alert">{error}</span>}
          {item.assumption && <span className="interaction-card-assumption" title={item.assumption}>默认假设：{item.assumption}</span>}
        </div>
      )}

      {!isApproval && (
        <div className="interaction-card-actions">
          {fields.length ? (
            <button type="button" className="btn primary" disabled={sending || busy} onClick={submitForm}>{sending ? "…" : "提交"}</button>
          ) : (
            <button type="button" className="btn primary" disabled={sending || busy || !text.trim()} onClick={() => submitText()}>
              {sending ? "…" : isConfirm ? "确认" : item.kind === "review" ? "确认并继续" : "发送"}
            </button>
          )}
          {item.kind === "review" && !text.trim() && (
            <button type="button" className="btn" disabled={sending || busy} onClick={() => runSettle({ answer: "确认" })}>确认草稿</button>
          )}
          {!isConfirm && (
            <button type="button" className="btn interaction-card-skip" disabled={sending || busy} onClick={() => runSettle({ skip: true })}>
              {item.kind === "review" ? "暂不（按默认假设继续）" : "跳过并继续"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
