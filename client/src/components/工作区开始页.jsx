import React from "react";
import Icon from "./Icon.jsx";

/**
 * 工作区开始页（计划 2026-11-11-011）。
 *
 * 定位：切换工作区后在右侧画布打开的「去哪」页面，不是聊天区的「怎么问」空态。
 * 纯展示组件：数据与动作全部由 App 注入，自己不 fetch、不写状态，避免与 App 竞争。
 *
 * 内容对应原「+ → 打开新视图」菜单（任务摘要/文件/浏览器/代码变更/地图预览/创作画布），
 * 加上最近会话与新建对话；「更多工具」就地展开，不产生任何向下浮层。
 */
export default function 工作区开始页({
  project = null,
  workspace = "",
  fileCount = null,
  sessionCount = null,
  sessions = [],
  entries = [],
  moreEntries = [],
  onOpenSession,
  onOpenArtifacts,
  onNewChat,
  onSearch,
}) {
  const title = project?.name || (workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : "工作区");
  const [showMore, setShowMore] = React.useState(false);
  const visibleEntries = entries.filter((entry) => entry && entry.id);
  const extraEntries = (moreEntries || []).filter((entry) => entry && entry.id);

  return (
    <div className="start-page" aria-label="工作区开始页">
      <header className="start-head">
        <div className="start-head-main">
          <span className="start-eyebrow">工作区</span>
          <h2 className="start-title">{title}</h2>
          <p className="start-path" title={workspace}>{workspace || "尚未选择工作区"}</p>
        </div>
        <div className="start-stats">
          {Number.isFinite(fileCount) && <span><strong>{fileCount}</strong> 个文件</span>}
          {Number.isFinite(sessionCount) && <span><strong>{sessionCount}</strong> 个会话</span>}
          {project?.status && <span className="start-stat-chip">{project.status}</span>}
        </div>
      </header>

      <button type="button" className="start-search" onClick={() => onSearch?.()} title="搜索文件名或命令（Ctrl / Cmd + K）">
        <Icon name="search" size={14} />
        <span>搜索文件名或命令</span>
        <kbd>Ctrl K</kbd>
      </button>

      <section className="start-section" aria-label="常用入口">
        <h3 className="start-section-title">常用入口</h3>
        <div className="start-grid">
          {visibleEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`start-tile${entry.disabled ? " disabled" : ""}`}
              onClick={() => { if (!entry.disabled) entry.onOpen?.(); }}
              disabled={entry.disabled}
              title={entry.disabled ? (entry.disabledReason || `${entry.title}当前不可用`) : (entry.hint || entry.title)}
            >
              <span className="start-tile-icon"><Icon name={entry.icon || "file"} size={17} /></span>
              <span className="start-tile-main">
                <strong>{entry.title}</strong>
                <small>{entry.disabled ? (entry.disabledReason || "当前不可用") : (entry.hint || "")}</small>
              </span>
              {!entry.disabled && <Icon name="chevronRight" size={13} className="start-tile-arrow" />}
            </button>
          ))}
          {extraEntries.length > 0 && (
            <button
              type="button"
              className={`start-tile more${showMore ? " open" : ""}`}
              onClick={() => setShowMore((value) => !value)}
              aria-expanded={showMore}
              title={showMore ? "收起更多工具" : "展开更多工具"}
            >
              <span className="start-tile-icon"><Icon name="grid" size={17} /></span>
              <span className="start-tile-main">
                <strong>更多工具</strong>
                <small>{showMore ? "收起" : `${extraEntries.length} 项`}</small>
              </span>
              <Icon name={showMore ? "chevronDown" : "chevronRight"} size={13} className="start-tile-arrow" />
            </button>
          )}
          {showMore && extraEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`start-tile${entry.disabled ? " disabled" : ""}`}
              onClick={() => { if (!entry.disabled) entry.onOpen?.(); }}
              disabled={entry.disabled}
              title={entry.disabled ? (entry.disabledReason || `${entry.title}当前不可用`) : (entry.hint || entry.title)}
            >
              <span className="start-tile-icon"><Icon name={entry.icon || "file"} size={17} /></span>
              <span className="start-tile-main">
                <strong>{entry.title}</strong>
                <small>{entry.disabled ? (entry.disabledReason || "当前不可用") : (entry.hint || "")}</small>
              </span>
              {!entry.disabled && <Icon name="chevronRight" size={13} className="start-tile-arrow" />}
            </button>
          ))}
        </div>
      </section>

      {sessions.length > 0 && (
        <section className="start-section" aria-label="最近会话">
          <h3 className="start-section-title">最近会话</h3>
          <div className="start-recent">
            {sessions.slice(0, 5).map((session) => (
              <button
                key={session.id || session.threadId}
                type="button"
                className="start-recent-item"
                onClick={() => onOpenSession?.(session)}
                title={session.title || session.label || "未命名会话"}
              >
                <Icon name="history" size={13} />
                <span className="start-recent-title">{session.title || session.label || "未命名会话"}</span>
                {session.runStatus && <span className={`start-recent-dot ${session.runStatus}`} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </section>
      )}

      <footer className="start-foot">
        <button type="button" className="btn primary start-newchat" onClick={() => onNewChat?.()}>
          <Icon name="chatPlus" size={14} /> 新建对话
        </button>
        {onOpenArtifacts && (
          <button type="button" className="btn start-artifacts" onClick={() => onOpenArtifacts()}>
            <Icon name="package" size={14} /> 工作产物
          </button>
        )}
      </footer>
    </div>
  );
}
