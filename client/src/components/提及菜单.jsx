import Icon from "./Icon.jsx";
import { filterAgentsForMention } from "./提及逻辑.js";

// v0.13.7 `@` 智能体提及菜单（触发/转义/过滤/注入的纯逻辑在 提及逻辑.js）。
// 渲染层：composer 上方的智能体候选菜单（键盘可达，样式复用 composer-suggestions）。
export { detectMentionTrigger, filterAgentsForMention, buildMentionPrefix, MENTION_MARKER } from "./提及逻辑.js";

export default function 提及菜单({ agents, activeIndex, onPick, onClose }) {
  const filtered = filterAgentsForMention(agents, "");
  if (!filtered.length) return null;
  return (
    <div className="composer-suggestions mention-menu" role="listbox" aria-label="智能体提及候选">
      {filtered.map((agent, index) => (
        <button
          key={agent.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "active" : ""}
          onMouseDown={(e) => { e.preventDefault(); onPick?.(agent); }}
        >
          <span className="composer-suggestion-main">@智能体[{agent.name}]</span>
          <span className="composer-suggestion-label">
            <Icon name={agent.icon === "doc" ? "file" : agent.icon === "locate" ? "locate" : agent.icon === "xls" ? "xls" : "robot"} size={12} /> {agent.name}
          </span>
          <small>{agent.description || "（无描述）"}</small>
        </button>
      ))}
      <button type="button" className="mention-menu-close" onMouseDown={(e) => { e.preventDefault(); onClose?.(); }} aria-label="关闭智能体候选">Esc 关闭 · 选中后插入 @智能体[名称] 标记</button>
    </div>
  );
}
