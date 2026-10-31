import React, { useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";

let rowSeq = 0;

/**
 * 时间线一行条目（落地文档 2026-10-31-001 §5.2）：
 * chevron + 语义图标 + 动作词 + 对象摘要 + 耗时 + 状态点，点击平滑展开明细。
 * 纯展示壳：明细内容由调用方以 children 传入（避免与 ChatPanel 内部组件形成循环依赖）。
 */
export default function TimelineRow({ icon, verb, obj = "", timeText = "", state = "", defaultOpen = false, showState = true, className = "", children }) {
  const [open, setOpen] = useState(defaultOpen);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `tl-row-${++rowSeq}`;
  return (
    <div className={`tl-row ${state ? `is-${state}` : ""} ${open ? "open" : ""} ${className}`.trim()}>
      <button
        type="button"
        className="tl-row-head"
        aria-expanded={open}
        aria-controls={idRef.current}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tl-chev" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
        {icon && <span className="tl-icon" aria-hidden="true"><Icon name={icon} size={13} /></span>}
        <span className="tl-verb">{verb}</span>
        {obj && <span className="tl-obj" title={obj}>{obj}</span>}
        {timeText && <span className="tl-time">{timeText}</span>}
        {showState && state && <span className={`tl-state ${state}`} aria-hidden="true" />}
      </button>
      <div className="tl-detail-wrap" aria-hidden={!open}>
        <div className="tl-detail" id={idRef.current}>{children}</div>
      </div>
    </div>
  );
}
