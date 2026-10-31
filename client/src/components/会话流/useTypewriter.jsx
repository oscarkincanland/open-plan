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

/** 打字机文本组件：供 map 渲染场景使用（hook 不能在循环里调用）。 */
export function TypewriterText({ text, enabled = false, className = "" }) {
  const shown = useTypewriter(text, { enabled });
  return <div className={className} aria-live="polite">{String(text || "").slice(0, shown)}</div>;
}
