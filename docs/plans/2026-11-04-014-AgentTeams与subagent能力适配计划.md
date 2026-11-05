# Agent Teams 与 Open Plan 子代理能力适配计划

> 状态：**已实施（2026-11-05）；前端渲染见 §7，落地范围与验证见 §12**
> 日期：2026-11-04
> 参考：[Agent Teams 可移植实现规范](D:/dsh文件夹/Agent-Teams-可移植实现规范.md)（DSH 抽象）、[Agent Teams 机制总结](D:/dsh文件夹/Agent-Teams-机制总结.md)、本地 ZCode 逆向档案 `D:/日常任务吧/zcode-reverse/`
> 基线：`develop` @ `5f81b5ce`（含运行预算无上限、ask 30 分钟、后台任务、原生文本、按路径写锁）
> 目标文件（未来实施）：`server/子代理编排器.mjs`、`server/agent.mjs`、`server/task.mjs`、`server/事件注册表.mjs`、`client/src/components/ChatPanel.jsx`、`client/src/components/子代理详情面板.jsx`、`client/src/运行展示投影.js`

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| Open Plan 现在有 Agent Teams 吗？ | **没有。** 现在是 `run_subagent` 的一次性 fan-out：角色固定、并发 2、最多 4 个子任务、worker+verifier 一轮 revise；子会话用完即 dispose，没有持久队友、共享任务板、异步消息或团队面板。 |
| DSH 的 Agent Teams 能直接搬吗？ | **不能全搬。** DSH 规范要求持久 roster、durable inbox、任务板 CAS/DAG、事件投影、恢复对账；Open Plan 有事件流/SSE/运行记录，但子会话是内存态，任务板也只有单 Run 的 `todo`。 |
| ZCode 的 subagent 是什么？ | 两套：① `Agent`/`Task` 一次性 profile-backed subagent（隔离上下文、可选后台、返回报告）；② Dynamic Workflow 里的**命名 subagent**：`agent("name").ask<T>(...)`，人设冻结、无嵌套、按“名字 + 字节相同 instructions”做确定性缓存，支持 `escalate`（最多 3 次）与 typed result。**它不是持久人类协作团队**，没有共享任务板/成员面板。 |
| Open Plan 应该做什么？ | 做 **“专家小组”（Team Lite）**：Work 模式下 Lead + 2–3 个具名队友、共享任务板、异步消息/等待、只读团队面板；先做“一次性专家 + 共享任务板”，再升级“可续聊队友”。 |
| 迁移原则 | 复用现有事件注册表、Run 记录、SSE、每文件写锁、子代理 runner、右侧画布；**不引入数据库/消息队列/工作流编译器**；不复制 DSH 全部 33 条一致性用例，选 12–15 条核心不变量。 |

---

## 1. 参考对象与边界

### 1.1 DSH Agent Teams 的核心

DSH 规范把 Agent Teams 拆成：

- **Lead + 具名队友**：队友是独立、持久、可续聊的 child session；
- **durable inbox + steer**：运行中在 step 边界注入，空闲则唤醒；
- **共享任务板**：`task-N` 单调、revision CAS、DAG 依赖、owner、write_scopes 告警；
- **edge-triggered wait**：不轮询，只观察注册后的下一次变化；
- **只读投影 + baseline/delta**：UI 不持有可写团队状态；
- **恢复语义**：只对账 `provisioning`，不覆盖已完成/失败；
- **明确非目标**：无文件隔离、无跨进程、无嵌套 Team、无自动回收。

### 1.2 本计划的边界

- 只做 **Open Plan 的 Work 模式**（Chat/Review 是否开放团队，列入待拍板）。
- 不实现 DSH 的文件隔离、跨进程协调、嵌套 Team、自动任务回收。
- 不引入 ZCode 的 Dynamic Workflow 编译器、`hole`、`phase`、workflow 脚本执行。
- 团队是“对话式工作台里的专家小组”，不是通用多 Agent 平台。

---

## 2. Open Plan 现状（基线）

### 2.1 已具备的能力

| 能力 | 现状 | 代码 |
|---|---|---|
| 一次性子代理 | `run_subagent`：`scout/reviewer/planner/verifier/worker`，只读/可写分级 | `server/子代理编排器.mjs` |
| 并发与核验 | 最多 4 个任务、并发 2；worker 结果可交 verifier，revise 最多 1 轮 | 同上 |
| 隔离子会话 | Pi child session，独立 system prompt、工作区读取、受权写 | `server/agent.mjs` `createSubagentRunner` |
| 事件 | `subagent_planned/start/update/tool/end/result/verified/closed` 已登记、可回放 | `server/事件注册表.mjs` |
| 前端 | 对话内子代理卡 + 右侧完整过程面板 | `ChatPanel.jsx`、`子代理详情面板.jsx` |
| 运行记录 | Run、事件流、SSE、任务中心 | `server/runs.mjs`、`server/事件存储.mjs` |
| 写锁 | 每文件写锁 + bash 按目标推导 + 地图项目锁（本轮刚落地） | `server/写入协调.mjs`、`server/bash写锁.mjs` |
| 预算 | 用户会话无上限，保留操作级失败护栏 | `server/运行预算.mjs` |

