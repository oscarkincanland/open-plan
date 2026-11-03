import React, { useEffect, useRef, useState } from "react";
import { isMotionReduced } from "../../界面外观.js";
import { advanceTypewriter } from "../../会话流投影.js";

/**
 * 打字机 hook（精修计划 2026-10-31-002 F2）：
 * enabled=true 时按 rAF 逐字揭示 fullText（复用 计算展示字符数 的节奏与积压追赶）；
 * enabled=false（流结束/历史回放）直接返回全文，不播动画。
 */
export default function useTypewriter(fullText, { enabled = false } = {}) {
  const total = String(fullText || "");
  const [shown, setShown] = useState(() => (enabled ? 0 : total.length));
  const shownRef = useRef(shown);

  useEffect(() => {
    if (!enabled) {
      shownRef.current = total.length;
      setShown(total.length);
      return undefined;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now) => {
      const next = advanceTypewriter(total, shownRef.current, now - last, isMotionReduced());
      last = now;
      if (next !== shownRef.current) {
        shownRef.current = next;
        setShown(next);
      }
      if (next < total.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total, enabled]);

  return shown;
}

/**
 * 打字机文本组件（hook 不能在循环里调用，故单独封装）。
 * autoScroll=true 时随每次揭示把独立滚动容器跟到尾部（思考过程跟随最新一行）；
 * 用户主动向上翻阅时暂停跟随，滚回底部后自动恢复。
 */
export function TypewriterText({ text, enabled = false, className = "", autoScroll = false }) {
  const shown = useTypewriter(text, { enabled });
  const scrollRef = useRef(null);
  const followTailRef = useRef(true);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!autoScroll || !el || !followTailRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [shown, autoScroll]);
  return (
    <div
      ref={scrollRef}
      className={className}
      onScroll={autoScroll ? handleScroll : undefined}
      aria-live="polite"
    >
      {String(text || "").slice(0, shown)}
    </div>
  );
}
