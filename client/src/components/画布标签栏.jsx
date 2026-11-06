import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

/**
 * 工作区画布标签栏（浏览器式）。
 *
 * 只负责标签、+ 菜单与右侧动作；标签内容由 App 渲染。
 * 关闭标签与收起画布是两种语义：
 * - ×：销毁该标签；
 * - ⌄：隐藏画布但保留标签。
 */
export default function 画布标签栏({
  tabs = [],
  activeId = "",
  onActivate,
  onClose,
  onReorder,
  onCollapse,
  onToggleMaximize,
  maximized = false,
  onPlusAction,
  onSearch,
  onToggleFiles,
  filesOpen = false,
  onNewChat,
  showObjects = false,
  showWorkflows = false,
  browserActivityPing = 0,
  browserFullscreen = false,
  onToggleBrowserFullscreen,
  mapSessions = [],
  onOpenMapSession,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const activeTab = tabs.find((tab) => tab.id === activeId) || null;
  const menuRef = useRef(null);
  const plusRef = useRef(null);
  const overflowRef = useRef(null);
  const overflowButtonRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event) => {
      if (!menuRef.current?.contains(event.target) && !plusRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onPointerDown = (event) => {
      if (!overflowRef.current?.contains(event.target) && !overflowButtonRef.current?.contains(event.target)) setOverflowOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setOverflowOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowOpen]);

  const run = (action) => {
    setMenuOpen(false);
    onPlusAction?.(action);
  };

  const onTabbarKeyDown = (event) => {
    if (!tabs.length) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(Math.max(0, index) + delta + tabs.length) % tabs.length];
      if (next) onActivate?.(next.id);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Tab") {
      event.preventDefault();
      const delta = event.shiftKey ? -1 : 1;
      const next = tabs[(Math.max(0, index) + delta + tabs.length) % tabs.length];
      if (next) onActivate?.(next.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")) {
      if (!activeId) return;
      event.preventDefault();
      onClose?.(activeId);
    }
  };

  return (
    <div className="canvas-tabbar">
      <div className="canvas-tabbar-scroll" role="tablist" aria-label="工作区画布标签" onKeyDown={onTabbarKeyDown}>
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const isBrowser = tab.kind === "browser";
          return (
            <div
              key={tab.id}
              className={`canvas-tab ${active ? "active" : ""}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/canvas-tab", tab.id);
              }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
              onDrop={(event) => {
                event.preventDefault();
                const from = event.dataTransfer.getData("text/canvas-tab");
                if (from && from !== tab.id) onReorder?.(from, tab.id);
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="canvas-tab-main"
                onClick={() => onActivate?.(tab.id)}
                onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose?.(tab.id); } }}
                title={tab.title}
              >
                <Icon name={tab.icon || "file"} size={13} />
                <span className="canvas-tab-title">{tab.title || "未命名"}</span>
                {tab.badge !== undefined && tab.badge !== null && tab.badge !== "" && (
                  <span className="canvas-tab-badge" title={tab.badgeTitle || `活跃 ${tab.badge}`}>{tab.badge}</span>
                )}
                {tab.alert && <i className="canvas-tab-alert" title="团队需要关注" aria-label="团队需要关注" />}
                {tab.dirty && <i className="canvas-tab-dirty" title="有未保存修改" aria-label="有未保存修改" />}
                {isBrowser && browserActivityPing > 0 && !active && <i className="canvas-tab-dot" aria-hidden="true" />}
              </button>
              {tab.closable !== false && (
                <button
                  type="button"
                  className="canvas-tab-close"
                  onClick={(event) => { event.stopPropagation(); onClose?.(tab.id); }}
                  aria-label={`关闭 ${tab.title || "标签"}`}
                  title="关闭标签"
                >
                  <Icon name="close" size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="canvas-tabbar-actions">
        {tabs.length > 0 && (
          <button
            ref={overflowButtonRef}
            type="button"
            className={`canvas-action ${overflowOpen ? "active" : ""}`}
            onClick={() => setOverflowOpen((value) => !value)}
            aria-label="已打开标签"
            aria-expanded={overflowOpen}
            aria-haspopup="menu"
            title="已打开标签"
          >
            <Icon name="more" size={14} />
          </button>
        )}
        {overflowOpen && (
          <div className="canvas-plus-menu canvas-overflow-menu" role="menu" ref={overflowRef}>
            <div className="canvas-overflow-head">已打开标签 · {tabs.length}</div>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitem"
                className={tab.id === activeId ? "active" : ""}
                onClick={() => { setOverflowOpen(false); onActivate?.(tab.id); }}
                title={tab.title}
              >
                <Icon name={tab.icon || "file"} size={13} />
                <span className="canvas-overflow-title">{tab.title || "未命名"}</span>
                {tab.dirty && <i className="canvas-tab-dirty" aria-label="有未保存修改" />}
              </button>
            ))}
          </div>
        )}
        <button
          ref={plusRef}
          type="button"
          className={`canvas-action ${menuOpen ? "active" : ""}`}
          onClick={() => setMenuOpen((value) => !value)}
          aria-label="打开新视图"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="打开新视图"
        >
          <Icon name="plus" size={14} />
        </button>
        {menuOpen && (
          <div className="canvas-plus-menu" role="menu" ref={menuRef}>
            <button type="button" role="menuitem" className="canvas-plus-search" onClick={() => { setMenuOpen(false); onSearch?.(); }}>
              <Icon name="search" size={13} />
              <span>搜索文件名或命令</span>
              <kbd>Ctrl P</kbd>
            </button>
            <div className="canvas-plus-sep" role="separator" />
            <button type="button" role="menuitem" onClick={() => run("artifacts")}><Icon name="package" size={13} /> 任务摘要</button>
            <button type="button" role="menuitem" onClick={() => run("files")}><Icon name="folder" size={13} /> 文件</button>
            <button type="button" role="menuitem" onClick={() => run("browser")}><Icon name="globe" size={13} /> 浏览器</button>
            <button type="button" role="menuitem" onClick={() => run("changes")}><Icon name="history" size={13} /> 代码变更</button>
            {showObjects && <button type="button" role="menuitem" onClick={() => run("objects")}><Icon name="layers" size={13} /> 对象栏</button>}
            {showWorkflows && <button type="button" role="menuitem" onClick={() => run("workflows")}><Icon name="flow" size={13} /> 领域工作流</button>}
            {mapSessions.length > 0 && (
              <>
                <div className="canvas-plus-sep" role="separator" />
                <div className="canvas-overflow-head">最近地图会话</div>
                {mapSessions.map((session) => (
                  <button
                    key={session.id || session.threadId}
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onOpenMapSession?.(session); }}
                    title={session.title || session.label || "地图会话"}
                  >
                    <Icon name="map" size={13} />
                    <span className="canvas-overflow-title">{session.title || session.label || "地图会话"}</span>
                  </button>
                ))}
              </>
            )}
            <div className="canvas-plus-sep" role="separator" />
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNewChat?.(); }}><Icon name="chatPlus" size={13} /> 新建对话</button>
          </div>
        )}
        {activeTab?.kind === "browser" && (
          <button
            type="button"
            className={`canvas-action ${browserFullscreen ? "active" : ""}`}
            onClick={onToggleBrowserFullscreen}
            aria-pressed={browserFullscreen}
            aria-label={browserFullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
            title={browserFullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
          >
            <Icon name={browserFullscreen ? "minimize" : "maximize"} size={14} />
          </button>
        )}
        <button
          type="button"
          className={`canvas-action ${filesOpen ? "active" : ""}`}
          onClick={onToggleFiles}
          aria-pressed={filesOpen}
          aria-label={filesOpen ? "收起文件树" : "展开文件树"}
          title={filesOpen ? "收起文件树" : "展开文件树"}
        >
          <Icon name="folder" size={14} />
        </button>
        <button
          type="button"
          className={`canvas-action ${maximized ? "active" : ""}`}
          onClick={onToggleMaximize}
          aria-pressed={maximized}
          aria-label={maximized ? "恢复画布宽度" : "最大化画布"}
          title={maximized ? "恢复画布宽度" : "最大化画布"}
        >
          <Icon name={maximized ? "minimize" : "maximize"} size={14} />
        </button>
        <button
          type="button"
          className="canvas-action"
          onClick={onCollapse}
          aria-label="收起画布"
          title="收起画布（保留标签）"
        >
          <Icon name="chevronRight" size={15} className="canvas-collapse-icon" />
        </button>
      </div>
    </div>
  );
}