### 2.2 与 DSH 的关键差距

| DSH 能力 | Open Plan 现状 | 差距 |
|---|---|---|
| 持久 roster | 无；子会话 `SessionManager.inMemory`，`finally` 里 `dispose()` | 队友无法续聊/被唤醒 |
| durable inbox/steer | 无；只有父会话 `session.steer/followUp` | 队友之间不能发消息，Lead 不能定向唤醒 |
| 共享任务板 | 只有单 Run `todo`，无 owner/revision/DAG | 不能多队友认领/交接 |
| wait | 无 | Lead 只能等 `run_subagent` 全部返回 |
| 团队面板 | 只有逐个 `SubagentCard`/详情 | 没有成员 roster、任务板、当前会话导航 |
| 恢复对账 | Run 恢复有，子代理无 | 重启后子会话状态不可恢复 |
| 权限身份 | 父会话审批 + 角色只读/可写 | 没有“live agent 身份即授权”的 TeamService |
| 投影 | 事件归约为对话卡 | 没有 `agentTeam` 投影/增量帧 |

### 2.3 已具备的“适配土壤”

- `server/事件注册表.mjs` 是唯一事件事实源，适合新增 `team_*` 事件；
- `server/runs.mjs` 有 Run 生命周期，可作为 Team 的归属边界；
- `server/写入协调.mjs` 已有每文件锁，团队写作用 `write_scopes` 做告警、不做锁；
- 右侧画布已有标签体系，可承载“团队”面板；
- `run_subagent` 的 child runner 可复用为“队友执行器”，不必从零写 Pi 子会话。

---

## 3. ZCode 的 subagent 做法（对照）

> 证据来源：本地 ZCode 逆向档案 `D:/日常任务吧/zcode-reverse/03-memory-harness/REVERSE.md`（工具表、§18 Dynamic Workflow）、`00-index/capability-map.md`、`07-handoff/CAPABILITY-HARNESS.md`；以及当前 ZCode 会话暴露的 `Agent` 工具（profile-backed subagent、`subagent_type`、`run_in_background`）。这是本地逆向/运行观察，不是官方公开规范。

### 3.1 两套 subagent

| 形态 | 机制 | 生命周期 | 适用 |
|---|---|---|---|
| `Agent` / `Task` | 一个 profile-backed subagent，隔离上下文，返回一份报告；可后台 | 调用级，一次性 | 并行研究、独立审阅、专业 judge |
| Dynamic Workflow 命名 subagent | `agent("judge").ask<T>(...)`；名字=身份、人设冻结、无嵌套 | run 级，可多次 ask | 脚本化 fan-out、管道、批次判断 |

### 3.2 ZCode 的关键设计

1. **名字 = 身份**：run 内唯一；字面量重复是编译错误；AmendWorkflow 用“名字 + 字节相同的 instructions”匹配缓存，匿名 subagent 不复用缓存。
2. **typed result**：`ask<T>` 返回结构化值，脚本消费的是值，不是自由文本。
3. **确定性缓存**：重放相同 ask 零 token；live subagent 首次写工作区后缓存失效。
4. **escalate**：subagent 遇阻可向主 agent 提问，只有提问的那个 subagent park，siblings 继续；最多 3 次，第 4 次按普通结果返回。
5. **权限隔离**：subagent permission 独立约束，child tool calls 单独审批；usage actorKind 区分 `main/subagent/workflow_child`。
6. **无嵌套**：subagent 不能调 `CreateWorkflow`；循环必须 round cap + feedback。
7. **UI**：主要是对话内工具卡/报告，不是团队 roster/任务板；没有“成员状态 + 共享任务”面板。

### 3.3 ZCode 与 DSH 的差异

| 维度 | ZCode | DSH |
|---|---|---|
| 编排方式 | 代码/脚本驱动（Dynamic Workflow） | TeamService 代码驱动 + 持久 roster |
| 生命周期 | 调用/run 级 | 持久、可续聊 |
| 通信 | `ask` 返回值 + `escalate`；无队友间自由消息 | durable inbox/steer，成员间可发消息 |
| 任务 | 脚本控制流/typed ask | 共享任务板 CAS/DAG |
| 恢复 | Workflow resume/amend + ask 缓存 | 事件日志重放 + provisioning 对账 |
| UI | 工具卡/报告 | 只读 Team 面板 + 任务板 |

**结论**：Open Plan 不应该照搬 ZCode 的 workflow 编译器；但应吸收它的 **typed result、具名 persona、escalate、权限隔离、确定性重放**。DSH 的 **持久 roster + 任务板 + wait + 只读投影** 更贴近“功能智能体团队”。

---

## 4. 建议的 Open Plan 适配：专家小组（Team Lite）

### 4.1 产品概念

- **Lead**：当前 Work 会话的主 Agent（不新增用户可见角色）。
- **Teammate**：具名专家，**总人数最多 3（Lead + 2 名队友）**；默认只读，`worker` 可写但每次写仍走现有审批。
- **共享任务板**：本轮团队可见的任务 DAG；Lead 创建，队友认领/完成；不是用户可见的 `todo` 替代品。
- **团队场景**：多章节写作、批量文档审查、多资料并行检索、报告“撰写—审阅—核验”闭环。
- **不默认常驻**：简单问答/单文件修改不组队；由能力计划或模型显式调用决定。

