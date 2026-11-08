import React, { useEffect, useMemo, useState } from "react";
import Icon from "../Icon.jsx";
import {
  COUNTDOWN_WINDOW_MS,
  DOCK_LIMIT,
  KIND_ICONS,
  countdownText,
  dockSummary,
  kindLabel,
  primaryActionLabel,
  questionText,
  remainingMs,
} from "./交互模型.js";

/**
 * 交互坞（D2，DESIGN §7：位于输入框上方、与 GoalBar 同区，队列坞之下）。
 *
 * 只负责摘要与入口：最多 DOCK_LIMIT 条；显示"第 n/m 个"、主按钮与倒计时（仅最后 5 分钟）；
 * 结算/假设通过回调交给 ChatPanel 调 `/api/interactions/*`，本组件不直接发请求。
 * 无待处理交互时不占位（返回 null），与 GoalBar/QueueDock 的空态规则一致。
 */
export default function InteractionDock({
  interactions = [],
  busy = false,
  onSettle,
  onAssume,
  onLocate,
}) {
  const [now, setNow] = useState(() => Date.now());
  const [assumptionEditId, setAssumptionEditId] = useState("");
  const [assumptionDraft, setAssumptionDraft] = useState("");
  const summary = useMemo(() => dockSummary(interactions, DOCK_LIMIT), [interactions]);

  // 只有进入最后 5 分钟窗口才需要走秒；其余时间 15s 一次即可，避免常驻高频计时。
  const hasCountdown = useMemo(
    () => summary.items.some((item) => {
      const remain = remainingMs(item, now);
      return remain > 0 && remain <= COUNTDOWN_WINDOW_MS;
    }),
    [summary.items, now],
  );

  useEffect(() => {
    if (!summary.items.length) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), hasCountdown ? 1000 : 15000);
    return () => window.clearInterval(timer);
  }, [summary.items.length, hasCountdown]);

  if (!summary.total) return null;

  const startAssumptionEdit = (item) => {
    setAssumptionEditId(item.interactionId);
    setAssumptionDraft(String(item.assumption || ""));
  };

  const submitAssumption = async (item) => {
    const next = String(assumptionDraft || "").trim();
    if (!next) return;
    await onAssume?.(item, next);
    setAssumptionEditId("");
    setAssumptionDraft("");
  };

  return (
    <section className="interaction-dock" aria-label="待处理交互" aria-live="polite">
      <div className="interaction-dock-head">
        <Icon name="comment" size={12} />
        <span className="interaction-dock-title">待处理交互</span>
        <span className="interaction-dock-total">{summary.total} 个</span>
      </div>
      {summary.items.map((item, index) => (
        <div
          className="interaction-item"
          data-interaction-id={item.interactionId}
          key={item.interactionId}
          tabIndex={-1}
        >
          <span className="interaction-item-index">第 {index + 1}/{summary.total} 个</span>
          <Icon name={KIND_ICONS[item.kind] || "comment"} size={12} />
          <span className={`interaction-item-kind kind-${item.kind || "clarify"}`}>{kindLabel(item.kind)}</span>
          <span className="interaction-item-question" title={questionText(item)}>{questionText(item)}</span>
          {countdownText(item, now) && (
            <span className="interaction-item-countdown" role="timer">{countdownText(item, now)}</span>
          )}
          {item.assumption && (
            <button
              type="button"
              className="interaction-item-assume"
              title={`默认假设：${item.assumption}`}
              onClick={() => startAssumptionEdit(item)}
            >改一下</button>
          )}
          {(item.kind === "clarify" || item.kind === "review") && (
            <button
              type="button"
              className="btn-xs interaction-item-skip"
              disabled={busy}
              onClick={() => onSettle?.(item, { skip: true })}
            >跳过</button>
          )}
          <button
            type="button"
            className="btn-xs interaction-item-primary"
            disabled={busy}
            onClick={() => onLocate?.(item)}
          >{primaryActionLabel(item)}</button>
          {assumptionEditId === item.interactionId && (
            <div className="interaction-assumption-edit">
              <input
                className="interaction-assumption-input"
                value={assumptionDraft}
                placeholder="修改默认假设…"
                onChange={(event) => setAssumptionDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void submitAssumption(item); }
                  if (event.key === "Escape") { event.preventDefault(); setAssumptionEditId(""); }
                }}
              />
              <button type="button" className="btn-xs" disabled={busy || !assumptionDraft.trim()} onClick={() => void submitAssumption(item)}>保存</button>
              <button type="button" className="btn-xs" onClick={() => setAssumptionEditId("")}>取消</button>
            </div>
          )}
        </div>
      ))}
      {summary.total > summary.items.length && (
        <div className="interaction-dock-more" role="status">
          另有 {summary.total - summary.items.length} 个待处理交互，处理后依次显示
        </div>
      )}
    </section>
  );
}
