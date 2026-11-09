/**
 * 事件注册表：事件流的唯一事实来源。
 *
 * 背景：此前"是否算生命周期事件"（server/事件协议.mjs，决定通道历史里能否被增量挤出）
 * 与"是否落盘"（server/事件存储.mjs，决定能否跨会话回放）是两张手写清单，实测出现
 * 19 种事件"声明了但没落盘"、9 种事件"落盘但不受保护"的错位，重连回放无法重建回合
 * 边界、审批、模型回退等语义。
 *
 * 现在三处都从这张表派生：
 *   lifecycle: true  → 写入通道历史时不允许被 token/tool_output 等增量挤出；
 *   persist:   true  → 写入 .oaw/events/事件流.jsonl，可在恢复会话时回放；
 *   runEvent:  true  → 额外写入该 Run 的 `run.events`（任务中心/回放读它）。
 *                      此前这是 server/agent.mjs `emit()` 里的一份内联白名单，
 *                      2026-11-06 收敛到本表（RUN_RECORDED_TYPES）。
 *
 * 约定（由 scripts/事件注册表测试.mjs 强制）：
 *   1. persist / runEvent 的事件必须同时 lifecycle（能落盘/能回放的都值得保护）；
 *   2. 代码里 emit/recordRunEvent/appendEvent/writeEvent 用到的事件类型必须登记，
 *      否则测试失败——新增事件不会再"只在一处处理"。
 */