### 4.2 推荐角色（复用现有 role，不新增工具权限）

| 团队角色 | 复用 role | 职责 | 写权限 |
|---|---|---|---|
| 资料员 | `scout` | 检索工作区/模板/知识库，产出证据清单 | 只读 |
| 结构/方案 | `planner` | 拆章节/任务 DAG、给写作骨架 | 只读 |
| 撰稿/执行 | `worker` | 按任务写章节/表格/文件 | 工作区内写，逐次审批 |
| 审阅 | `reviewer` | 按模板/规范逐条审阅，给 issues | 只读 |
| 核验 | `verifier` | 独立复核，pass/revise/fail | 只读 |

> 不新增 Office/Team 模式；团队是 Work 模式的一种编排能力。

### 4.3 总体架构

```
Lead Agent (当前 Work 会话)
  ├─ TeamService（新，纯逻辑 + 事件）
  │    ├─ roster（Lead + teammates）
  │    ├─ task board（CAS/DAG/owner/writeScopes）
  │    ├─ inbox/steer/wait
  │    └─ escalation（队友 → Lead → 用户）
  ├─ AgentRuntimeAdapter（复用 createSubagentRunner）
  │    ├─ 一次性专家（P1）
  │    └─ 可续聊队友（P2，持久 child session）
  └─ Event/Projection
       ├─ team_* 事件写入现有事件流
       ├─ 运行展示投影派生 agentTeam
       └─ 右侧“团队”面板（只读）
```

### 4.4 与现有 `run_subagent` 的关系

| 场景 | 用哪个 |
|---|---|
| 一次并行读资料/审阅，不需要交接 | 继续 `run_subagent`（轻量、无需团队状态） |
| 多角色、多轮、任务认领/交接、共享任务板 | Team Lite |
| 生成 Word/PPT 初稿 | 继续 `editorial_pipeline`（内部已有 planner/writer/verifier） |
| 长任务转后台 | 继续后台 Job（`job_status`/`job_cancel`） |

> Team 不是替代 `run_subagent`，而是“需要持久协作”时的上层编排。

---

## 5. 数据模型与事件（适配 Open Plan）

### 5.1 归属

- `teamId` = Lead 的 `threadId` 或 Run 级 `team_<timestamp>`；建议 **按 Run 建 Team**，Run 结束团队关闭，避免跨轮残留。
- 事件全部写入现有事件流（`.oaw/events`），带 `runId/threadId/teamId`；不新建数据库。
- 任务板与 roster 可由事件重放得到；客户端只读投影。

### 5.2 新事件（需登记注册表）

```text
team_started            { teamId, leadName, members, maxTasks }
team_member_spawned     { teamId, memberId, name, role, context, status }
team_member_status      { teamId, memberId, status }   // running/inactive/provisioning/failed
team_message_queued     { teamId, messageId, from, to, bytes }
team_message_delivered  { teamId, messageId, to }
team_wait_finished      { teamId, timedOut, reason }
team_task_updated       { teamId, task }               // 含 revision/CAS
team_escalated          { teamId, memberId, questionId, question, evidence }
team_escalation_resolved{ teamId, questionId, answer }
team_closed             { teamId, reason }
```

- 事件 payload 带 `version: 1`；未知版本 → Team 失败终态（对齐 DSH）。
- 高频进度继续用 `subagent_update`（不落盘）；Team 事件只写状态变化。

### 5.3 任务板

```text
task-N:
  subject ≤200, description ≤16KB
  status: pending | in_progress | completed | deleted
  revision: 1..N（每次 CAS +1）
  ownerName?: string
  blockedBy: task-id[]
  writeScopes: string[]   // 仅告警，不做锁
  ready: derived
```

- 最多 20 个任务；`task-N` 单调，删除不回收 id。
- 依赖必须存在、无环、无自环；删除有依赖者的任务拒绝。
- `writeScopes` 只生成告警；真实互斥仍由 `写入协调.mjs` 的每文件锁保证。

### 5.4 消息

- 上限 16KB（UTF-8，含 `Team message from <name>:` 前缀）；超限硬拒绝，不截断。
- running 队友 → `session.steer`；inactive → 唤醒/新 turn；一次性专家 → 只入 inbox，下次唤醒时带上。
- 返回 messageId 只代表“已接受”，不代表已处理。

### 5.5 持久化与恢复

- **P1 一次性专家**：不需要持久 child；roster/task 事件即可恢复“谁做过什么”。
- **P2 可续聊队友**：child session 需要持久化（建议 `.规聚会话/teams/<teamId>/<member>.jsonl` 或复用现有 SessionManager 文件后端）；重启后：
  - `provisioning` 且无 live child → 按 child header/初始消息对账；
  - `active/failed` 不回滚；
  - 任务板从事件重放，owner 保留。
- 不自动回收失联队友的 task owner；由 Lead 显式 reassign/release。

---

## 6. 工具与提示词

### 6.1 建议工具面（MVP 5 个）

