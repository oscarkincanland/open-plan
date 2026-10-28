import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";

const PREVIEW_LIMIT = 200;

function previewText(item) {
  const raw = String(item?.rawText || item?.text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "（空消息）";
  return raw.length > PREVIEW_LIMIT ? `${raw.slice(0, PREVIEW_LIMIT)}…` : raw;
}

function queueLabel(item) {
  if (item?.status === "failed") return "失败";
  return item?.channel === "steer" ? "插话" : "排队";
}

/**
 * 消息队列坞（v0.12.x）。
 *
 * 只负责队列的展示与行内操作，不直接调用发送 API：
 * - 编辑/删除/提升/继续/清空全部通过回调交给 ChatPanel；
 * - 队列项是前端 UI 事实源，ChatPanel 在 dispatch 时才调用 /api/agent/prompt。
 */
export default function QueueDock({
  items = [],
  busy = false,
  compacting = false,
  onContinue,
  onEdit,
  onDelete,
  onPromote,
  onClear,
}) {
  const [collapsed, setCollapsed] = useState(items.length > 1);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");
  const prevCountRef = useRef(items.length);

  useEffect(() => {
    const previous = prevCountRef.current;
    prevCountRef.current = items.length;
    if (items.length === 0) {
      setEditingId(null);
      setCollapsed(false);
      return;
    }
    // 从 1 条增长到多条时默认折叠，符合 AVA 的“计数头默认收起”；
    // 用户手动展开后不再强行收起。
    if (items.length > 1 && previous <= 1) setCollapsed(true);
  }, [items.length]);

  useEffect(() => {
    if (editingId && !items.some((item) => item.id === editingId)) setEditingId(null);
  }, [items, editingId]);

  const expanded = !collapsed || items.length <= 1 || Boolean(editingId);
  const countLabel = useMemo(() => `${items.length} 条排队消息`, [items.length]);

  if (!items.length) return null;

  const startEdit = (item) => {
    setEditingId(item.id);
    setDraft(String(item.rawText || item.text || ""));
    setCollapsed(false);
  };

  const saveEdit = () => {
    if (!editingId) return;
    const value = String(draft || "").trim();
    if (!value) return;
    onEdit?.(editingId, value);
    setEditingId(null);
    setDraft("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  return (
    <section className={`chat-queue-dock ${expanded ? "open" : ""}`} aria-label="消息队列">
      <div className="chat-queue-head">
        <button
          type="button"
          className="chat-queue-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? "收起排队消息" : "展开排队消息"}
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
          <Icon name="list" size={12} />
          <span>{countLabel}</span>
          {items.some((item) => item.status === "failed") && <em>有失败项</em>}
        </button>
        <div className="chat-queue-head-actions">
          {!busy && !compacting && (
            <button type="button" onClick={() => onContinue?.()} title="按顺序继续执行队列">继续队列</button>
          )}
          <button type="button" className="danger" onClick={() => onClear?.()} title="清空全部排队消息">清空</button>
        </div>
      </div>

      {expanded && (
        <div className="chat-queue-list" role="list">
          {items.map((item) => {
            const editing = editingId === item.id;
            const images = Array.isArray(item.images) ? item.images : [];
            const attachments = Array.isArray(item.attachments) ? item.attachments : [];
            return (
              <div className={`chat-queue-item ${item.status === "failed" ? "failed" : ""}`} role="listitem" key={item.id}>
                <span className={`chat-queue-channel ${item.channel === "steer" ? "steer" : "queue"}`} title={item.channel === "steer" ? "插话：等待注入" : "排队：会话结束后自动发送"}>
                  <Icon name={item.channel === "steer" ? "send" : "list"} size={12} />
                  {queueLabel(item)}
                </span>

                {editing ? (
                  <textarea
                    className="chat-queue-edit"
                    value={draft}
                    autoFocus
                    rows={2}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        saveEdit();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEdit();
                      }
                    }}
                    aria-label="编辑排队消息"
                  />
                ) : (
                  <span className="chat-queue-preview" title={item.rawText || item.text || ""}>{previewText(item)}</span>
                )}

                <span className="chat-queue-media" aria-hidden={images.length + attachments.length === 0}>
                  {images.slice(0, 3).map((image, index) => (
                    <img key={`${item.id}:img:${index}`} src={image.dataUrl} alt="" />
                  ))}
                  {attachments.length > 0 && (
                    <span className="chat-queue-file" title={attachments.map((file) => file.name).join("、")}>
                      <Icon name="file" size={12} /> {attachments.length}
                    </span>
                  )}
                </span>

                <span className="chat-queue-actions">
                  {editing ? (
                    <>
                      <button type="button" onClick={saveEdit} disabled={!draft.trim()} title="保存（Enter）"><Icon name="check" size={12} /></button>
                      <button type="button" onClick={cancelEdit} title="放弃（Esc）"><Icon name="close" size={12} /></button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => startEdit(item)} title="编辑排队消息"><Icon name="penTool" size={12} /></button>
                      <button
                        type="button"
                        onClick={() => onPromote?.(item.id)}
                        disabled={compacting}
                        title={item.status === "failed" ? "重试发送" : busy ? "中断当前回合并立即发送" : "立即发送"}
                      >
                        <Icon name={item.status === "failed" ? "refresh" : "send"} size={12} />
                      </button>
                      <button type="button" className="danger" onClick={() => onDelete?.(item.id)} title="删除排队消息"><Icon name="trash" size={12} /></button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