/** @type {Array<{type:string, lifecycle:boolean, persist:boolean, note:string}>} */
const REGISTRY = [
  // ---- 运行生命周期 ----
  { type: "run_admitting", lifecycle: true, persist: true, note: "Run 建档中" },
  { type: "run_admitted", lifecycle: true, persist: true, note: "Run 建档完成（前端锚点）" },
  { type: "run_started", lifecycle: true, persist: true, note: "Run 开始" },
  { type: "prompt", lifecycle: true, persist: true, note: "用户输入进模型" },
  { type: "capability_plan", lifecycle: true, persist: true, note: "本轮能力计划" },
  { type: "mode_policy", lifecycle: true, persist: true, note: "模式工具策略快照" },
  { type: "thinking_level", lifecycle: true, persist: true, note: "思考深度设置" },
  { type: "run_checkpoint_updated", lifecycle: true, persist: true, note: "恢复检查点更新" },
  { type: "run_cancel_requested", lifecycle: true, persist: true, note: "收到取消请求" },
  { type: "run_draining", lifecycle: true, persist: true, note: "中断后残余消息排空窗口（Qoder P0-3，默认关）", schema: { required: ["runId"], types: { runId: "string", reason: "string" } } },
  { type: "run_recovered", lifecycle: true, persist: true, note: "服务重启后标记恢复" },
  { type: "run_recovery_started", lifecycle: true, persist: true, note: "用户选择继续该 Run" },
  { type: "run_finished", lifecycle: true, persist: true, note: "Run 终态（权威完成语义）", schema: { required: ["runId", "status"], types: { runId: "string", status: "string", artifacts: "array" } } },
  { type: "aborted", lifecycle: true, persist: true, note: "回合被中断", schema: { required: ["runId"], types: { runId: "string" } } },

  // ---- 回合 / 消息边界 ----
  { type: "agent_started", lifecycle: true, runEvent: true, persist: true, note: "Agent 回合开始" },
  { type: "agent_turn_end", lifecycle: true, persist: true, note: "Agent 回合收尾统计" },
  { type: "turn_started", lifecycle: true, runEvent: true, persist: true, note: "模型回合开始" },
  { type: "turn_ended", lifecycle: true, runEvent: true, persist: true, note: "模型回合结束" },
  { type: "message_start", lifecycle: true, runEvent: true, persist: true, note: "助手消息开始" },
  { type: "message_end", lifecycle: true, runEvent: true, persist: true, note: "助手消息结束" },

  // ---- 工具与写入 ----
  { type: "tool_start", lifecycle: true, runEvent: true, persist: true, note: "工具调用开始" },
  { type: "tool_end", lifecycle: true, runEvent: true, persist: true, note: "工具调用结束", schema: { required: ["name"], types: { name: "string", isError: "boolean" } } },
  { type: "tool_call_progress", lifecycle: true, persist: false, note: "工具分段进度（高频）" },
  // ---- 内置浏览器步骤/读取（可观测性，2026-11-06 批次）----
  { type: "browser_step_start", lifecycle: true, persist: true, note: "浏览器步骤开始（browser_* 工具）", schema: { required: ["toolCallId", "kind"], types: { toolCallId: "string", kind: "string", url: "string", title: "string" } } },
  { type: "browser_step_end", lifecycle: true, persist: true, note: "浏览器步骤结束（done/error）", schema: { required: ["toolCallId", "kind", "status"], types: { toolCallId: "string", kind: "string", status: "string", durationMs: "number", url: "string", title: "string", error: "string" } } },
  { type: "browser_read", lifecycle: true, persist: true, note: "浏览器读取内容（snapshot/extract：字数/元素数/预览）", schema: { required: ["toolCallId", "kind"], types: { toolCallId: "string", kind: "string", url: "string", title: "string", chars: "number", elementCount: "number", preview: "string" } } },
  { type: "tool_repeat_warning", lifecycle: true, runEvent: true, persist: true, note: "同参数重复调用提醒" },
  { type: "completion_nudge", lifecycle: true, persist: true, legacy: true, note: "历史事件：收尾强制完成声明提醒（显式完成声明已停用，不再发射）" },
  { type: "write_started", lifecycle: true, persist: true, note: "写入开始（含锁）" },
  { type: "write_locked", lifecycle: true, persist: false, note: "写入已加锁（与 write_started 恒成对，不落盘省冗余）" },
  { type: "write_rejected", lifecycle: true, persist: true, note: "写入被拒（含失败码）" },
  { type: "write_cleaned", lifecycle: true, persist: true, note: "临时产物清理" },
  { type: "artifact_staged", lifecycle: true, persist: true, note: "产物暂存" },
  { type: "artifacts_validated", lifecycle: true, persist: true, note: "产物验收结果（发布前预检）" },
  { type: "artifact_materialized", lifecycle: true, persist: true, note: "产物落盘发布" },
  { type: "artifact_conflict", lifecycle: true, persist: true, note: "发布时目标已被外部修改，改写冲突副本（不覆盖）" },
  { type: "artifact_materialize_skipped", lifecycle: true, persist: true, note: "外部工具物化跳过（目标版本已变化）" },
  { type: "write_scope_unknown", lifecycle: true, persist: true, note: "bash 写目标无法静态推导，未加工作区锁（advisory）" },
  { type: "write_stale", lifecycle: true, persist: true, note: "写入前版本校验失败（读后被改/未读先写）" },
  { type: "artifact_published", lifecycle: true, persist: true, note: "产物固定/发布" },
  { type: "artifact_rolled_back", lifecycle: true, persist: true, note: "产物回滚" },
  { type: "file_changed", lifecycle: true, persist: true, note: "工作区文件变更" },

  // ---- 子代理（Subagent）----
  // 子代理事件一律带 parentToolCallId（即父会话 run_subagent 的 toolCallId），
  // 前端据此把子代理归到父工具调用下；此前未登记导致不落盘、跨会话回放拿不到。
  // 方案 §3.4 事件契约：planned→started→(progress|tool)*→result→(verified→result)*→closed。
  { type: "subagent_planned", lifecycle: true, persist: true, note: "子代理编排计划（含角色/任务/工具白名单/预算）" },
  { type: "subagent_start", lifecycle: true, persist: true, note: "子代理启动（含角色/子任务；执行器兼容事件）" },
  { type: "subagent_started", lifecycle: true, persist: true, note: "子代理会话已建立（含模型与播种引用）" },
  { type: "subagent_tool", lifecycle: true, persist: true, note: "子代理工具调用（start/end，含子 toolCallId）" },
  { type: "subagent_update", lifecycle: true, persist: false, note: "子代理进度/思考节流（高频，不落盘，对齐 tool_call_progress）" },
  { type: "subagent_progress", lifecycle: true, persist: false, note: "子代理阶段进度（orchestrator 契约，节流高频不落盘）" },
  { type: "subagent_end", lifecycle: true, persist: true, note: "子代理结束（含结论摘要/错误）" },
  { type: "subagent_result", lifecycle: true, persist: true, note: "子代理结构化结果（status/output/artifacts/toolStats）" },
  { type: "subagent_verified", lifecycle: true, persist: true, note: "子代理对抗式核验结论（verdict/checklist）" },
  { type: "subagent_closed", lifecycle: true, persist: true, note: "子代理关账（finalStatus/parentToolCallId，roster 持久化锚点）" },
  // 阻塞事件冒泡（开关 subagentBlockedBubble，默认关）：子代理因等待用户审批而阻塞/解除时，
  // 向父会话事件流冒泡可观测的 blocked/unblocked 生命周期。
  { type: "subagent_blocked", lifecycle: true, persist: true, note: "子代理因等待用户审批而阻塞（默认关）", schema: { required: ["childId"], types: { childId: "string", kind: "string", tool: "string" } } },
  { type: "subagent_unblocked", lifecycle: true, persist: true, note: "子代理阻塞解除（审批已决，默认关）", schema: { required: ["childId"], types: { childId: "string", kind: "string", tool: "string" } } },

  // ---- Agent Teams（Team Lite，2026-11-04）----
  // Team 只属于一个 Run；事件带 teamId/runId，前端据此重建只读 roster 与任务板。
  { type: "team_started", lifecycle: true, persist: true, note: "团队创建（Lead/人数上限/模式；2026-11-09 起带来源 trigger）", schema: { required: ["teamId", "leadId", "mode"], types: { teamId: "string", leadId: "string", mode: "string", maxMembers: "number", maxTasks: "number", trigger: "string", teamIntent: "string", suggestReasons: "array" } } },
  // 2026-11-09（计划 2026-11-09-001）：团队建议与组队护栏的可观测事件。
  { type: "team_suggested", lifecycle: true, persist: true, note: "系统建议使用专家团队（建议不强制，模型可拒绝）", schema: { required: ["reasons"], types: { runId: "string", score: "number", minTasks: "number", mode: "string", reasons: "array", signals: "array" } } },
  { type: "team_spawn_blocked", lifecycle: true, persist: true, note: "组队护栏阻断 team_spawn（无可认领任务）", schema: { required: ["code"], types: { runId: "string", teamIntent: "string", taskCount: "number", code: "string", reason: "string" } } },
  { type: "team_member_spawned", lifecycle: true, persist: true, note: "团队队友创建", schema: { required: ["teamId", "member"], types: { teamId: "string", member: "object", role: "string", readOnly: "boolean" } } },
  { type: "team_member_status", lifecycle: true, persist: true, note: "团队队友状态/当前活动", schema: { required: ["teamId", "memberId", "status"], types: { teamId: "string", memberId: "string", status: "string", activity: "string" } } },
  { type: "team_member_result", lifecycle: true, persist: true, note: "团队队友本轮结果（含会话轨迹）", schema: { required: ["teamId", "memberId", "status"], types: { teamId: "string", memberId: "string", status: "string", output: "string", transcript: "array", isError: "boolean" } } },
  { type: "team_message_queued", lifecycle: true, persist: true, note: "团队消息入队/投递", schema: { required: ["teamId", "messageId", "to"], types: { teamId: "string", messageId: "string", to: "string", from: "string", bytes: "number" } } },
  { type: "team_message_delivered", lifecycle: true, persist: true, note: "团队消息已投递给队友", schema: { required: ["teamId", "messageId", "to"], types: { teamId: "string", messageId: "string", to: "string", from: "string" } } },
  { type: "team_wait_finished", lifecycle: true, persist: false, note: "team_wait 返回（边沿触发/超时）", schema: { required: ["teamId"], types: { teamId: "string", timedOut: "boolean", changed: "boolean", noProgress: "boolean" } } },
  { type: "team_task_updated", lifecycle: true, persist: true, note: "共享任务板变更（revision CAS）", schema: { required: ["teamId", "task", "action"], types: { teamId: "string", task: "object", action: "string", actorId: "string" } } },
  { type: "team_closed", lifecycle: true, persist: true, note: "团队关闭（Run 结束/取消）", schema: { required: ["teamId", "reason"], types: { teamId: "string", reason: "string" } } },

  // ---- Editorial Pipeline（方案 §5.2）----
  // 流水线每步产出中间产物并独立发事件，前端展示为可折叠阶段条。
  { type: "pipeline_started", lifecycle: true, persist: true, note: "编辑流水线开始（Planner→Writer→Formatter→Evaluator）" },
  { type: "pipeline_stage_started", lifecycle: true, persist: true, note: "流水线阶段开始（含 stage/目标/中间产物路径）" },
  { type: "pipeline_stage_finished", lifecycle: true, persist: true, note: "流水线阶段完成（含产物路径与检查结论）" },
  { type: "pipeline_finished", lifecycle: true, persist: true, note: "编辑流水线结束（交付产物/回环/失败终态）" },

  // ---- 审批 / 提问 ----
  { type: "ask_user", lifecycle: true, runEvent: true, persist: true, note: "向用户提问", schema: { required: ["askId", "question"], types: { askId: "string", question: "string", options: "array" } } },
  { type: "tool_approval_request", lifecycle: true, persist: true, note: "工具审批请求", schema: { required: ["id", "tool"], types: { id: "string", tool: "string", action: "string" } } },
  { type: "interaction_owner_changed", lifecycle: true, persist: true, note: "交互归属变更（Qoder P1-4 子代理接管，默认关）", schema: { required: ["owner"], types: { owner: "object", status: "string" } } },
  { type: "tool_approval_resolved", lifecycle: true, persist: true, note: "工具审批结果" },

  // ---- 通道与重试 ----
  { type: "model_request_started", lifecycle: true, persist: true, note: "向模型发起请求（回合锚点）" },
  { type: "agent_retry", lifecycle: true, runEvent: true, persist: true, note: "模型重试" },
  { type: "agent_retry_end", lifecycle: true, persist: true, note: "模型重试结束" },
  { type: "agent_model_fallback", lifecycle: true, persist: true, note: "通道切换到备用模型" },
  { type: "agent_model_fallback_failed", lifecycle: true, persist: true, note: "通道切换失败" },
  { type: "model_switched", lifecycle: true, persist: true, note: "模型切换（用户切换/排队生效/通道回退），界面据此画切换分割线" },
  { type: "agent_queued", lifecycle: true, persist: true, note: "任务排队" },
  { type: "agent_queue_update", lifecycle: true, persist: true, note: "队列状态更新" },
  { type: "steer", lifecycle: true, persist: true, note: "运行中插话/系统提醒" },

  // ---- 运行预算（E02）----
  { type: "run_budget_notice", lifecycle: true, runEvent: true, persist: true, note: "运行预算软提醒（回合/工具接近软预算）" },
  { type: "run_budget_blocked", lifecycle: true, runEvent: true, persist: true, note: "运行预算硬阻断（硬预算/重复无进展/连续失败）" },
  { type: "tool_gate_denied", lifecycle: true, runEvent: true, persist: true, note: "工具被把关扩展单点拒绝（U2，扩展 tool_call 拦截，Run 继续执行）" },

  // ---- 后台任务（2026-11-04）----
  // 工具超过阈值仍未完成时转入后台；模型继续其他步骤，完成/失败/取消各有事件。
  { type: "tool_backgrounded", lifecycle: true, persist: true, note: "工具已转后台（jobId/kind/命令摘要）", schema: { required: ["jobId", "kind"], types: { jobId: "string", kind: "string", command: "string" } } },
  { type: "background_job_finished", lifecycle: true, persist: true, note: "后台任务完成（jobId/exitCode/摘要）", schema: { required: ["jobId"], types: { jobId: "string", exitCode: "number", summary: "string" } } },
  { type: "background_job_failed", lifecycle: true, persist: true, note: "后台任务失败（jobId/错误）", schema: { required: ["jobId", "error"], types: { jobId: "string", error: "string" } } },
  { type: "background_job_cancelled", lifecycle: true, persist: true, note: "后台任务取消（jobId/原因）", schema: { required: ["jobId"], types: { jobId: "string", reason: "string" } } },

  // ---- 上下文预算（U1/U6）----
  { type: "context_usage", lifecycle: true, persist: false, note: "回合边界精确上下文用量（U1，getContextUsage 实测，高频不落盘）" },
  { type: "compaction_failed", lifecycle: true, persist: true, note: "上下文压缩失败（U6，含原因与是否中止，不再静默）" },

  // ---- 上下文与错误 ----
  { type: "context_compacting", lifecycle: true, runEvent: true, persist: true, note: "开始压缩上下文" },
  { type: "context_compacted", lifecycle: true, runEvent: true, persist: true, note: "压缩完成" },
  { type: "context_compact_warning", lifecycle: true, persist: true, note: "压缩告警" },
  { type: "agent_error", lifecycle: true, runEvent: true, persist: true, note: "模型/Agent 错误" },
  { type: "runtime_error", lifecycle: true, persist: true, note: "运行环境错误" },
  { type: "runtime_health", lifecycle: true, persist: true, note: "运行健康快照" },
  { type: "officecli_failed", lifecycle: true, persist: true, note: "Office CLI 失败" },
  { type: "office_engine_selected", lifecycle: true, persist: true, note: "Office 操作实际执行引擎（native / cli），用于简单文本走原生的可观测性", schema: { required: ["engine", "command"], types: { engine: "string", command: "string", file: "string" } } },
  { type: "office_format_applied", lifecycle: true, persist: true, note: "Office 版式规范命中（场景/模板/配方）", schema: { required: ["scene"], types: { scene: "string", template: "string", recipe: "string", route: "string" } } },
  { type: "office_qa_finished", lifecycle: true, persist: true, note: "Office 规则闸门完成（含模板覆盖率）", schema: { required: ["passed"], types: { passed: "boolean", issues: "array", checks: "array", file: "string" } } },
  { type: "review_write_blocked", lifecycle: true, persist: true, note: "Review 原文写回被保护拦截" },

  // ---- 完成语义与总结 ----
  { type: "task_completed", lifecycle: true, persist: true, legacy: true, note: "历史事件：显式完成声明（显式完成声明已停用，仅历史会话回放使用）" },
  { type: "agent_summary", lifecycle: true, persist: true, note: "本轮总结" },
  { type: "assistant_final", lifecycle: true, runEvent: true, persist: true, note: "最终回答文本" },
  { type: "final_text_missing", lifecycle: true, persist: true, note: "模型只输出思考/没有正文终稿（recovering=true 表示正在补一次正文）", schema: { required: ["reason"], types: { reason: "string", recovering: "boolean", runId: "string" } } },
  { type: "agent_end", lifecycle: true, runEvent: true, persist: true, note: "Agent 收尾" },
  { type: "todo_updated", lifecycle: true, persist: true, note: "待办更新" },
  { type: "step_updated", lifecycle: true, persist: true, note: "步骤状态更新" },
  { type: "stats", lifecycle: true, runEvent: true, persist: false, note: "用量统计（每回合一次，不落盘）" },

  // ---- Review 证据链 ----
  { type: "map_action", lifecycle: true, persist: false, note: "地图分析/样式动作（前端实时更新，不落盘）" },
  // 地图草稿层（2026-11-07）：草稿不落正式库，事件只用于前端实时刷新。
  { type: "map_draft_changed", lifecycle: true, persist: false, note: "地图草稿层新增/更新/删除（前端实时刷新草稿列表，不落盘）", schema: { required: ["project", "draftId", "action"], types: { project: "string", draftId: "string", action: "string", name: "string", geometryType: "string", features: "number", demo: "boolean", revision: "number" } } },
  { type: "map_draft_confirmed", lifecycle: true, persist: true, note: "地图草稿固化为正式图层（审计）", schema: { required: ["project", "draftId", "layerId"], types: { project: "string", draftId: "string", layerId: "string", layerName: "string", features: "number", demo: "boolean", runId: "string" } } },
  { type: "map_draft_discarded", lifecycle: true, persist: true, note: "地图草稿被丢弃（审计）", schema: { required: ["project", "draftId"], types: { project: "string", draftId: "string", reason: "string" } } },
  { type: "review_material_classified", lifecycle: true, persist: true, note: "审查材料识别" },
  { type: "review_source_search_started", lifecycle: true, persist: true, note: "规范检索开始" },
  { type: "review_source_search_result", lifecycle: true, persist: true, note: "规范候选返回" },
  { type: "review_source_read_started", lifecycle: true, persist: true, note: "规范读取开始" },
  { type: "review_source_read", lifecycle: true, persist: true, note: "规范全文读取成功" },
  { type: "review_source_applied", lifecycle: true, persist: true, note: "规范被采用" },
  { type: "review_source_unused", lifecycle: true, persist: true, note: "规范读过未采用" },
  { type: "review_waiting_confirmation", lifecycle: true, persist: true, note: "等待写回确认" },
  { type: "review_confirmed", lifecycle: true, persist: true, note: "用户确认写回" },
  { type: "review_confirmation_rejected", lifecycle: true, persist: true, note: "用户拒绝写回" },

  // ---- 领域工作流硬约束（Qoder 对标 §4.3，默认关）----
  { type: "geo_out_of_range", lifecycle: true, persist: true, note: "坐标越出中国范围（经度 73–135°E / 纬度 18–54°N）" },
  { type: "data_integrity_failed", lifecycle: true, persist: true, note: "记录数 expected vs actual 不一致" },
  { type: "artifact_root_violation", lifecycle: true, persist: true, note: "产物路径越出工作区" },
  { type: "preflight_skipped", lifecycle: true, persist: true, note: "用户显式跳过 preflight 硬约束校验" },

  // ---- 记忆治理 ----
  { type: "memory_proposal", lifecycle: true, persist: true, note: "记忆建议提交（UI 事件）" },
  { type: "memory_proposal_updated", lifecycle: true, persist: true, note: "记忆建议内容更新" },
  { type: "memory_proposal_resolved", lifecycle: true, persist: true, note: "记忆建议审核完成" },
  { type: "memory_proposal_created", lifecycle: true, persist: true, note: "记忆建议创建" },
  { type: "memory_proposal_edited", lifecycle: true, persist: true, note: "记忆建议编辑" },
  { type: "memory_proposal_approved", lifecycle: true, persist: true, note: "记忆建议通过" },
  { type: "memory_proposal_rejected", lifecycle: true, persist: true, note: "记忆建议拒绝" },
  { type: "memory_proposal_merged", lifecycle: true, persist: true, note: "记忆建议合并" },
  { type: "memory_proposal_failed", lifecycle: true, persist: true, note: "记忆建议失败" },
  { type: "memory_written", lifecycle: true, persist: true, note: "记忆写入" },
  { type: "memory_file_edited", lifecycle: true, persist: true, note: "记忆文件编辑" },
  { type: "workspace_initialized", lifecycle: true, persist: true, note: "工作区初始化（AGENTS.md + memory/MEMORY.md 种子）", schema: { required: ["workspace", "version", "created", "skipped"], types: { workspace: "string", version: "string", created: "array", upgraded: "array", skipped: "array" } } },

  // ---- 长期目标（v0.13.x Goal）----
  // Goal 是项目 Harness 的跨轮目标层，不是 Pi 原生能力；状态变化与用户操作都落盘可回放。
  { type: "goal_created", lifecycle: true, persist: true, note: "长期目标创建/替换", schema: { required: ["goalId", "sessionId", "status"], types: { goalId: "string", sessionId: "string", text: "string", status: "string" } } },
  { type: "goal_updated", lifecycle: true, persist: true, note: "长期目标状态/编辑/预算/统计更新", schema: { required: ["goalId", "sessionId", "status"], types: { goalId: "string", sessionId: "string", status: "string", turns: "number", usedTokens: "number", budgetTokens: "number" } } },
  { type: "goal_cleared", lifecycle: true, persist: true, note: "长期目标清除", schema: { required: ["goalId", "sessionId"], types: { goalId: "string", sessionId: "string" } } },

  // ---- ZCode Harness 对标（计划 2026-10-27-004，默认关）----
  { type: "tool_metadata_missing", lifecycle: true, persist: true, note: "工具元数据缺失（启动/注册期告警）", schema: { required: ["tool"], types: { tool: "string" } } },
  { type: "permission_decision", lifecycle: true, persist: false, note: "权限决策（高频；ask/deny 另见审批事件）", schema: { required: ["tool", "action", "ruleId"], types: { tool: "string", action: "string", ruleId: "string" } } },
  { type: "tool_result_externalized", lifecycle: true, persist: true, note: "工具结果超阈值外置", schema: { required: ["tool", "path", "bytes"], types: { tool: "string", path: "string", bytes: "number" } } },
  { type: "usage_recorded", lifecycle: true, persist: false, note: "用量记录（JSONL 为计量事实）" },
  { type: "memory_recall_started", lifecycle: true, persist: true, note: "记忆召回开始" },
  { type: "memory_recall_selected", lifecycle: true, persist: true, note: "记忆召回选择结果（可审计）", schema: { required: ["selected"], types: { selected: "array" } } },
  { type: "memory_recall_skipped", lifecycle: true, persist: true, note: "记忆召回跳过/回退" },
  { type: "memory_extraction_started", lifecycle: true, persist: true, note: "记忆自动抽取开始" },
  { type: "memory_extraction_finished", lifecycle: true, persist: true, note: "记忆自动抽取结束" },
  { type: "memory_extraction_skipped", lifecycle: true, persist: true, note: "记忆自动抽取跳过（条件不满足/失败）" },
  { type: "hook_started", lifecycle: true, persist: false, note: "Hook 开始（高频）" },
  { type: "hook_finished", lifecycle: true, persist: false, note: "Hook 结束（高频）" },
  { type: "hook_denied", lifecycle: true, persist: true, note: "Hook 拒绝（可审计）", schema: { required: ["event", "reason"], types: { event: "string", reason: "string" } } },
  { type: "subagent_profile_frozen", lifecycle: true, persist: true, note: "子代理 profile 快照冻结" },
  { type: "subagent_background_started", lifecycle: true, persist: true, note: "子代理后台派发开始" },
  { type: "subagent_background_finished", lifecycle: true, persist: true, note: "子代理后台派发结束" },
  { type: "context_sections_assembled", lifecycle: true, persist: false, note: "上下文章节组装诊断" },
  { type: "context_files_resolved", lifecycle: true, persist: true, note: "本轮上下文文件解析（L0/L1/记忆，去重后）", schema: { required: ["workspace", "constitutionVersion", "files"], types: { workspace: "string", constitutionVersion: "string", files: "array" } } },
  { type: "skill_injected", lifecycle: true, persist: true, note: "Skill 注入（含预算/哈希）" },
  // ---- 技能发现可观测性（2026-11-08 D0-9；计划 2026-11-08-001）----
  // 让“为什么没调用成功”可以定位到：目录没注入 / 搜索没命中 / 读不到 / 被截断。
  { type: "skill_catalog_injected", lifecycle: true, persist: true, note: "每轮技能目录注入（数量/是否截断/预算）", schema: { required: ["count", "included", "truncated"], types: { count: "number", included: "number", truncated: "boolean", bytes: "number", nameOnlyCount: "number", policy: "string" } } },
  { type: "skill_search", lifecycle: true, persist: true, note: "技能检索（查询/命中数/Top 名称/是否空搜）", schema: { required: ["query", "hits"], types: { query: "string", hits: "number", topNames: "array", empty: "boolean", stopAutoSearch: "boolean", runId: "string" } } },
  { type: "skill_read", lifecycle: true, persist: true, note: "读取技能说明（字节/是否截断/哈希，flag 关闭也记录）", schema: { required: ["name", "bytes"], types: { name: "string", bytes: "number", fullBytes: "number", truncated: "boolean", hash: "string", source: "string" } } },
  { type: "skill_preflight", lifecycle: true, persist: true, note: "技能依赖只读预检（ready/degraded/blocked）", schema: { required: ["name", "status"], types: { name: "string", status: "string", code: "string", missing: "array" } } },
  { type: "skill_exec_allowed", lifecycle: true, persist: true, note: "显式技能脚本经白名单通道放行（写作路由）", schema: { required: ["tool"], types: { tool: "string", route: "string", command: "string" } } },
  // ---- 人机协作中枢（2026-11-08 D2；计划 2026-11-08-001 §11）----
  // 与 legacy ask_user/tool_approval_request 双发；新前端按 interaction_* 渲染，旧回放按旧事件。
  { type: "interaction_open", lifecycle: true, persist: true, note: "交互创建（clarify/confirm/review/approval）", schema: { required: ["interactionId", "kind"], types: { interactionId: "string", kind: "string", runId: "string", threadId: "string", expiresAt: "string", priority: "number" } } },
  { type: "interaction_settled", lifecycle: true, persist: true, note: "交互结算（answered/skipped/assumed/denied/cancelled）", schema: { required: ["interactionId", "reason"], types: { interactionId: "string", reason: "string", answer: "string", assumption: "string" } } },
  { type: "interaction_expired", lifecycle: true, persist: true, note: "交互超时（confirm 不自动继续）", schema: { required: ["interactionId"], types: { interactionId: "string", assumed: "boolean" } } },
  { type: "interaction_assumption", lifecycle: true, persist: true, note: "用户修改/撤销假设", schema: { required: ["interactionId", "assumption"], types: { interactionId: "string", assumption: "string" } } },
  { type: "skill_draft_created", lifecycle: true, persist: true, note: "技能草稿生成（只写工作区，不安装）", schema: { required: ["name", "path", "bytes"], types: { name: "string", path: "string", bytes: "number" } } },
  { type: "skill_installed", lifecycle: true, persist: true, note: "技能草稿经用户确认安装到技能库", schema: { required: ["name", "path"], types: { name: "string", path: "string" } } },
  { type: "config_source_resolved", lifecycle: true, persist: false, note: "配置来源解析诊断" },
  { type: "workflow_journal_updated", lifecycle: true, persist: true, note: "工作流阶段 journal 更新" },
  { type: "plugin_manifest_invalid", lifecycle: true, persist: true, note: "插件清单缺失/哈希不匹配" },
  { type: "plan_persisted", lifecycle: true, persist: true, note: "计划文件落盘" },

  // ---- 创作画布（2026-11-09 计划 2026-11-09-003，默认关）----
  // 画布由工作区文件承载；事件只表达“哪块板变了/导出完成”，消费方按 revision 重读。
  { type: "canvas_created", lifecycle: true, persist: true, note: "创作画布创建", schema: { required: ["slug", "workspace"], types: { slug: "string", title: "string", kind: "string", workspace: "string" } } },
  { type: "canvas_changed", lifecycle: true, persist: true, note: "创作画布内容变更（索引/板）", schema: { required: ["slug", "action"], types: { slug: "string", boardPath: "string", action: "string", revision: "number", actor: "string", workspace: "string" } } },
  { type: "canvas_exported", lifecycle: true, persist: true, note: "创作画布导出完成", schema: { required: ["slug", "format", "files"], types: { slug: "string", format: "string", files: "array", jobId: "string" } } },

  // ---- 高频增量（只走实时 SSE，可优先淘汰）----
  { type: "token", lifecycle: false, persist: false, note: "回答流式文本" },
  { type: "thinking", lifecycle: false, persist: false, note: "思考流" },
  { type: "tool_output", lifecycle: false, persist: false, note: "工具输出流" },
  { type: "tool_output_delta", lifecycle: false, persist: false, note: "工具输出增量分片（Qoder P0-2 单帧护栏，默认关）", schema: { required: ["output"], types: { output: "string", index: "number", frames: "number" } } },
  { type: "text_boundary", lifecycle: false, persist: false, note: "文本段落边界（打字机）" },
  { type: "thinking_boundary", lifecycle: false, persist: false, note: "思考段落边界" },
];