| 工具 | 参数 | 作用 |
|---|---|---|
| `team_spawn` | `name*`, `role*`, `task*`, `context?:fresh\|fork` | 创建/启动一个队友（Lead only） |
| `team_send` | `target*`, `message*` | 给队友/Lead 发消息（异步接受） |
| `team_wait` | `timeoutMs?` | 等下一次团队变化（10s–1h，默认 30s） |
| `team_list` | — | 成员 + 状态 + 任务板摘要 |
| `team_task` | `action*` (`create/claim/update/list/get`), `taskId?`, `expectedRevision?`, ... | 共享任务板 |

> `team_interrupt` 可作为第二个版本（Lead only）；MVP 先用 `team_send` + Run 取消。

### 6.2 提示词要点

- Team 只用于“多角色、需要交接/并行”的任务，简单任务不要组队。
- 队友默认只读；`worker` 写文件必须逐次审批；写域只作告警。
- `team_wait` 是边沿触发：不要轮询；没有活跃队友时直接报告“无进展”。
- 队友结果用结构化摘要（做了什么/证据/产物/未完成/风险），不要自由长文。
- 队友遇到只有 Lead/用户能决定的问题 → `team_escalate`（P2），不要自行扩大范围。
- 不嵌套团队；队友不能再 `team_spawn`。

---

## 7. 前端与交互（2026-11-04 定稿）

### 7.1 位置与分工：画布标签 + 顶栏 chip

两处同时存在，但职责不同，不重复渲染同一套内容：

| 位置 | 形态 | 职责 |
|---|---|---|
| 右侧画布 | 单例“团队”标签（`kind: "team"`），标签内是完整只读面板 | 看成员、任务板、成员详情；承载主要操作 |
| 全局顶栏 `topbar` | “团队”chip，显示图标 + 活跃/总数 + 状态点 | 随时知道团队在不在、是否卡住；一键打开/聚焦画布团队标签 |

> 这里的“头部”明确指 `App.jsx` 的 `.topbar`，不是 `ChatPanel` 的 `.chat-head`；后者当前被 `.center-chat-slot .chat-head { display: none; }` 隐藏，不作为团队入口。团队 chip 插在 `conversation-status` 左侧、搜索按钮右侧，不替代运行状态点。

**为什么两处都要：**

- 画布收起或正在看文档时，顶栏 chip 仍能提示“团队还在跑 / 有成员失败”，不用重新打开画布找入口；
- 画布标签负责展开细节；chip 只做摘要和入口，避免顶栏塞进任务板造成信息过载；
- 两处共用同一个 `agentTeam` 投影，不维护第二份状态。

### 7.2 顶栏团队 chip

**结构**

```text
[user icon] 团队 2/3  ●
             │    │   └─ 状态点：进行中=accent，需关注=warning，失败=error，已结束=dim
             │    └───── 活跃成员数 / 成员总数
             └────────── 固定文案“团队”
```

- 只在当前 Run 存在 Team 时出现；没有 Team 时完全隐藏，不占位。
- 高度 28px，与 `.topbar-search-btn` / `.topbar-tools-toggle` 同规格；圆角 999；默认透明，hover/active 用 `--selected`，不新增大色块。
- 状态点不能只靠颜色：`title` 与 `aria-label` 必须带文字，例如“团队 2/3，2 名成员执行中，1 个任务待验收”。
- 有任何成员 `failed`、任务 `blocked` 或待处理升级时，显示 `warning/error` 点；用户打开团队标签后清除“未读关注”点，但失败本身仍保留。
- 点击行为：打开团队标签（不存在则创建）→ 若画布被收起则展开 → 激活该标签 → 焦点移到团队面板标题。**不切换当前会话，不打断正在看的文档。**
- 会话切换 / 新 Run 没有 Team 时 chip 消失；历史 Run 的团队不在这里串台。
- 窄屏：`max-width: 1180px` 时只保留图标 + “2/3”；`max-width: 760px` 时只保留图标 + 活跃数。chip 始终 `flex: 0 0 auto`，不允许挤压标题和模式切换。

### 7.3 画布“团队”标签

- 在 `client/src/画布状态.js` 增加：
  - `VIEW_META.team = { title: "团队", icon: "user" }`；
  - `SINGLETON_TAB_KINDS` 加入 `team`；
  - `sanitizeTab` 对 `team` 返回 `null`，**不写入 localStorage**；团队跟随当前会话/Run，跨会话不恢复，避免旧团队标签指向新会话。
- 标签 id 固定为 `view:team`，标题“团队”，图标 `user`；标签右侧显示活跃成员数 badge（`tab.badge`），有失败/阻塞时显示 `tab.alert` 点。`画布标签栏.jsx` 为此增加通用的 `badge`/`alert` 渲染，不写团队特例。
- `+` 菜单不提供“团队”入口：团队只能由 Agent 的 `team_*` 工具创建，避免用户手动造一个空面板。
- 标签生命周期：

| 时机 | 行为 |
|---|---|
| `team_started` / 首个 team 事件 | 若不存在则补建标签，**不激活、不抢焦点**；画布收起时也不自动展开，只让顶栏 chip 出现 |
| 团队运行中 | badge 随成员状态更新；失败/阻塞只加 `alert` 点，不自动切标签 |
| 用户点 `×` 关闭 | 只销毁视图，不终止团队；顶栏 chip 保留，点击可重新打开。同一 Run 内不自动复活已关闭的标签 |
| 会话切换 | 销毁旧会话的团队标签；新会话若已有 `agentTeam` 投影则补建，仍不激活 |
| `team_closed` | 标签保留为只读快照，标题旁状态改为“已结束”；chip 变暗，不立即消失，方便回看 |
| 重连 / 历史恢复 | 用 baseline 重建；baseline 不完整时面板显示“状态待同步”，不猜测成员状态 |

