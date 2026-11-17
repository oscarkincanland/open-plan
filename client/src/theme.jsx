import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { isMotionReduced } from "./界面外观.js";

const THEME_KEY = "oaw_theme";
const THEMES = ["dark", "light"];
const SKIN_KEY = "oaw_skin";
const SKINS = [
  { id: "proma", label: "Proma 清晰" },
  { id: "glass", label: "磨玻璃 · Open Plan" },
  { id: "default", label: "默认（青绿）" },
  { id: "ocean", label: "海洋蓝" },
  { id: "forest", label: "森林绿" },
  { id: "sunset", label: "暖橙" },
  { id: "violet", label: "紫罗兰" },
];

const ThemeContext = createContext({ theme: "dark", setTheme: () => {}, skin: "default", setSkin: () => {} });

/**
 * 把主题与皮肤写到 <html> 的 data-*（计划 2026-11-18-001）。
 * - `document.startViewTransition` 可用且动效闸门未命中（系统减少动效 / 外观"关闭动效"）时，
 *   经 View Transition 平滑交叉淡入；否则与旧行为一致瞬时写入。
 * - 值未变化时直接跳过：首帧已由 index.html 预置，挂载时的重复写入不得再开过渡
 *   （G1 冒烟实证：连续两次 startViewTransition 会互相 skip 并产生未处理 rejection）。
 * - 新过渡启动会 skip 旧过渡，旧过渡的 ready/finished 以 rejection 结束，必须显式吞掉。
 * - localStorage 持久化不进过渡回调（调用方自行处理），保证刷新语义始终同步。
 */
function applyDocumentAttributes({ theme, skin }) {
  const root = document.documentElement;
  if (root.getAttribute("data-theme") === theme && root.getAttribute("data-skin") === skin) return;
  const write = () => {
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-skin", skin);
  };
  if (
    typeof document.startViewTransition === "function" &&
    !isMotionReduced() &&
    document.visibilityState !== "hidden"
  ) {
    // 文档隐藏时没有渲染机会，过渡回调会被浏览器推迟到重新可见（E2E 实测后台标签页延迟数秒），
    // 此时直接写入、落定即可。
    const transition = document.startViewTransition(write);
    transition.ready?.catch(() => {});
    transition.finished?.catch(() => {});
  } else {
    write();
  }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.includes(saved) ? saved : "dark";
    } catch {
      return "dark";
    }
  });
  const [skin, setSkinState] = useState(() => {
    try {
      const saved = localStorage.getItem(SKIN_KEY);
      return SKINS.some((s) => s.id === saved) ? saved : "default";
    } catch {
      return "default";
    }
  });

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const skinRef = useRef(skin);
  skinRef.current = skin;

  // 主题/皮肤写入统一走 applyDocumentAttributes：动效可用时经 View Transition 平滑过渡，
  // 系统减少动效或外观设置"关闭动效"时瞬时落定（计划 2026-11-18-001）。
  // 两个 effect 都写全量属性（幂等），保证任一变化时另一个使用当前值而非旧闭包值。
  useEffect(() => {
    applyDocumentAttributes({ theme: themeRef.current, skin: skinRef.current });
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  useEffect(() => {
    applyDocumentAttributes({ theme: themeRef.current, skin: skinRef.current });
    try { localStorage.setItem(SKIN_KEY, skin); } catch {}
  }, [skin]);

  const setTheme = useCallback((t) => {
    if (THEMES.includes(t)) setThemeState(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const setSkin = useCallback((s) => {
    if (SKINS.some((x) => x.id === s)) setSkinState(s);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, skin, setSkin }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
export { SKINS };