const byType = new Map();
for (const item of REGISTRY) {
  if (byType.has(item.type)) throw new Error(`事件注册表存在重复类型：${item.type}`);
  if (item.persist && !item.lifecycle) throw new Error(`事件 ${item.type} 标记了 persist 但未标记 lifecycle（约定：能落盘的就值得保护）`);
  if (item.runEvent && !item.lifecycle) throw new Error(`事件 ${item.type} 标记了 runEvent 但未标记 lifecycle（Run 记录同样需要抗淘汰）`);
  byType.set(item.type, Object.freeze({ ...item }));
}

/** 全部已登记事件类型 */
export const EVENT_REGISTRY = Object.freeze([...byType.values()]);
export const EVENT_TYPES = Object.freeze([...byType.keys()]);
/** 生命周期事件：通道历史中不被增量挤出 */
export const LIFECYCLE_EVENT_TYPES = new Set(EVENT_REGISTRY.filter((item) => item.lifecycle).map((item) => item.type));
/** 写入 Run 记录（run.events）的事件类型：agent.mjs 的 emit 落 Run 判定读此集合，不再维护内联白名单。 */
export const RUN_RECORDED_TYPES = new Set(EVENT_REGISTRY.filter((item) => item.runEvent === true).map((item) => item.type));
/** 高频增量：不落盘、可优先淘汰 */
export const DELTA_EVENT_TYPES = new Set(EVENT_REGISTRY.filter((item) => !item.lifecycle && !item.persist).map((item) => item.type));
/** 需要写入 .oaw/events 事件流的事件 */
export const PERSISTED_TYPES = new Set(EVENT_REGISTRY.filter((item) => item.persist).map((item) => item.type));

