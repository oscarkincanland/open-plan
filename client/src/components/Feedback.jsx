import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

/**
 * 统一反馈基座（交互评审 P0-1 / N1 修正案）。
 *
 * - notify* / askConfirm 是全项目唯一的反馈入口；client/src 其余文件禁止直接调用
 *   window.alert / window.confirm（构建期由 grep 断言守护）。
 * - 应用内 toast / 确认 / 文本输入已成为默认体验；FeedbackHost 未挂载的极早期
 *   场景才回退原生弹窗。运行开关 feedbackV2 仅保留兼容，不再决定默认路径。
 * - 本文件是原生 alert/confirm/prompt 的唯一白名单落点。
 */

const TONE_META = {
  error: { icon: "warning", className: "fb-toast-error" },
  success: { icon: "check", className: "fb-toast-success" },
  warn: { icon: "info", className: "fb-toast-warn" },
};
const TOAST_TTL_MS = 3200;
const MAX_TOASTS = 4;

let pushToastExternal = null;
let askConfirmExternal = null;
let askTextExternal = null;

function nativeText(message) {
  return String(message ?? "");
}

/** 错误类反馈（替代 alert）。 */
export function notifyError(message) {
  if (pushToastExternal) pushToastExternal({ tone: "error", message: nativeText(message) });
  else window.alert(nativeText(message));
}

/** 成功类反馈（替代成功语义的 alert）。 */
export function notifySuccess(message) {
  if (pushToastExternal) pushToastExternal({ tone: "success", message: nativeText(message) });
  else window.alert(nativeText(message));
}

/** 警告类反馈。 */
export function notifyWarn(message) {
  if (pushToastExternal) pushToastExternal({ tone: "warn", message: nativeText(message) });
  else window.alert(nativeText(message));
}

/** 确认类反馈（替代 confirm），返回 Promise<boolean>。 */
export function askConfirm(message) {
  const text = nativeText(message);
  if (askConfirmExternal) return askConfirmExternal(text);
  return Promise.resolve(window.confirm(text));
}

/**
 * 文本输入反馈（替代 prompt），返回 Promise<string|null>：
 * 取消返回 null；确定返回输入内容（可为空串）。
 */
export function askText(message, defaultValue = "") {
  const text = nativeText(message);
  if (askTextExternal) return askTextExternal(text, String(defaultValue ?? ""));
  return Promise.resolve(window.prompt(text, String(defaultValue ?? "")));
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="fb-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => {
        const meta = TONE_META[t.tone] || TONE_META.warn;
        return (
          <div key={t.id} className={`fb-toast ${meta.className}`}>
            <Icon name={meta.icon} size={14} />
            <span className="fb-toast-text">{t.message}</span>
            <button type="button" className="fb-toast-close" title="关闭" aria-label="关闭提示" onClick={() => onDismiss(t.id)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ConfirmDialog({ pending, onResolve }) {
  if (!pending) return null;
  return (
    <div className="fb-confirm-backdrop" onClick={() => onResolve(false)}>
      <div className="fb-confirm" role="alertdialog" aria-modal="true" aria-label="确认操作" onClick={(e) => e.stopPropagation()}>
        <div className="fb-confirm-body">{pending.message}</div>
        <div className="fb-confirm-actions">
          <button type="button" className="fb-btn" onClick={() => onResolve(false)}>取消</button>
          <button type="button" className="fb-btn fb-btn-danger" autoFocus onClick={() => onResolve(true)}>确定</button>
        </div>
      </div>
    </div>
  );
}

function TextDialog({ pending, onResolve }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (pending) setValue(pending.defaultValue || "");
  }, [pending]);
  if (!pending) return null;
  return (
    <div className="fb-confirm-backdrop" onClick={() => onResolve(null)}>
      <form
        className="fb-confirm fb-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={pending.message || "输入"}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onResolve(value); }}
      >
        <div className="fb-confirm-body">{pending.message}</div>
        <input
          className="fb-prompt-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <div className="fb-confirm-actions">
          <button type="button" className="fb-btn" onClick={() => onResolve(null)}>取消</button>
          <button type="submit" className="fb-btn fb-btn-primary">确定</button>
        </div>
      </form>
    </div>
  );
}

export default function FeedbackHost() {
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState(null);
  const [pendingText, setPendingText] = useState(null);
  const seqRef = useRef(0);
  const pendingResolveRef = useRef(null);
  const pendingTextResolveRef = useRef(null);

  useEffect(() => {
    pushToastExternal = ({ tone, message }) => {
      const id = ++seqRef.current;
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, tone, message }]);
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_TTL_MS);
    };
    askConfirmExternal = (message) => new Promise((resolve) => {
      pendingResolveRef.current = resolve;
      setPending({ message });
    });
    askTextExternal = (message, defaultValue) => new Promise((resolve) => {
      pendingTextResolveRef.current = resolve;
      setPendingText({ message, defaultValue });
    });
    return () => {
      pushToastExternal = null;
      askConfirmExternal = null;
      askTextExternal = null;
    };
  }, []);

  const resolvePending = useCallback((value) => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    setPending(null);
    resolve?.(value);
  }, []);

  const resolvePendingText = useCallback((value) => {
    const resolve = pendingTextResolveRef.current;
    pendingTextResolveRef.current = null;
    setPendingText(null);
    resolve?.(value);
  }, []);

  useEffect(() => {
    if (!pendingText) return undefined;
    const onKey = (e) => { if (e.key === "Escape") resolvePendingText(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingText, resolvePendingText]);

  useEffect(() => {
    if (!pending) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") resolvePending(false);
      else if (e.key === "Enter") resolvePending(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, resolvePending]);

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
      <ConfirmDialog pending={pending} onResolve={resolvePending} />
      <TextDialog pending={pendingText} onResolve={resolvePendingText} />
    </>
  );
}
