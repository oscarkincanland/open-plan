import React, { useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";

let foldSeq = 0;

/**
 * 一轮 Run 的过程折叠头（会话流前端规范 §2.1 + ADR 0014）。
 *
 * 折叠的是过程，不是答案：时间流与系统提示聚合进入 children，收成一行；
 * 结论正文、产物卡、未决 ask/审批、需行动提示都由调用方渲染在折叠体之外。
 *
 * 约定：
 * - 运行中不渲染本组件（ChatPanel 直铺时间流），因此组件挂载即代表终态；
 * - 展开态不持久化，切会话/刷新回到默认折叠（规范 §8「历史回放不重播」）；
 * - 折叠态用 visibility: hidden 把内部按钮移出 Tab 序列，收起时把焦点交回头部；
 * - 折叠指示只用 Icon（字符三角会被界面一致性守护拦下），也不新增无限动画。
 */
export default function RunFoldBar({
  state = "ok",
  label = "",
  steps = 0,
  pendingLabel = "",
  defaultOpen = false,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headRef = useRef(null);
  const bodyRef = useRef(null);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `run-fold-${++foldSeq}`;

  // 收起时如果焦点还留在折叠体内，交回头部，避免焦点掉进不可见区域。
  useEffect(() => {
    if (open) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active && bodyRef.current && bodyRef.current.contains(active)) headRef.current?.focus();
  }, [open]);

  return (
    <div className={`run-fold is-${state}${open ? " open" : ""}`}>
      <button
        type="button"
        className="run-fold-head"
        aria-expanded={open}
        aria-controls={idRef.current}
        onClick={() => setOpen((value) => !value)}
        ref={headRef}
      >
        <span className={`run-fold-dot ${state}`} aria-hidden="true" />
        <span className="run-fold-label">{label}</span>
        {steps > 0 && <span className="run-fold-steps">{steps} 步</span>}
        {pendingLabel && <span className="run-fold-pending">{pendingLabel}</span>}
        <span className="run-fold-chev" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
      </button>
      <div
        className="run-fold-body"
        id={idRef.current}
        aria-hidden={open ? undefined : true}
      >
        <div className="run-fold-inner" ref={bodyRef}>{children}</div>
      </div>
    </div>
  );
}
