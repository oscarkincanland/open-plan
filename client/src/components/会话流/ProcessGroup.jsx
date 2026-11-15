import React, { useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";

let groupSeq = 0;

/**
 * 过程组（计划 2026-11-14-001 阶段 5 / 对标 DSH `ChatGroupSeat`）。
 *
 * 把连续的思考/工具调用收敛成一行组头：运行中显示实时活动（"正在执行命令 · npm test"），
 * 结束后显示类别摘要（"已读取文件并搜索代码"）。组体默认收起（运行中默认展开），
 * 与 DSH 的"标准展示模式"一致。
 *
 * 约定：
 * - 只做显隐，不做高度动画（DSH 同样不给组级展开做 height 过渡），避免与折叠帧钟叠加；
 * - 组头不出现无限动画以外的装饰；运行态点由 CSS 负责；
 * - 收起时用 `hidden="until-found"` 让浏览器查找（Cmd+F）仍能命中组内文字。
 */
export default function ProcessGroup({ label = "", count = 0, running = false, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const idRef = useRef(null);
  const bodyRef = useRef(null);
  if (idRef.current === null) idRef.current = `tl-group-${++groupSeq}`;
  // 运行结束自动收起，与 DSH "完成后保留摘要、收起正文"一致；用户手动开的已结束组不受影响。
  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
  // React 18 把 hidden 当布尔属性，"until-found" 会被压成 hidden=""，
  // 浏览器查找（Cmd+F）就无法命中收起内容。这里显式走 DOM API。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (open) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "until-found");
  }, [open]);

  return (
    <div className={`tl-group${open ? " open" : ""}${running ? " is-live" : ""}`}>
      <button
        type="button"
        className="tl-group-head"
        aria-expanded={open}
        aria-controls={idRef.current}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`tl-group-dot${running ? "" : " done"}`} aria-hidden="true" />
        <span className="tl-group-label">{label}</span>
        {count > 0 && <span className="tl-group-count">{count} 次</span>}
        <span className="tl-group-chev" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
      </button>
      <div className="tl-group-body" id={idRef.current} ref={bodyRef}>
        {children}
      </div>
    </div>
  );
}
