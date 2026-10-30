import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

// v0.13.1：GoalBar 只展示长期目标与操作入口，读写由 ChatPanel 统一负责。
// complete 后不渲染；无目标不占位（由父组件决定是否挂载）。
export const GOAL_STATUS_LABELS = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  max_turns: "达轮次上限",
  budget_limited: "达预算上限",
  complete: "已完成",
};

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(number);
}

export default function GoalBar({ goal, busy = false, openDetailsSignal = 0, onAction, onNotice }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal?.text || "");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(String(goal?.budgetTokens || 0));
  const [maxTurnsDraft, setMaxTurnsDraft] = useState(String(goal?.maxTurns || 0));
  const [pending, setPending] = useState("");
  const detailsRef = useRef(null);

  useEffect(() => {
    setDraft(goal?.text || "");
    setBudgetDraft(String(goal?.budgetTokens || 0));
    setMaxTurnsDraft(String(goal?.maxTurns || 0));
    setEditing(false);
  }, [goal?.goalId, goal?.text, goal?.budgetTokens, goal?.maxTurns]);

  useEffect(() => {
    if (openDetailsSignal > 0) setDetailsOpen(true);
  }, [openDetailsSignal]);

  useEffect(() => {
    if (!detailsOpen) return undefined;
    const close = (event) => {
      if (detailsRef.current && !detailsRef.current.contains(event.target)) setDetailsOpen(false);
    };
    const onKey = (event) => { if (event.key === "Escape") setDetailsOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [detailsOpen]);

  if (!goal || goal.status === "complete") return null;

  const runAction = async (action, payload = {}) => {
    if (pending || typeof onAction !== "function") return false;
    setPending(action);
    try {
      await onAction(action, payload);
      return true;
    } catch (error) {
      onNotice?.(error?.message || "目标操作失败");
      return false;
    } finally {
      setPending("");
    }
  };

  const statusLabel = GOAL_STATUS_LABELS[goal.status] || goal.status;
  const canEdit = !busy;
  const saveEdit = () => {
    const text = draft.trim();
    if (!text || text === String(goal.text || "").trim()) {
      setEditing(false);
      setDraft(goal.text || "");
      return;
    }
    void runAction("edit", { text }).then((ok) => { if (ok) setEditing(false); });
  };

  return (
    <div className={`chat-goal-bar status-${goal.status}`} role="region" aria-label="长期目标">
      <span className="chat-goal-status" aria-live="polite">{statusLabel}</span>
      {editing ? (
        <input
          className="chat-goal-edit"
          value={draft}
          autoFocus
          aria-label="编辑长期目标"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); saveEdit(); }
            if (event.key === "Escape") { event.preventDefault(); setEditing(false); setDraft(goal.text || ""); }
          }}
        />
      ) : (
        <span className="chat-goal-text" title={goal.text}>{goal.text}</span>
      )}
      <span className="chat-goal-stats" title="轮次 / Token / 活跃时长">
        {Number(goal.turns) || 0} 轮 · {formatTokens(goal.usedTokens)}{goal.budgetTokens > 0 ? ` / ${formatTokens(goal.budgetTokens)}` : ""} · {formatDuration(goal.activeMs)}
      </span>
      <div className="chat-goal-actions">
        {editing ? (
          <>
            <button type="button" className="btn-xs primary" onClick={saveEdit} disabled={pending === "edit"}>保存</button>
            <button type="button" className="btn-xs" onClick={() => { setEditing(false); setDraft(goal.text || ""); }}>取消</button>
          </>
        ) : (
          <>
            {goal.status === "active" && (
              <>
                <button type="button" className="btn-xs" onClick={() => runAction("pause")} disabled={Boolean(pending)}>暂停</button>
                <button type="button" className="btn-xs" onClick={() => runAction("complete")} disabled={Boolean(pending)}>完成</button>
              </>
            )}
            {(goal.status === "paused" || goal.status === "blocked") && (
              <button type="button" className="btn-xs primary" onClick={() => runAction("resume")} disabled={Boolean(pending)}>恢复</button>
            )}
            {goal.status === "max_turns" && (
              <button type="button" className="btn-xs primary" onClick={() => runAction("continue")} disabled={Boolean(pending)}>继续</button>
            )}
            {goal.status === "budget_limited" && (
              <button type="button" className="btn-xs primary" onClick={() => setDetailsOpen(true)} disabled={Boolean(pending)}>提高预算</button>
            )}
            <button type="button" className="btn-xs" onClick={() => setEditing(true)} disabled={!canEdit || Boolean(pending)} title="编辑目标文本">编辑</button>
            <button type="button" className="btn-xs" onClick={() => runAction("clear")} disabled={Boolean(pending)} title="清除长期目标">清除</button>
            <button
              type="button"
              className="btn-xs"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}
              title="目标详情与预算"
            >
              <Icon name="info" size={12} />
            </button>
          </>
        )}
      </div>
      {detailsOpen && (
        <div className="chat-goal-details" ref={detailsRef} role="dialog" aria-label="目标详情">
          <div className="chat-goal-detail-row"><span>状态</span><b>{statusLabel}</b></div>
          <div className="chat-goal-detail-row"><span>轮次</span><b>{Number(goal.turns) || 0}{goal.maxTurns > 0 ? ` / ${goal.maxTurns}` : ""}</b></div>
          <div className="chat-goal-detail-row"><span>Token</span><b>{formatTokens(goal.usedTokens)}{goal.budgetTokens > 0 ? ` / ${formatTokens(goal.budgetTokens)}` : ""}</b></div>
          <div className="chat-goal-detail-row"><span>活跃时长</span><b>{formatDuration(goal.activeMs)}</b></div>
          <label className="chat-goal-detail-field">
            <span>Token 预算（0 = 不限制）</span>
            <input type="number" min="0" step="1000" value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} />
          </label>
          <label className="chat-goal-detail-field">
            <span>最大轮次（0 = 不限制）</span>
            <input type="number" min="0" step="1" value={maxTurnsDraft} onChange={(event) => setMaxTurnsDraft(event.target.value)} />
          </label>
          <div className="chat-goal-detail-actions">
            <button
              type="button"
              className="btn-xs primary"
              disabled={Boolean(pending)}
              onClick={async () => {
                const budgetTokens = Math.max(0, Number.parseInt(budgetDraft, 10) || 0);
                const maxTurns = Math.max(0, Number.parseInt(maxTurnsDraft, 10) || 0);
                await runAction("budget", { budgetTokens, maxTurns });
                setDetailsOpen(false);
              }}
            >保存预算</button>
            <button type="button" className="btn-xs" onClick={() => setDetailsOpen(false)}>关闭</button>
          </div>
          <small>目标由本地 harness 记录，不改变 Pi 原生上下文；刷新后仍保留。</small>
        </div>
      )}
    </div>
  );
}
