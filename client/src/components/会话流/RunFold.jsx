import React, { useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";
import { formatDuration, verificationLabel } from "../../运行轨迹.js";

let foldSeq = 0;

const VERIFICATION_TONE = { passed: "success", warning: "warn", failed: "error", manual_review: "warn", pending: "muted" };

/**
 * 整轮折叠（落地文档 2026-10-31-001 §5.2 G1）：
 * 收起 = 一行「已运行 x 分 x 秒 · 工具 N · 文件 N · 验收状态」；
 * 运行中实时跳秒并展开跟随，结束后自动收起；时间流内容由调用方以 children 传入。
 */
export default function RunFold({ live = false, finishing = false, startedAt = null, durationMs = null, toolCount = 0, fileCount = 0, verification = "not_checked", liveAction = "", defaultOpen = false, children }) {
  const [open, setOpen] = useState(() => live || defaultOpen);
  const wasLiveRef = useRef(live);
  const [now, setNow] = useState(() => Date.now());
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `rf-body-${++foldSeq}`;

  // 运行开始自动展开；结束自动收起（用户随后可手动展开回看）。
  useEffect(() => {
    if (live && !wasLiveRef.current) setOpen(true);
    else if (!live && wasLiveRef.current) setOpen(false);
    wasLiveRef.current = live;
  }, [live]);

  // 运行中每秒刷新「已运行」秒数。
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const startMs = startedAt ? new Date(startedAt).getTime() : 0;
  const elapsedMs = live && startMs ? Math.max(0, now - startMs) : durationMs;
  // 极短/未知耗时统一显示「不足 1 秒」，不再出现「0 秒」（精修计划 2026-10-31-002 F7）。
  const fmt = (ms) => (Number(ms) >= 0 && Number(ms) < 1000 ? "不足 1 秒" : formatDuration(ms));
  const title = live
    ? (finishing ? `收尾中 · 已运行 ${fmt(elapsedMs)}` : `正在运行 · 已 ${fmt(elapsedMs)}`)
    : `已运行 ${fmt(elapsedMs)}`;
  const showVerification = verification !== "not_checked" || fileCount > 0;

  return (
    <div className={`rf-round ${live ? "is-live" : ""} ${open ? "open" : ""}`}>
      <button type="button" className="rf-head" aria-expanded={open} aria-controls={idRef.current} onClick={() => setOpen((value) => !value)}>
        <span className="rf-chev" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
        <span className="rf-title" role={live ? "status" : undefined}>{title}</span>
        <span className="rf-meta">
          {live && <span className="rf-live-dot" aria-hidden="true" />}
          {live && liveAction && <span className="rf-action" title={liveAction}>{liveAction}</span>}
          <span>工具 {toolCount}</span>
          {fileCount > 0 && <span>文件 {fileCount}</span>}
          {showVerification && (
            <span className={`rf-chip ${VERIFICATION_TONE[verification] || "muted"}`}>
              <Icon name="shield" size={12} />
              {verificationLabel(verification)}
            </span>
          )}
        </span>
      </button>
      <div className="rf-body" id={idRef.current} aria-hidden={!open}>
        <div className="rf-body-inner">
          <div className="rf-pad">{children}</div>
        </div>
      </div>
    </div>
  );
}
