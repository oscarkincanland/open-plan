import React, { useEffect, useRef } from "react";
import Icon from "./Icon.jsx";

/**
 * 右键菜单组件
 */
export default function ContextMenu({ x, y, items, onClose, autoFocus = false }) {
  const menuRef = useRef(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    const handleEscape = (e) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    if (!autoFocus) return;
    const first = itemRefs.current.find((node) => node && !node.classList.contains("disabled"));
    first?.focus();
  }, [autoFocus]);

  const handleKeyDown = (event) => {
    const enabled = itemRefs.current.filter((node) => node && !node.classList.contains("disabled"));
    if (!enabled.length) return;
    const activeIndex = enabled.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (activeIndex + delta + enabled.length) % enabled.length;
      enabled[next]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? enabled[0] : enabled[enabled.length - 1])?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      document.activeElement?.click?.();
    }
  };

  // 调整位置，防止超出屏幕
  const adjustedX = Math.min(x, window.innerWidth - 200);
  const adjustedY = Math.min(y, window.innerHeight - items.length * 36 - 20);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: adjustedX, top: adjustedY }}
      role="menu"
      onKeyDown={handleKeyDown}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} className="context-menu-separator" />;
        }
        return (
          <div
            key={i}
            ref={(node) => { itemRefs.current[i] = node; }}
            role="menuitem"
            tabIndex={item.disabled ? -1 : 0}
            className={`context-menu-item ${item.disabled ? "disabled" : ""} ${item.danger ? "danger" : ""}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
          >
            {item.icon && <span className="context-menu-icon"><Icon name={item.icon} size={14} /></span>}
            <span className="context-menu-text">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}
