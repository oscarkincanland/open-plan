import Icon from "./Icon.jsx";
import 跑马灯文本 from "./跑马灯文本.jsx";

// v0.13.9 画布「新会话」页签：画布内新建会话 + 最近会话快捷入口。
// 新建复用 App 的 handleNewSession（含 Agent 继承与失败保留语义），
// 创建后聚焦对话输入（focusInput 由 App 调用）；最近会话点击直接切换。
export default function 新会话页签({ sessions = [], busyCreating = false, onNewSession, onSelectSession }) {
  const recent = (Array.isArray(sessions) ? sessions : []).slice(0, 5);
  return (
    <div className="canvas-newchat">
      <div className="canvas-newchat-card">
        <Icon name="chatPlus" size={20} />
        <h3>在当前工作区开始新对话</h3>
        <p>独立会话保留各自的历史、草稿与产物；当前会话不受影响。</p>
        <button
          type="button"
          className="btn primary canvas-newchat-btn"
          onClick={onNewSession}
          disabled={busyCreating}
          title="新建对话（沿用当前会话的智能体）"
        >
          <Icon name="chatPlus" size={14} /> 新建对话
        </button>
      </div>
      {recent.length > 0 && (
        <div className="canvas-newchat-recent">
          <div className="canvas-newchat-recent-head"><Icon name="history" size={12} /> 最近会话</div>
          {recent.map((session) => (
            <button
              key={session.id || session.threadId}
              type="button"
              className="canvas-newchat-session"
              onClick={() => onSelectSession?.(session)}
              title={session.title || session.label || "未命名会话"}
            >
              <i data-status={session.runStatus || "idle"} />
              <跑马灯文本 text={session.title || session.label || "未命名会话"} className="canvas-newchat-session-name" />
              <small>{session.runStatus === "running" ? "执行中" : ""}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