### 7.4 面板布局

**默认宽度 420px（画布默认宽度）——单列：**

```text
┌ 团队  2/3 活跃   Lead：规划中             只读 ┐
│ [林规划  Lead ●] [周写作 ●] [陈审阅 ○]          │  ← 成员条，横向可滚
│ 任务板   全部 5 · 进行 2 · 待验收 1 · 完成 2    │
│ ─ 进行中 ───────────────────────────────────── │
│ ┌ T2  撰写第 3 章                周写作 · Rev.3 ┐│
│ │ 依赖 T1 · 写域：第3章.md                      ││
│ └───────────────────────────────────────────────┘│
│ ─ 待认领 ───────────────────────────────────── │
│ ┌ T3  核对引用来源                未分配        ┐│
│ └───────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

- 顶部 40px 摘要条：团队状态 + Lead 当前动作 + “只读”提示（用 `title` 说明，不放大段说明文字）。
- 成员条：每个成员一张 112–128px 的小卡，含状态点、名字、角色、当前任务一行；Lead 固定第一张，带 `Lead` 小标签。超过 3 人横向滚动，不换行撑高。
- 任务板：按状态分组，不采用横向 Kanban 列（420px 放不下四列）。分组顺序固定为 `进行中 → 待认领 → 待验收 → 已结束`；空分组不渲染。
- 任务卡：`任务号 + 标题 + owner · Rev.n` 一行，第二行显示依赖、写域告警；点击/回车展开描述与最近活动，再点收起。卡片不是编辑表单。
- 成员详情：点击成员卡后，整块面板切换为成员详情（不是再开一个画布标签）：

```text
← 返回团队
林规划   Lead · 进行中
当前任务：T1 拆解章节
最近活动：已创建 T1/T2/T3，等待周写作认领
[打开完整轨迹]
```

**画布宽度 ≥ 560px——两栏：**

```text
┌ 成员 168px ─┬ 任务板 / 成员详情 ──────────────┐
│ Lead        │ 进行中                           │
│ 周写作      │ T2 撰写第 3 章                  │
│ 陈审阅      │ T3 核对引用                     │
└─────────────┴──────────────────────────────────┘
```

- 左栏成员列表固定 168–184px，右栏默认任务板；点成员后右栏切换为详情，左上角“返回团队”回到任务板。
- 画布 320–559px 用单列成员条 + 全屏详情；≥560px 用两栏。所有断点以画布自身宽度为准，不用视口宽度猜。
- 团队标签不显示右侧文件树抽屉：`sideDrawerAllowed` 只允许 doc/artifacts/changes，团队标签下抽屉自动收起，避免挤占 420px 主区。

### 7.5 组件树与职责

```text
App
├─ TeamHeaderChip({ team, active, onOpen })          // topbar
└─ canvas-body-team
   └─ TeamPanel({ team, onOpenTranscript })
      ├─ TeamSummary({ team })
      ├─ TeamRoster({ members, leadId, selectedId, onSelect })
      │  └─ TeamMemberCard({ member, selected, onSelect })
      ├─ TeamTaskBoard({ tasks, filter, onFilter, onToggleTask })
      │  ├─ TeamTaskGroup({ status, tasks })
      │  └─ TeamTaskCard({ task, expanded, onToggle })
      └─ TeamMemberDetail({ member, onBack, onOpenTranscript })