/**
 * P1-2：事件负载结构校验（只校验「声明了 schema 的事件」）。
 * schema 形态：`{ required: ["runId"], types: { runId: "string" } }`，类型取值
 * string / number / boolean / object / array。
 * 未声明 schema 的事件一律通过（`skipped: true`），因此存量 100+ 事件不受影响。
 * 本函数是纯函数：不抛错、不写日志，由调用方决定「告警 / 计数 / 丢弃 / 阻断」。
 */
const SCHEMA_TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};

export function validateEventPayload(type, data = {}) {
  const name = String(type || "");
  const spec = byType.get(name) || null;
  const schema = spec?.schema || null;
  if (!schema) return { ok: true, skipped: true, type: name, missing: [], wrongType: [] };
  const payload = data && typeof data === "object" ? data : {};
  const missing = (schema.required || []).filter((key) => payload[key] === undefined || payload[key] === null);
  const wrongType = Object.entries(schema.types || {})
    .filter(([key, kind]) => {
      if (payload[key] === undefined) return false;
      const check = SCHEMA_TYPE_CHECKS[kind];
      return check ? !check(payload[key]) : false;
    })
    .map(([key, kind]) => `${key} 期望 ${kind}`);
  return { ok: missing.length === 0 && wrongType.length === 0, skipped: false, type: name, missing, wrongType };
}

export function eventSpec(type) {
  return byType.get(String(type || "")) || null;
}

export function isRegisteredEvent(type) {
  return byType.has(String(type || ""));
}

export function registrySummary() {
  return {
    total: EVENT_REGISTRY.length,
    lifecycle: LIFECYCLE_EVENT_TYPES.size,
    persisted: PERSISTED_TYPES.size,
    runRecorded: RUN_RECORDED_TYPES.size,
    delta: DELTA_EVENT_TYPES.size,
  };
}
