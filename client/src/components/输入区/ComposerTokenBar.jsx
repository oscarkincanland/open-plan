import React, { useEffect, useRef, useState } from "react";
import Icon from "../Icon.jsx";

/**
 * 输入区 token 行（计划 2026-11-11-005）。
 *
 * 把「图片 / 附件 / 引用」三类在输入框之外的裸 chip 收进输入卡内部，
 * 统一渲染成只读小 tab：`[类型图标] 短名 [×]`，完整信息走 title。
 * 忙碌时同一行右侧再放「新输入投递方式」控件（立即执行 / 排队执行 / 注入上下文），
 * 替代原先常驻一整行的「当前任务中新输入：」三按钮条。
 *
 * 组件保持无状态：token 由 ChatPanel 归一后传入，删除/打开都通过回调交回 ChatPanel，
 * 不在这里解析引用标记，也不直接调用发送接口。
 */

/** 投递方式元数据：与发送按钮的图标/短标签同一份事实。 */
export const BUSY_DELIVERY_MODES = Object.freeze([
  { mode: "steer", label: "立即执行", short: "立即", icon: "send", hint: "打断当前回合，立即执行新指令" },
  { mode: "queue", label: "排队执行", short: "排队", icon: "list", hint: "本轮完成后自动开始" },
  { mode: "context", label: "注入上下文", short: "注入", icon: "layers", hint: "保存到下一轮，不打断当前任务" },
]);

export function busyDeliveryMeta(mode = "queue") {
  return BUSY_DELIVERY_MODES.find((item) => item.mode === mode) || BUSY_DELIVERY_MODES[1];
}

/** 忙碌态投递方式：折叠为一个 chip，点开向上弹出三选一。 */
export function BusyDeliveryControl({ mode = "queue", onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = busyDeliveryMeta(mode);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (next) => {
    setOpen(false);
    if (next !== mode) onChange?.(next);
  };

  return (
    <div className={`busy-delivery ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="busy-delivery-trigger"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`当前任务中新输入：${current.label}（点击切换投递方式）`}
        title={`当前任务中新输入：${current.hint}；点击切换投递方式`}
      >
        <Icon name={current.icon} size={12} />
        <span>{current.short}</span>
        <Icon name="chevronDown" size={10} className="busy-delivery-chevron" />
      </button>
      {open && (
        <div className="busy-delivery-menu" role="menu" aria-label="新输入投递方式">
          {BUSY_DELIVERY_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="menuitemradio"
              aria-checked={item.mode === mode}
              className={item.mode === mode ? "on" : ""}
              onClick={() => pick(item.mode)}
            >
              <Icon name={item.icon} size={12} />
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * token：{ key, icon, label, meta?, thumb?, title?, onRemove?, onClick? }
 * kind 只用于样式微调（image / file / reference）。
 */
function ComposerToken({ token }) {
  const { icon, label, meta, thumb, title, onRemove, onClick, kind } = token;
  return (
    <span className={`composer-token ${kind || "file"}`} title={title || label}>
      {thumb ? <img className="composer-token-thumb" src={thumb} alt="" /> : <Icon name={icon} size={12} />}
      {onClick ? (
        <button type="button" className="composer-token-label" onClick={onClick} title={title || label}>{label}</button>
      ) : (
        <span className="composer-token-label">{label}</span>
      )}
      {meta ? <span className="composer-token-meta">{meta}</span> : null}
      {onRemove ? (
        <button type="button" className="composer-token-remove" onClick={onRemove} aria-label={`移除 ${label}`} title={`移除 ${label}`}>
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </span>
  );
}

export default function ComposerTokenBar({
  tokens = [],
  busy = false,
  busyMode = "queue",
  onBusyModeChange,
  className = "",
}) {
  if (!tokens.length && !busy) return null;
  return (
    <div className={`composer-token-bar ${className}`.trim()} role="group" aria-label="本轮随输入发送的材料">
      {tokens.map((token) => <ComposerToken key={token.key} token={token} />)}
      <span className="composer-token-spacer" />
      {busy ? <BusyDeliveryControl mode={busyMode} onChange={onBusyModeChange} /> : null}
    </div>
  );
}
