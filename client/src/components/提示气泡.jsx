import React, {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * 统一名称提示（DESIGN §5.8）。
 * - 纯图标按钮悬停约 300ms 显示，键盘聚焦立即显示；
 * - 提示为补充信息，按钮仍必须保留 aria-label；
 * - 使用 portal + fixed 定位，避免被 overflow:hidden 容器裁切；
 * - 减少动效或关闭动效时不做入场动画。
 */
const 合并事件 = (原处理, 新处理) => (事件) => {
  原处理?.(事件);
  新处理?.(事件);
};

export default function 提示气泡({ label, children, placement = "top", delay = 300, disabled = false }) {
  const 提示Id = useId().replace(/:/g, "");
  const [显示, set显示] = useState(false);
  const [位置, set位置] = useState({ top: -9999, left: -9999 });
  const 锚点 = useRef(null);
  const 气泡 = useRef(null);
  const 计时 = useRef(0);
  const 文本 = String(label || "").trim();
  const 子节点 = isValidElement(children) ? children : null;

  const 隐藏 = useCallback(() => {
    window.clearTimeout(计时.current);
    set显示(false);
  }, []);

  const 立即显示 = useCallback(() => {
    if (disabled || !文本) return;
    window.clearTimeout(计时.current);
    set显示(true);
  }, [disabled, 文本]);

  const 延迟显示 = useCallback(() => {
    if (disabled || !文本) return;
    window.clearTimeout(计时.current);
    计时.current = window.setTimeout(() => set显示(true), delay);
  }, [delay, disabled, 文本]);

  useEffect(() => () => window.clearTimeout(计时.current), []);

  useEffect(() => {
    if (!显示) return undefined;
    const 关闭 = () => 隐藏();
    const 键盘 = (事件) => { if (事件.key === "Escape") 隐藏(); };
    window.addEventListener("scroll", 关闭, true);
    window.addEventListener("resize", 关闭);
    window.addEventListener("keydown", 键盘);
    return () => {
      window.removeEventListener("scroll", 关闭, true);
      window.removeEventListener("resize", 关闭);
      window.removeEventListener("keydown", 键盘);
    };
  }, [显示, 隐藏]);

  useLayoutEffect(() => {
    if (!显示 || !锚点.current || !气泡.current) return;
    const 锚 = 锚点.current.getBoundingClientRect();
    const 泡 = 气泡.current.getBoundingClientRect();
    const 间距 = 6;
    let top = placement === "bottom" ? 锚.bottom + 间距 : 锚.top - 泡.height - 间距;
    if (placement === "top" && top < 8) top = 锚.bottom + 间距;
    if (placement === "bottom" && top + 泡.height > window.innerHeight - 8) top = 锚.top - 泡.height - 间距;
    const left = Math.min(Math.max(8, 锚.left + 锚.width / 2 - 泡.width / 2), window.innerWidth - 泡.width - 8);
    set位置({ top, left });
  }, [显示, placement, 文本]);

  if (!子节点) return children;

  const 子属性 = 子节点.props;
  const 合并Ref = (节点) => {
    锚点.current = 节点;
    const 原Ref = 子节点.ref;
    if (typeof 原Ref === "function") 原Ref(节点);
    else if (原Ref) 原Ref.current = 节点;
  };

  const 触发器 = cloneElement(子节点, {
    ref: 合并Ref,
    onMouseEnter: 合并事件(子属性.onMouseEnter, 延迟显示),
    onMouseLeave: 合并事件(子属性.onMouseLeave, 隐藏),
    onFocus: 合并事件(子属性.onFocus, 立即显示),
    onBlur: 合并事件(子属性.onBlur, 隐藏),
    onKeyDown: 合并事件(子属性.onKeyDown, (事件) => { if (事件.key === "Escape") 隐藏(); }),
    "aria-describedby": 显示 ? 提示Id : 子属性["aria-describedby"],
  });

  return (
    <>
      {触发器}
      {显示 && createPortal(
        <div ref={气泡} id={提示Id} role="tooltip" className="op-tooltip" style={{ top: 位置.top, left: 位置.left }}>
          {文本}
        </div>,
        document.body,
      )}
    </>
  );
}