```

- `TeamPanel` 只接收投影和回调，不自己 fetch、不自己拼 SSE。
- 允许的本地 UI 状态仅三个：`selectedMemberId`、`taskFilter`、`expandedTaskId`；`team.id` 变化时全部重置。成员状态、任务状态、计数、失败原因一律来自 `agentTeam`，不复制进 state。
- `TeamMemberCard` 用 `<button>`，`aria-pressed` 表示当前选中；`TeamTaskCard` 用可展开的 `<button aria-expanded>`；两者都只读。
- “打开完整轨迹”复用现有 `createSubagentTab(block)` + `子代理详情面板`：P1 一次性队友有 transcript 时显示；没有 transcript 的成员隐藏按钮，不伪造空面板。
- 面板内不出现 spawn、interrupt、认领、改状态、删除任务按钮；所有写操作只由模型工具发起。

### 7.6 数据契约与事件映射

新增纯函数投影 `agentTeam`，放在 `client/src/运行展示投影.js`（或同层新文件），输入为 Run 的 baseline + 事件序列：

```js
{
  id, runId, sessionId,
  status: "provisioning | active | attention | completed | failed | closed | unknown",
  leadId,
  members: [{
    id, name, role, status,          // provisioning/active/idle/completed/failed/cancelled
    currentTaskId, activity, lastSeq,
    subagentId, transcriptAvailable
  }],
  tasks: [{
    id, title, status,               // pending/claimed/running/blocked/review/done/failed/cancelled
    ownerId, blockedBy: [], writeScopes: [],
    revision, updatedSeq, description, result
  }],
  counts: { members, activeMembers, tasks, doneTasks, blockedTasks },
  stale: false,
  lastSeq
}
```

- 事件映射：`team_started` 初始化 roster；`team_member_spawned` 增加 provisioning 成员；`team_member_status` 更新成员状态/当前任务/活动；`team_task_updated` 按 taskId upsert，`revision` 只增不减；`team_message_*` 只更新最近活动时间线；`team_wait_finished` 写一条团队活动；`team_closed` 合并最终快照并置终态。队友完成时把结果自动写回其当前认领任务的 `result`，`team_task get/list` 的模型可见文本必须带出该结果（不能只放 details），否则 reviewer 无法交接复核。
- `seq` 去重、乱序丢弃；`revision` 回退忽略；未知事件保留原状态，不把团队误判为完成。
- 重连/历史恢复：先取 Run baseline，再按 `lastSeq` 追事件；baseline 缺失或只到一半时 `stale: true`，面板显示“状态待同步”，chip 用 dim 点。
- 当前会话可能有多轮 Run：MVP 的团队面板只绑定“当前对话展示的 Run”；该 Run 没有 Team 就隐藏。历史 Run 的团队查看放到 P3 任务中心，不在本 MVP 做跨 Run 聚合。
- 对话内仍保留 `SubagentCard` 呈现一次性 `run_subagent`；Team 成员不重复生成一张大卡，只在会话里出现一条轻量系统行“团队已启动 · 2 名队友”，点击打开团队标签；任务板变化不做逐条刷屏（最多在团队标签 badge 上体现）。

### 7.7 状态、空态与异常

| 状态 | 面板 | chip |
|---|---|---|
| 无 Team | 标签不存在 | 隐藏 |
| 组队中（provisioning） | 成员卡显示“创建中”，任务板可空 | 显示 `0/N`，dim 点 |
| 运行中 | 正常 roster + 任务板 | `活跃/总数`，accent 点 |
| 有失败/阻塞/待升级 | 顶部 warning 条，列出成员或任务 | warning/error 点 |
| 已结束 | 只读快照，标题“已结束” | dim 点，保留入口 |
| 团队失败 | 顶部 error 条 + 失败原因 | error 点 |
| 状态待同步 | 骨架/上次快照 + “状态待同步” | dim 点 |
| 无任务 | “Lead 尚未拆解任务”空态 | 正常显示 |
| 无成员（除 Lead） | “正在召集队友” | `0/1` |

- 加载用静态骨架（3 条灰块），不新增无限旋转动画；失败/待同步用文字 + 图标，不只靠颜色。
- 任何 `team_*` 事件都不自动把画布切到团队标签；关注的表达只在 chip/tab 的点上。

### 7.8 视觉与无障碍

- 全部使用现有设计令牌：`--panel-bg / --panel2-bg / --selected / --border / --text / --muted / --dim / --accent / --success / --warning / --error / --radius-md`；不新增硬编码颜色。
- 尺寸：chip 28px 高；面板摘要 40px；成员卡 112–128px 宽、约 56px 高；任务卡内边距 8–10px；正文 12px，名字/标题 13px；行高 1.45–1.5。沿用 12/13/14px 字阶，不引入新字号。
- 视觉轻重：面板用 1px 分隔线和 `--selected` 选中底色，不套多层卡片边框；成员状态点 6px，任务状态用文字 + 小图标；不新增大面积色块。
- 动效：不新增无限循环动画；成员状态切换用现有 CSS transition（≤160ms），`prefers-reduced-motion` 下关闭。失败提示不抖动。
- ARIA：chip 是 `button`，`aria-label` 包含团队状态与计数；画布标签沿用现有 `role="tab"` / `aria-selected`；面板容器 `role="tabpanel"`、`aria-label="团队"`；成员列表 `role="list"` + 每项 `button`；任务卡展开按钮 `aria-expanded`；失败条 `role="alert"`，普通计数变化不 `aria-live`，避免刷屏。
- 键盘：chip `Enter/Space` 打开；面板内成员卡 `↑/↓/Home/End` 移动、`Enter` 打开详情；详情 `Esc` 或“返回团队”回到任务板；标签切换沿用 `Ctrl+Tab` / 方向键；关闭详情后焦点回到原成员卡。
- 焦点：从 chip 打开时焦点落到面板标题（`tabIndex=-1`），不落到第一个可操作项，避免误触；后台自动建标签不移动焦点。

### 7.9 验收与测试

- 源码契约测试 `scripts/团队面板契约测试.mjs`：
  - `VIEW_META.team`、`SINGLETON_TAB_KINDS`、`sanitizeTab` 不持久化；
  - chip 只在 `team` 存在时渲染；面板无 spawn/interrupt/任务写按钮；
  - `TeamPanel` 不包含 fetch/SSE 订阅，业务字段来自 props；
  - `badge/alert` 是标签栏通用能力，不是团队硬编码。
- 投影测试：`team_started → member_spawned → task_updated → member_status → closed` 的 roster/task/counts；乱序 seq、旧 revision、baseline 缺失、重连追平；无 Team 不生成空对象。
- 浏览器验收（浅色/深色，1440 / 1024 / 760 视口）：
  - 团队启动后 chip 出现、标签补建但不抢焦点；画布收起时 chip 仍可打开；
  - 关闭标签后 chip 可重开，团队不中断；会话切换后旧团队标签消失；
  - 成员详情返回、任务展开、badge/alert 更新、窄屏单列不横向溢出；
  - 键盘 Tab/Enter/Esc 与焦点返回正确。
- 实施时同步 `DESIGN.md` §315–316（画布标签清单、顶栏入口）与组件清单；本计划不替代 DESIGN 的长期规范。

### 7.10 明确不做（本面板）

- 不做团队聊天气泡/群聊窗口；成员消息只在详情“最近活动”里摘要。
- 不做拖拽任务卡、手动改状态、手动认领、手动 spawn/interrupt。
- 不做跨 Run/跨会话团队聚合；不做团队历史对比。
- 不做团队标签的 localStorage 恢复；不把团队写进画布持久化。

### 7.11 实施分层（与 §9 对齐）

| 阶段 | 本面板交付 |
|---|---|
| P1 | chip + 团队标签 + roster + 任务板分组 + 成员详情 + 空态/失败态；事件投影与 badge/alert；写域只做文本展示 |
| P2 | 最近活动/消息摘要、升级提示、`team_closed` 后快照、重连 `stale` 状态 |
| P3 | 任务筛选、写域重叠告警、历史 Run 团队查看、完整键盘/无障碍与浏览器视觉验收 |

---

## 8. 权限与安全

1. **Lead only**：`team_spawn`/`team_interrupt` 只允许 Lead；队友工具集不含这些。
2. **身份即授权**：Team 工具调用携带精确的 live agent/childId；不能只传 name。
3. **子代理权限隔离**：沿用现有 `SUBAGENT_ROLES` 只读/可写；`worker` 写操作仍走 `requireToolApproval`。
4. **写域只告警**：`writeScopes` 不阻塞 claim、不做授权；真实互斥靠每文件锁。
5. **消息不信任**：队友消息是模型输入，可能含提示注入；工具层仍保留审批/沙箱。
6. **大小限制**：消息 16KB、任务描述 16KB、成员名 ≤64、任务数 ≤20。
7. **UI 只读**：面板无写操作；避免双写入口与误操作。

---

## 9. 分阶段计划

### P0：本文档与决策（当前）

- 产出本计划；确认范围、角色、上限、UI 位置。
- 不修改代码。

### P1：Team Lite（一次性专家 + 共享任务板，约 1–2 周）

- 新增 `server/团队编排器.mjs`（纯逻辑：roster/task/CAS/DAG/消息队列）；
- `run_subagent` 不改；新增 `team_*` 工具（MVP 5 个）；
- 队友仍是一次性 child（复用 `createSubagentRunner`），任务完成后 dispose；
- 事件 + 投影 + 基础团队面板（成员/任务板只读）；
- 验收：
  - Lead 可创建 2 个队友，分别认领不同任务并完成；
  - 任务 CAS 并发只有一个成功；DAG 环被拒绝；
  - 两个队友写不同文件不互相阻塞（复用每文件锁）；
  - 面板能看到成员/任务，刷新后从事件重放；
  - 不嵌套、不超员、消息超限被拒绝。

### P2：可续聊队友 + 消息/等待/中断（约 2 周）

- child session 持久化；`team_send` running→steer、inactive→唤醒；
- `team_wait` 边沿触发；`team_interrupt`（keepInbox）；
- `team_escalate`（队友 → Lead → 用户），最多 3 次；
- 恢复对账：provisioning → active/failed；active/failed 不回滚；
- 验收：队友跨 turn 保留上下文；Lead 能等一次团队变化；中断保留任务 owner；重启后 roster 对账正确。

### P3：团队面板完善 + 一致性测试（约 1 周）

- 成员导航、任务板筛选、写域告警、重连 baseline/delta；
- 适配 DSH 一致性用例子集（见 §10）；
- 浏览器/无障碍/窄屏测试。

### P4（可选）：吸收 ZCode 的确定性能力

- 结构化 `team_result`（typed envelope：status/evidence/artifacts/notCovered）；
- 重复团队任务按“成员名 + 字节相同任务”缓存结果（类似 ZCode Amend 缓存），用于重跑/失败重试；
- fresh-eyes verifier 已是现有能力，继续保留；
- 不做 workflow 编译器/hole/phase。

---

## 10. 一致性测试子集（从 DSH C01–C33 中选）

建议先实现 15 条：

| 编号 | 用例 |
|---|---|
| T01 | 普通 Work 会话 `team_list` 为空；非 Lead 不能 spawn |
| T02 | 名字非法/重复/超长 → 拒绝；失败成员名字不复用 |
| T03 | spawn 顺序：provisioning → 启动成功 → active；启动失败 → failed |
| T04 | 超 maxMembers / maxTasks → 拒绝 |
| T05 | 任务 create revision=1、id 单调；删除不回收 |
| T06 | 并发 claim 同 revision 只有一个成功，另一个 STALE_REVISION |
| T07 | blockedBy 未完成不能 claim；自环/环/缺失依赖拒绝 |
| T08 | complete/reopen/delete 状态机正确；删除有依赖者拒绝 |
| T09 | writeScopes 重叠只告警，不阻塞 claim |
| T10 | 消息超 16KB 拒绝；发给自己拒绝；目标不存在拒绝 |
| T11 | running 队友消息在下一步可见；inactive 被唤醒 |
| T12 | wait 边沿触发；无活跃队友返回 noProgress；注册前变化不唤醒 |
| T13 | interrupt 只取消当前 turn，保留 inbox/任务 owner |
| T14 | 事件重放得到相同 roster/task；客户端乱序/重复 seq 不回退 |
| T15 | 重启后 provisioning 对账；active/failed 不回滚；Team 面板只读 |

---

## 11. 风险与待拍板

| 风险 | 缓解 |
|---|---|
| 团队让简单任务变慢/变贵 | 只在复杂写作/审查触发；默认 2 队友；无上限预算下仍需成本可见 |
| 子会话持久化复杂 | P1 先一次性专家，P2 再做可续聊；不阻塞 |
| 队友写文件冲突 | 每文件锁 + writeScopes 告警；同文件仍串行 |
| 消息注入 | 队友消息按不可信输入处理；工具审批不放松 |
| 事件膨胀 | 高频进度不落盘；Team 事件只写状态变化；上限 20 任务 |
| 与 `run_subagent` 重叠 | 明确分工：一次 fan-out 用 run_subagent，持久协作才用 Team |
| 与 `editorial_pipeline` 重叠 | 流水线继续负责“生成初稿”；Team 负责“多角色协作/审查”，不替代 |

### 需要你拍板

1. **范围**：**已定（2026-11-04）**：Work / Review 都可创建团队；Chat 只能只读查看，不暴露 `team_*` 创建工具。
2. **先做哪层**：**已定**：已落地“一次性专家 + 共享任务板 + 消息/等待”；同 Run 内可 message 唤醒逻辑队友，但 child session 仍按 turn 重建。
3. **人数**：**已定**：团队总人数最多 3（Lead + 2 名队友），不是 3 名队友再加 Lead。
4. **写权限**：**已定**：Work 的 `worker` 可写且逐次审批；Review / Chat 的 `worker` 由编排器降级为 `scout`，不越权写文件。
5. **UI 位置**：**已定（2026-11-04）**：右侧画布“团队”单例标签 + 全局顶栏“团队 N”chip，二者同源；不做抽屉。
6. **ZCode 能力**：**本轮不做**：`team_escalate`、确定性任务缓存、持久 child session 留在 P4；先保证 roster/任务板/消息/投影稳定。

### 建议

先做 **P1 Team Lite**：一次性专家 + 共享任务板 + 只读面板。它风险最低，能验证“团队”是否真的提升多章节写作/审查；等任务板与投影稳定，再做 P2 可续聊队友与消息唤醒。

---

## 12. 实施记录（2026-11-05）

### 12.1 已落地范围

| 项 | 实现 |
|---|---|
| 模式 | Work / Review 可创建；Chat 无 `team_*` 工具，只读查看同一投影 |
| 人数 | 最多 3（Lead + 2 名队友）；任务最多 20 |
| 工具 | `team_spawn`、`team_send`、`team_wait`、`team_list`、`team_task` |
| 编排器 | `server/团队编排器.mjs`：roster、任务板 revision CAS/DAG、writeScopes 告警、消息队列、边沿等待、Run 关闭取消 |
| 队友执行 | 复用 `createSubagentRunner`；一次 turn 一个隔离子会话，成员逻辑身份跨消息保留；不做持久 child session |
| 事件 | `team_started`、`team_member_spawned`、`team_member_status`、`team_member_result`、`team_message_queued/delivered`、`team_wait_finished`、`team_task_updated`、`team_closed` 已登记 |
| 投影 | `client/src/团队投影.js` 纯函数归约；顶栏 chip / 画布面板共用 |
| UI | 画布 `kind: "team"` 单例标签（不持久化）+ 顶栏 `TeamHeaderChip` + `TeamPanel` 只读面板；窄屏/两栏按画布容器宽度切换 |
| 测试 | `test:team`、`test:team-panel`、`test:event-registry`、`test:tool-metadata`、`test:capability-contract`、`npm run verify` |

### 12.2 明确边界

- Team 绑定 Run；Run 结束/取消时 `team_closed` 并中止在飞队友，不跨 Run 恢复。
- 队友不能创建团队/队友；`team_task create` 仅 Lead；`worker` 在 Review 自动降级。
- 面板只读：不提供 spawn/interrupt/claim/改状态按钮。
- 本轮不含 `team_escalate`、持久 child session、跨进程/文件隔离、嵌套团队、跨 Run 团队聚合。

### 12.3 验证命令

```bash
npm run -s test:team
npm run -s test:team-panel
npm run -s test:event-registry
npm run -s test:tool-metadata
npm run -s test:capability-contract
npm run verify
```

浏览器验收：团队事件注入后顶栏 chip 出现、画布自动补建“团队”标签但不抢焦点；关闭标签后 chip 可重开；成员详情/任务分组/两栏容器查询正常；窄屏 chip 收为计数。
