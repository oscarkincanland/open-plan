import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";
import { runFoldBatch, runUnfoldBatch } from "../../会话流/折叠驱动.js";
import { prefersReducedMotion } from "../../界面外观.js";

let foldSeq = 0;

/** 收起动画结束后再置 hidden 的延迟（略大于折叠总时长 160ms）。 */
const SETTLE_HIDE_MS = 260;

/**
 * 一轮 Run 的过程折叠头（会话流前端规范 §2.1 + ADR 0014）。
 *
 * 折叠的是过程，不是答案：时间流与系统提示聚合进入 children，收成一行；
 * 结论正文、产物卡、未决 ask/审批、需行动提示都由调用方渲染在折叠体之外。
 *
 * 约定：
 * - 运行中不渲染本组件（ChatPanel 直铺时间流），因此组件挂载即代表终态；
 * - 展开态不持久化，切会话/刷新回到默认折叠（规范 §8「历史回放不重播」）；
 * - 收起时把焦点交回头部，避免焦点掉进不可见区域；
 * - 折叠指示只用 Icon（字符三角会被界面一致性守护拦下），也不新增无限动画。
 *
 * v3（计划 2026-11-14-001 / OAW_TRANSCRIPT_V3）：折叠体改为「高度驱动 + 解析式滚动补偿」，
 * 由 `折叠驱动.js` 接管；关闭时完全走既有的 grid-template-rows 过渡（基线逐字等价）。
 */
export default function RunFoldBar({
  state = "ok",
  label = "",
  steps = 0,
  pendingLabel = "",
  defaultOpen = false,
  v3 = false,
  scrollRef = null,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  // v3：收起动画结束后再置 hidden="until-found"，让 Cmd+F 能命中折叠内容。
  const [settledHidden, setSettledHidden] = useState(false);
  const headRef = useRef(null);
  const bodyRef = useRef(null);
  const outerRef = useRef(null);
  const busyRef = useRef(false);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `run-fold-${++foldSeq}`;

  // 收起时如果焦点还留在折叠体内，交回头部，避免焦点掉进不可见区域。
  useEffect(() => {
    if (open) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active && bodyRef.current && bodyRef.current.contains(active)) headRef.current?.focus();
  }, [open]);

  // v3：收起态由内联高度控制，展开态交回 CSS 自然高度。
  // 这里只管高度/透明度；hidden 属性由下一个 effect 单独负责（避免动画期间被 display:none 掐断）。
  useLayoutEffect(() => {
    if (!v3) return;
    const el = outerRef.current;
    if (!el) return;
    if (open) {
      el.style.height = "";
      el.style.opacity = "";
    } else if (!busyRef.current) {
      el.style.height = "0px";
      el.style.opacity = "0";
    }
  }, [v3, open]);

  // v3：hidden="until-found" 用 DOM API 设置——React 18 把 hidden 当布尔属性，
  // 字符串会被压成 hidden=""，浏览器查找就无法命中收起内容。
  useLayoutEffect(() => {
    if (!v3) return undefined;
    const el = outerRef.current;
    if (!el) return undefined;
    if (settledHidden) el.setAttribute("hidden", "until-found");
    else el.removeAttribute("hidden");
    return undefined;
  }, [v3, settledHidden]);

  // v3：不展开时，等折叠动画落定再把 settledHidden 置真。
  useEffect(() => {
    if (!v3) return undefined;
    if (open) {
      setSettledHidden(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettledHidden(true), SETTLE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [v3, open]);

  const toggle = async () => {
    if (busyRef.current) return;
    if (!v3) {
      setOpen((value) => !value);
      return;
    }
    const el = outerRef.current;
    if (!el) {
      setOpen((value) => !value);
      return;
    }
    busyRef.current = true;
    setSettledHidden(false);
    const reduced = prefersReducedMotion();
    // 滚动容器：优先外部传入的 ref；否则就近找会话滚动层（.chat-body）。
    // 用 closest 而不是要求调用方层层透传 ref——RunFoldBar 既在 ChatPanel 也在 Message 内使用。
    const scroller = scrollRef?.current || el.closest?.(".chat-body") || null;
    try {
      if (open) {
        await runFoldBatch({ bodyEl: el, scroller, reducedMotion: reduced });
        setOpen(false);
      } else {
        el.style.height = "0px";
        el.style.opacity = "0";
        await runUnfoldBatch({ bodyEl: el, reducedMotion: reduced });
        setOpen(true);
      }
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <div className={`run-fold is-${state}${open ? " open" : ""}${v3 ? " run-fold-v3" : ""}`}>
      <button
        type="button"
        className="run-fold-head"
        aria-expanded={open}
        aria-controls={idRef.current}
        onClick={toggle}
        ref={headRef}
      >
        <span className={`run-fold-dot ${state}`} aria-hidden="true" />
        <span className="run-fold-label">{label}</span>
        {steps > 0 && <span className="run-fold-steps">· {steps} 步</span>}
        {pendingLabel && <span className="run-fold-pending">{pendingLabel}</span>}
        <span className="run-fold-chev" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
      </button>
      <div
        className="run-fold-body"
        id={idRef.current}
        aria-hidden={open ? undefined : true}
        ref={outerRef}
      >
        <div className="run-fold-inner" ref={bodyRef}>{children}</div>
      </div>
    </div>
  );
}
