# 0023 专家团队采用 Team Lite 边界

- 状态：已采纳
- 记录日期：2026-11-05
- 决策者：项目负责人
- 基线：v0.13.3（develop @ 当前）
- 关联：[计划 014](../plans/2026-11-04-014-AgentTeams与subagent能力适配计划.md)、[REQUIREMENTS.md](../../REQUIREMENTS.md) R2、[DESIGN.md](../../DESIGN.md) 右侧工作区画布、[AGENTS.md](../../AGENTS.md) §4.2/§5

## 1. 背景

现有 `run_subagent` 是一次性 fan-out：角色固定、并发 2、最多 4 个子任务，子会话用完即 dispose；没有共享任务板、成员状态、消息或只读团队面板。用户希望把“功能智能体团队”做成 Open Plan 的原生能力，但 DSH 的完整 Agent Teams 需要持久 child session、durable inbox、跨进程/文件隔离和完整恢复对账，成本和风险都超出当前单进程工作台。

## 2. 决策

采用 **Team Lite**：

1. **模式边界**：Work（`agent`）和 Review（`review`）允许 Lead 创建团队；Chat（`chat`）不暴露 `team_*` 工具，只能只读查看当前会话已存在的团队投影。
2. **人数与任务上限**：团队总人数最多 3（Lead + 2 名队友）；任务板最多 20 个任务。不做嵌套团队。
3. **队友执行**：复用 `createSubagentRunner`；每个 turn 一个隔离子会话，成员逻辑身份跨消息保留，但不是持久 child session。队友可被 `team_send` 重新唤醒，唤醒时用上一轮结果摘要 + 新消息重建上下文。
4. **共享任务板**：内存态，事件持久化；`team_task` 支持 create/claim/update/list/get，revision CAS、blockedBy DAG、owner、writeScopes 告警。`writeScopes` 只告警，不授予写权限；真实互斥仍由每文件写锁保证。
5. **消息与等待**：`team_send` 对运行中队友排队、完成后投递；对空闲/已完成队友立即唤醒。`team_wait` 边沿触发，不轮询；没有活跃队友时立即 noProgress。
6. **生命周期**：Team 绑定 Run；Run 结束/取消时 `team_closed` 并中止在飞队友。Team 不跨 Run 恢复；历史团队由事件回放只读呈现。
7. **UI 只读**：顶栏“团队 N”chip + 画布“团队”单例标签；面板只展示成员、任务板、结果/轨迹入口，不提供 spawn/interrupt/claim/改状态按钮。标签关闭只销毁视图，不终止团队；会话切换销毁团队标签，不写入 localStorage。
8. **本轮不做**：`team_escalate`、确定性任务缓存、持久 child session、跨进程/文件隔离、跨 Run 团队聚合。需要时另立 ADR。

## 3. 备选方案

- **A. 直接移植 DSH 完整 Teams**：能力强，但需要持久会话、跨进程协调、恢复对账和多层权限，超出当前 Node 单服务与 Pi 内存会话边界；否决。
- **B. 只扩 `run_subagent`**：改动小，但没有共享任务板/消息/成员状态，无法形成“团队”；否决。
- **C. Team Lite（本决策）**：复用现有 child runner、事件流、SSE、每文件锁和右侧画布；用逻辑成员 + 一次性 turn 换取低风险可验证；采纳。

## 4. 影响

- `server/团队编排器.mjs` 成为团队状态唯一事实源；`server/agent.mjs` 只负责工具接线与 child runner。
- 新增 9 个 `team_*` 事件和 5 个工具，必须同步 `事件注册表`、`task.mjs` 模式白名单、`工具元数据` 与契约测试。
- Review 的 `worker` 必须由编排器降级为 `scout`，避免团队绕过 Review 只读边界。
- 简单任务不应组队；系统提示词明确“多角色/交接/并行”才使用团队，防止成本与延迟无谓增加。

## 5. 验收

- Work/Review 可创建最多 3 人团队；Chat 无团队创建工具。
- 任务板 CAS/DAG、消息排队/唤醒、wait 边沿触发、Run 关闭取消均有测试。
- 顶栏 chip 与画布团队标签同源；关闭标签不终止团队；会话切换不串台。
- `npm run verify` 与 `test:team`、`test:team-panel` 通过。
