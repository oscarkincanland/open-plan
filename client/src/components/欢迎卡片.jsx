// v0.13.7 欢迎卡片：空会话首屏。
// 建议提示词优先来自既有只读端点 /api/agents（"交给某助手"式建议），
// 端点失败或无数据时回退静态示例（EMPTY_EXAMPLES）；点击示例直接发送。
// 2026-11-03：工作区有 AGENTS.md 时只在这里给一行弱提示，不再往消息流写系统消息
// （否则空态被挤掉，用户看不到初始化界面）。
export default function 欢迎卡片({ mode, emptyExample, agents, projectInstructions = false, onSend }) {
  const agentSuggestions = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.id && agent?.name)
    .slice(0, 4);
  const staticExamples = emptyExample?.examples || [];
  return (
    <div className={`chat-empty mode-${mode}`}>
      <div className="chat-empty-title">{emptyExample?.title}</div>
      <ol className="chat-empty-steps">
        {(emptyExample?.steps || []).map((step) => <li key={step}>{step}</li>)}
      </ol>
      {agentSuggestions.length > 0 && (
        <div className="chat-empty-examples" aria-label="智能体建议">
          {agentSuggestions.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="chat-empty-example welcome-agent-suggestion"
              title={`点击直接发送给「${agent.name}」`}
              onClick={() => onSend?.(`@智能体[${agent.name}] ${agent.description || "请协助完成相关任务"}`)}
            >
              @智能体[{agent.name}] {agent.description}
            </button>
          ))}
        </div>
      )}
      {staticExamples.length > 0 && (
        <div className="chat-empty-examples" aria-label="可执行示例">
          {staticExamples.map((example) => (
            <button
              key={example}
              type="button"
              className="chat-empty-example"
              title="点击直接发送，可按 Enter 前在输入框修改"
              onClick={() => onSend?.(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}
      <div className="hint">
        {mode === "chat"
          ? "Chat 只读：不会修改或生成文件；需要产出时切到 Work。"
          : mode === "review"
            ? "请先打开或 @ 引用要审查的材料，原文默认不改，只生成报告与批注副本。"
            : "会写入工作区，按审批提示确认；结束时以验收结果为准。"}
        <br />
        @ 引用文件或 @智能体[名称] 提及助手，/ 调用 Skill，# 使用能力，& 引用会话；粘贴图片可辅助说明（需选择支持图片的模型）
      </div>
      {projectInstructions && (
        <div className="chat-empty-project-note" role="note">已加载 AGENTS.md 项目约定，本会话按其中规则执行</div>
      )}
    </div>
  );
}
