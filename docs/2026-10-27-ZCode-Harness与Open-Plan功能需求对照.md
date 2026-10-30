# ZCode Harness 与 Open Plan（规聚）Harness 功能需求对照

> 状态：已完成（分析）
> 基线：v0.11.55（develop，工作区含未提交改动）
> 更新：2026-10-27
> 关联：[AGENTS.md](../AGENTS.md) / [REQUIREMENTS.md](../REQUIREMENTS.md) / [DESIGN.md](../DESIGN.md) / [Qoder 对标整改计划](plans/2026-10-18-001-Qoder对标整改与交通规划Harness迭代修改计划.md) / [ZCode 交接文档](file:///D:/日常任务吧/zcode-reverse/07-handoff/CAPABILITY-HARNESS.md)
> 范围：只做能力与架构对照，不修改任何代码。配套清单见 [ZCode-Harness 对标功能需求梳理清单](2026-10-27-ZCode-Harness对标功能需求梳理清单.md)。
> 后续：本对照已收敛为 [ZCode-Harness 工程对照与修改计划](plans/2026-10-27-004-ZCode-Harness工程对照与修改计划.md)；本文保留为证据与详细分析来源。

---

## 0. 结论先行

1. **两者不是同一类 harness。** ZCode 是“自研内核 + 六层可独立治理的 harness”；Open Plan 是“Pi SDK 内核 + 外围产品化 harness”。ZCode 的五项 P0 中，工具元数据、权限决策、结果外置、用量采集都与 Pi 内核的工具执行/事件流强耦合，**不能整包照抄**；只有记忆四件套完全在外围可控。
2. **17 项能力覆盖：基本对齐 2 项、部分对齐 10 项、缺失 5 项。** 基本对齐是上下文压缩（H-07）与 MCP（H-15）；缺失是语义召回（H-04）、记忆自动抽取（H-05）、TS 动态工作流（H-10）、计划模式（H-14）、定时/空闲调度（H-16）。
3. **架构上最大的两个差别是“治理时机”和“事实来源”。** ZCode 每次工具调用必过治理层、以关系型表为事实；Open Plan 只对副作用工具做审批、以事件注册表/事件流为唯一事实。前者治理更彻底，后者回放与审计更彻底。
4. **Open Plan 在 6 个方向反而领先：** 事件注册表与回放、写入协调、产物验收/发布/回滚、完成语义、首字延迟分段、领域硬约束。对标不应把领先项“抹平”成 ZCode 的形态。
5. **最值得补的只有 6 项：** 工具能力元数据、权限决策可审计、工具结果外置、用量归集、记忆召回、记忆自动抽取。其余按 P1/P2 排序，或明确不引入。
6. **H-10/H-14/H-16 不建议照搬。** TS 动态工作流、PlanMode、Cron/OffPeak 与“本地优先交通规划工作台”的产品形态不匹配，且会触碰“不改内核、不新增产品形态、默认开关关闭”的宪法边界。

---

## 1. 对照方法与判定口径

### 1.1 证据来源

| 侧 | 证据 | 说明 |
|---|---|---|
| ZCode | `D:\日常任务吧\zcode-reverse\07-handoff\CAPABILITY-HARNESS.md` §1（H-01–H-17）、§2（分层落地）、§3（交接契约）、§5（验收）、§6（边界） | 逆向交接文档，按“能力基线”使用，不当作逐行源码事实 |
| Open Plan | `server/` 实际代码 + `package.json` 脚本 + `docs/plans/` 既有对标记录 | 代码为证据；计划项不视为已实现项 |
| 已有对标 | Qoder 对标计划 001/003 与 `运行开关.mjs` | 用于区分“已落地但默认关”和“完全未做” |

### 1.2 判定档位

| 档位 | 含义 |
|---|---|
| **基本对齐** | 能力存在，主要语义与 ZCode 等价，差异只在实现形态 |
| **部分对齐** | 关键子能力存在，但缺少 ZCode 的某些契约（如元数据、审计、归因、缓存） |
| **缺失** | 没有对应机制，或只有间接替代 |
| **形态不同** | 用另一种架构解决同一问题，不能简单判优劣 |
| **内核边界内** | 能力位于 Pi SDK 内部，本仓库不可直接修改，只能在外围近似 |

### 1.3 读法

- “ZCode 基线”列描述的是交接文档声明的能力，不代表 Open Plan 必须逐条复刻。
- “Open Plan 现状”列只写**代码里能验证的事实**；凡标“未见”均指本轮静态检索未发现，不等于绝对不存在。
- 行号基于 v0.11.55 develop 当前工作区，后续改动可能漂移。

---

## 2. 总体定位对照

| 维度 | ZCode | Open Plan（规聚） |
|---|---|---|
| 内核 | 自研 harness 与执行引擎一体 | Pi SDK 1.1.0 进程内嵌入，不 fork、不修改 |
| 产品形态 | 通用编码 Agent，多客户端（桌面/CLI/插件） | 交通规划本地优先 AI 工作台，Chat / Work / Review 三模式 |
| 一等公民 | 会话、消息、工具、工作流 | 任务（Run）、事件、产物、地图项目、知识库 |
| 权限哲学 | 默认安全：plan / guarded / yolo + 17 级有序链 | 默认可用：默认 allow，对危险动作 ask；模式工具白名单前置 |
| 存储 | 关系型表（session / message / part / usage / artifact） | 文件 + JSONL（宪法禁止数据库） |
| 事实来源 | 持久层表 | 事件注册表 → 事件流 JSONL → Run 记录/前端投影 |
| 编排 | 模型自治 + 平台原语（Agent / Workflow / Todo） | 代码编排（子代理编排器 / 编辑流水线）+ 声明式领域工作流 |
| 扩展 | Hook / Plugin / MCP 生态 | Pi Extensions + MCP + Skills 目录 |
| 观测 | usage 表 + OTel trace + rollout | stats/context_usage + 首字延迟 + 运行预算/轨迹 |
| 领域 | 通用 | 交通规划硬约束（坐标、记录数、写回保护、产物根） |
| 失败语义 | finish_reason / 重试 / 审计 | 完成声明 + 推断 + 客观下调 + 产物验收 |

---

## 3. 六层架构对照

### 3.1 两边的层图

**ZCode（交接文档 §2.1）**

```text
┌ 观测层  model_usage · tool_usage · turn_usage · OTel trace · rollout 全量 I/O
├ 持久层  memory/*.md + MEMORY.md · artifacts · session/message/part · dwf_*
├ 编排层  Agent(subagent) · CreateWorkflow/Amend/Resume · escalate · Todo
├ 治理层  PermissionService(17 级) · Hook(7 事件) · PlanMode · 审批继承
├ 上下文层 Section 组装 · 压缩 · Skill/Plugin 注入 · 记忆三层注入
└ 执行层  工具集 · 并发调度(10) · Bash 环境 · MCP 客户端
```

**Open Plan（按代码归纳）**

```text
┌ 呈现层  SSE 通道（游标/回放） · 任务中心 · 产物面板 · 浏览器面板
├ 产品层  模式能力白名单（chat/office/agent/review） · 能力计划 · 输出策略
├ 观测层  stats/context_usage · 首字延迟 8 阶段 · 运行预算/轨迹 · 运行评测
├ 持久层  事件注册表 → 事件流 JSONL（归档/索引/回放） · Run JSON · 会话 JSONL
│          · memory/MEMORY.md · 记忆建议 · 权限/待审批 · 暂存区/发布台账
├ 编排层  Pi 回合循环 · 子代理编排器（角色/并发/核验） · 编辑流水线 · 声明式领域工作流
├ 治理层  工具审批（allow/ask/deny） · Review 写保护 · 写锁/暂存 · 领域硬约束 · 浏览器接管
├ 上下文层 Pi 基础提示词 + 静态 agentsFile + 每轮动态上下文 + 记忆摘要 + 引用
└ 执行层  Pi 工具集 + 40+ 自定义工具 + 子代理隔离会话 + MCP
```

### 3.2 层间契约差异

| 契约 | ZCode | Open Plan |
|---|---|---|
| 执行 → 治理 | 每次调用必过治理层 | 只有副作用工具调用审批；只读工具直通 |
| 治理 → 观测 | 治理不得绕过观测记账 | 审批事件落事件流；普通只读调用不单独记账 |
| 上下文 → 持久 | 上下文层只读持久层 | 每轮读取工作区 `AGENTS.md`/`memory/*.md`，并写 `.agent-context*.md` 快照 |
| 编排 → 持久 | 每个编排节点必须有持久投影 | 子代理每个节点发注册事件（planned/started/result/verified/closed） |
| 工具 → 结果 | resultBudget 统一外置 | 工具自行截断（16K 字符）；产物走独立暂存/验收/发布链路 |

**解读：** ZCode 的契约是“统一管道”，Open Plan 的契约是“事件即事实 + 产物独立生命周期”。两者都自洽，但把 ZCode 的“统一管道”硬套到 Open Plan，会与 Pi 内核的工具执行模型冲突。

---

## 4. 17 项功能逐项对照

| ID | 能力 | ZCode 基线 | Open Plan 现状（证据） | 判定 | 差距要点 |
|---|---|---|---|---|---|
| **H-01** | 工具注册与元数据 | 五维元数据（readOnly/destructive/concurrentSafe/sideEffectScope/riskLevel/needsApproval）+ resultBudget + 并发调度 | `defineTool` 只有 label/description/parameters；模式白名单在 `server/task.mjs:16-41`；自定义工具清单在 `server/agent.mjs:3070-3071` | **部分对齐** | 缺统一元数据、风险分级、结果预算、并发声明；MCP annotations 明确不可信（`agent.mjs:1126-1140`） |
| **H-02** | 权限决策 | 17 级有序链、命名 ruleId、plan 只读沙箱、子 agent 不放宽 | 3 值 + 通配 + 最后匹配（`server/审批策略.mjs:18-59,97-112`）；持久化 `.oaw/permissions.json`；5 分钟超时（`:13,199-260`）；auto 只把 ask 提升为 allow，deny 不可绕过（`:110-111`） | **部分对齐** | 无 ruleId、无 17 级链、无 plan 沙箱；只对副作用工具执行审批；子代理通过“worker 降级 scout”实现不放宽（`子代理编排器.mjs:38-43`） |
| **H-03** | 项目记忆（文件型） | 一条记忆=一个文件；frontmatter type；`MEMORY.md` 索引 200 行/25KB | 工作区 `memory/MEMORY.md` 按分类分节、条目为 `- 事实`（`server/记忆管理.mjs:229-267`）；建议生命周期 create/edit/reject/approve/merge/history（`:146-334`） | **部分对齐** | 缺“一事实一文件”、frontmatter type、索引截断契约；但**治理强度高于 ZCode**（准入规则 + 人工审核 + 合并 + 版本历史） |
| **H-04** | 语义召回 | manifest + 模型选择（JSON schema）+ 60KB 上限 + 逐条“可能过时”警告 | 每轮全量注入记忆摘要，总预算 2800 字符（`server/agent.mjs:818-826,4323-4400`） | **缺失** | 无 manifest、无模型选择、无逐条时效警告；多项目/长记忆时会截断且不可审计 |
| **H-05** | 记忆自动抽取 | 散文 ≥3 词且本轮未直接写 → 后台子 agent，5 轮预算 | 由系统提示要求模型在回合结束主动调用 `memory_update`（`agent.mjs:1090,2520`）；无调度器/词数触发/预算 | **缺失** | 是否沉淀取决于模型自觉；可能漏记或过度提交 |
| **H-06** | 上下文组装 | 10 个固定 Section，标注 injectionTarget/system 与 cacheHint/stable | Pi 基础提示词 + `agentsFilesOverride` 静态 `.agent-context.md` 大段规则（`agent.mjs:1074-1100`）+ 每轮动态上下文（`:3875-3918,4323-4400`）+ taskSummary + references | **部分对齐** | 无 Section 契约、无 stable/dynamic 标记、无按 Section 单测；提示词规则硬编码且体量大，缓存友好性弱 |
| **H-07** | 上下文压缩 | 摘要化旧工具结果，关键结论保留 | Pi 原生 compaction（reserve/keepRecent）+ 阈值 + `context_compacting/compacted/warning/compaction_failed` 事件 + 精确 `context_usage`（`agent.mjs:440-446,3348-3391,3700-3714`；`事件注册表.mjs:106-113`） | **基本对齐** | 压缩策略由内核决定，外围只做阈值、事件与失败可见化；缺“关键结论落记忆/artifact”的强制引导 |
| **H-08** | Skill 注入 | 调用时注入 `<skill_content>` 块；元数据预算 ≤20KB | `noSkills: true` 不注入目录（`agent.mjs:1058-1064`）；提供 `skills_search/skills_read` 按需读取（`:1886-1918`） | **部分对齐** | 无 `<skill_content>` 注入、无元数据预算、`skills_read` 直接返回全文；好处是降低每轮上下文成本 |
| **H-09** | 子 agent 派发 | 独立 session、profile 快照冻结、父工具可追溯、支持后台 | 独立 Pi 子会话；5 种角色（`子代理编排器.mjs:26-32`）；并发 2、最多 4 任务、verifier+revise 1 轮（`:16-21,132-282`）；roster 事件持久化；`run_subagent` 定义见 `agent.mjs:2926-2985` | **部分对齐** | 编排确定性/对抗核验更强；缺 profile 快照、后台运行、子代理 token 计量；子会话按设计不继承父上下文 |
| **H-10** | 动态工作流 | TS 脚本 facade（agent/hole/world.run/artifact/channel/future）+ journal + amend 零 token 重放 | 声明式领域工作流 6 个（`server/工作流/`）+ 技能型内置工作流 4 个（`server/workflows.mjs:1-14`）+ 编辑流水线（Planner→Writer→Formatter→Evaluator） | **缺失** | 无脚本引擎、journal、缓存重放、hole/fill；但领域 preflight 与产物契约是 ZCode 没有的 |
| **H-11** | Artifact 外置 | >30KB 工具结果落盘 + 预览；maxInline 与 maxModel 分离；Bash 取 tail | 工具输出统一截断 16000 字符（`agent.mjs:281-306`）；**没有通用结果外置**；但有完整产物链路：暂存/校验/验收/发布/回滚（`写入协调.mjs:344-603`、`成果验收.mjs:164-365`、`成果管理.mjs:142-238`） | **部分对齐** | 大输出会丢内容；但“用户产物”的生命周期管理强于 ZCode（ZCode 的 artifact 是工具结果外置，不是交付物验收） |
| **H-12** | 用量与 trace | usage 表含 actor_kind/query_source/TTFT/tool_call_count/finish_reason + traceId/spanId + rollout | 每回合 `stats`（input/output/cacheRead/cacheWrite/context/total/cost，`agent.mjs:3113-3135`）；`context_usage`；首字延迟 8 阶段 P50/P95（`首字延迟.mjs:23-66,217-241`）；Run 事件流/轨迹 | **部分对齐** | 无 usage 表、无 actor_kind/query_source、无 OTel/rollout；未见子代理 token 计量；有成本字段但未做归集报表 |
| **H-13** | Hook | 7 事件 + allow/deny/permissionUpdates/updatedInput + 7 态信任 + 四层开关 | Pi Extension API（代码扩展）；内置 `工作台把关.mjs` 做 tool_call 拦截与压缩钩子（flag 默认关）；项目信任为 SDK 薄封装（flag 默认关，`项目信任.mjs:25-59`） | **部分对齐** | 无声明式 Hook 契约、无权限更新/输入改写、无 7 态信任、无 `UserPromptSubmit/Stop` 等通用事件 |
| **H-14** | 计划模式 | 模型主动进入；`.zcode/plans/plan-*.md`；只读沙箱 | 无 PlanMode；用 `todo` + 任务中心 + Review 只读白名单替代 | **缺失** | 不建议新增用户可见模式；可考虑“计划文件持久化”而不引入新权限模式 |
| **H-15** | MCP 接入 | `mcp__<server>__<tool>`；配置化 | stdio/http；每服务 ≤100 工具、schema ≤128KB（`mcp管理.mjs:12-13`）；默认 ask；annotations 不作为授权依据（`agent.mjs:1126-1140`）；命名 `mcp_<serverId>_<tool>_<hash>` | **基本对齐** | 命名不同；信任策略更保守；无 `mcp__` 语义前缀 |
| **H-16** | 定时/空闲调度 | cron / automation / 空闲 ticket | 未见 | **缺失** | 本地工作台价值有限；若做需新调度器，触碰“不引入消息队列/服务拆分”边界 |
| **H-17** | 插件体系 | 插件包贡献 skills/agents/hooks/mcp；原子安装 | Pi 扩展登记（路径/启停/需新会话，`pi扩展管理.mjs`）+ MCP + Skills 目录 | **部分对齐** | 无包清单/版本/贡献模型/原子安装/市场；扩展是代码路径而非声明式包 |

### 4.1 覆盖统计

| 判定 | 数量 | 项目 |
|---|---|---|
| 基本对齐 | 2 | H-07、H-15 |
| 部分对齐 | 10 | H-01、H-02、H-03、H-06、H-08、H-09、H-11、H-12、H-13、H-17 |
| 缺失 | 5 | H-04、H-05、H-10、H-14、H-16 |

---

## 5. 架构差异（重点）

### 5.1 内核归属：决定性差异

ZCode 的 harness 与执行引擎是一体的，所以它可以要求“每个工具声明五维元数据”“每次调用必过治理层”“所有工具结果统一外置”。Open Plan 的执行引擎是 Pi SDK，宪法规定不改内核，因此：

| 能力 | 在 Open Plan 中的位置 | 可做什么 | 不能做什么 |
|---|---|---|---|
| 工具元数据 | 自定义工具在外围；原生 read/bash/grep/find/ls/write/edit 在内核 | 给自定义工具加元数据表；通过扩展包装原生工具 | 改变内核原生工具的注册与执行契约 |
| 权限链 | 工具执行体内部（外围）或 Pi 扩展 tool_call 钩子 | 在外围维护决策链与 ruleId；用扩展做单工具拦截 | 让内核所有工具都无条件先过外围治理 |
| 上下文组装 | 基础提示词在内核；Section 在外围 | 在外围拼装 system/meta_user 等价段落、动态上下文 | 替换内核的 system prompt 组装器 |
| 压缩 | 内核 compaction | 配置阈值、监听事件、失败提示 | 自定义摘要算法或重放策略 |
| 用量采集 | 内核 usage 事件 | 在外围归集/补 actor 维度 | 让内核按 actor/query_source 直接打点 |
| 结果外置 | 内核工具结果管道 | 对自定义工具自己做外置；对原生工具用截断/预览 | 统一拦截所有工具结果并改写 |

**结论：** 对标时必须先问“这项能力是否在内核边界内”。在内核内的，只能做“外围等价物 + 明确局限”，不能承诺与 ZCode 同构。

### 5.2 治理时机：单轨 vs 双轨

- **ZCode：单轨。** 执行层每次调用必过治理层；治理层返回 allow/ask/deny + ruleId；治理层不得绕过观测。
- **Open Plan：双轨。**
  - 轨道 A（能力边界）：按产品模式在 prompt 前收缩 Pi 的 active tools（`agent.mjs:3829-3865`）。Chat/Office/Review 从工具集合上就调不到写工具。
  - 轨道 B（行为边界）：副作用工具执行前调用 `requireToolApproval`（`审批策略.mjs:199`），按“工具 × 输入”通配规则决定 allow/ask/deny。
- **后果：**
  - 优点：只读工具没有审批延迟；模式边界清晰；审批规则可按命令前缀精细配置。
  - 缺点：只读调用没有逐次权限审计；工具元数据与权限规则是两套事实；无法回答“这次 read 为什么被允许”。
- **改进方向：** 增加“能力元数据表 + 决策记录（ruleId）”，但不改变 Pi 的调用时序；对只读工具采用“记录但不弹窗”的审计模式。

### 5.3 事实来源：关系型表 vs 事件流

- **ZCode：** session/message/part/todo/permission/model_usage/artifact 七张表；查询与统计直接 SQL。
- **Open Plan：** 事件注册表是唯一事实来源（`事件注册表.mjs:20-169`），每条事件声明 `lifecycle` 与 `persist`；`persist` 必须 `lifecycle`；代码里使用的事件必须登记，否则测试失败。事件流 JSONL 支持归档、索引、游标回放（`事件存储.mjs:20-31`）。Run 记录是事件的投影，前端展示也是投影。
- **后果：**
  - Open Plan 在“回放、审计、断线恢复、前后端一致”上更强；任何新事件漏登记会被测试拦住。
  - ZCode 在“即席查询、跨会话统计、用量报表”上更强；Open Plan 要做同类报表需要额外聚合层。
  - Open Plan 不能引入数据库（AGENTS.md §1），所以用量归集应走“JSONL + 内存聚合 + API 查询”，而不是新表。

### 5.4 编排主体：模型自治 vs 代码编排

- **ZCode：** 模型通过 Agent/CreateWorkflow/Todo 等原语自主编排；平台提供缓存、journal、hole/fill 等“可重放”基础设施。
- **Open Plan：** 编排逻辑尽量写在代码里：
  - 子代理编排器：计划→并发→结果→核验→revise→关账，全部由确定性代码驱动（`子代理编排器.mjs:132-282`）。
  - 编辑流水线：Planner→Writer→Formatter→Evaluator，阶段与回环由代码控制。
  - 领域工作流：声明式 `budget/tools/preflight/stages/artifacts`，由注册表校验（`工作流注册表.mjs:43-...`）。
- **后果：**
  - Open Plan 的可预测性、可测试性更强；适合“交通规划交付物”这种要求证据与验收的场景。
  - ZCode 的通用性、可组合性更强；适合“任意代码任务”。
  - 动态工作流引擎是两者最大的架构鸿沟，也是最不应照搬的部分：引入 TS 脚本引擎等于在 Pi 之外再造一个运行时，违反“不新增内核/服务”的边界。

### 5.5 扩展模型：Hook/Plugin vs 代码扩展

- **ZCode：** 声明式 Hook（7 事件 + 信任态 + 权限更新）与插件包（贡献 skills/agents/hooks/mcp），生态友好。
- **Open Plan：** Pi Extension 是代码路径（路径登记、启停、需新会话），加上 MCP 与 Skills 目录；没有声明式贡献模型。
- **后果：**
  - Open Plan 的扩展更可控、更难被恶意声明绕过；但扩展作者必须写代码，无法“配置即扩展”。
  - 若要做 Hook，建议只做 4 个高价值事件（PreToolUse/PostToolUse/UserPromptSubmit/Stop），并复用现有审批与事件注册表，不引入完整插件市场。

### 5.6 上下文模型：Section 组装 vs Prompt 注入

- **ZCode：** 10 个 Section，固定顺序，标注 `injectionTarget` 与 `cacheHint`，每个 Section 可单测。
- **Open Plan：** 内核基础提示词 + 静态 `agentsFiles`（`.agent-context.md` 大段规则）+ 每轮动态上下文消息 + 任务/引用摘要。
- **后果：**
  - ZCode 的缓存友好性、可维护性、可测试性更好；Open Plan 的规则更“就地”，但体量大、改一处要动长字符串、难以做缓存分层。
  - Open Plan 的记忆注入是全量摘要（2800 字符），ZCode 是“索引 + 召回”；前者可预测但会截断，后者更省上下文但依赖模型选择能力。

### 5.7 安全与协调：权限广度 vs 文件协调深度

| 维度 | ZCode | Open Plan |
|---|---|---|
| Bash 隔离 | 明确“没有沙箱，只有权限模型” | 无沙箱；但有命令安全策略（禁止根目录全盘搜索）、超时上限、工作区路径校验 |
| 文件写入 | 权限 + 结果外置 | 写锁（跨进程 PID 检测）+ 暂存区 + 外部重叠检测 + 受保护记忆目标 + Review 写保护 + 发布/回滚 |
| 并发写入 | 工具并发调度声明 | 文件级写锁 + 工作区级锁 + 暂存清单，支持多 Run 隔离 |
| 人机协作 | AskUserQuestion | `ask_user` + 审批 + 浏览器接管 lease |
| 领域保护 | 通用 | 坐标范围、记录数校验、产物根校验、规范证据链 |

**结论：** ZCode 的权限“面”更宽，Open Plan 的文件“点”更深。两者互补，不能简单说谁更安全。

### 5.8 恢复语义：会话/工作流 vs Run/事件

- **ZCode：** session/message/part + 工作流 run/actor/node/event；恢复粒度是会话与工作流节点。
- **Open Plan：** Run 检查点 + 事件流回放 + 会话 JSONL 重开 + 运行恢复（`runs.mjs:1160`）；恢复粒度是 Run 与事件游标。
- **后果：** Open Plan 的恢复更贴近“任务”而不是“对话”；ZCode 的恢复更贴近“会话状态机”。两者都满足各自产品形态。

### 5.9 领域化：Open Plan 的独特层

ZCode 是通用 harness，没有交通规划领域约束。Open Plan 在治理层之上还有一层“领域硬约束”：

- 坐标越界 `geo_out_of_range`；
- 记录数不一致 `data_integrity_failed`；
- 产物越出工作区 `artifact_root_violation`；
- Review 写回保护与规范证据链；
- 领域工作流 preflight（`工作流校验.mjs`）。

这层是 ZCode 完全没有的，也是 Open Plan 的产品护城河；对标时不应为了“通用化”而削弱。

---

## 6. Open Plan 领先项（对标时不要抹平）

| ID | 领先项 | 证据 | 为什么保留 |
|---|---|---|---|
| E-01 | 事件注册表（lifecycle/persist/schema + 测试强制） | `事件注册表.mjs:20-169,203-218`；`scripts/事件注册表测试.mjs` | 新增事件不会“只在一处处理”；回放/审计/前端投影共用一套契约 |
| E-02 | 事件流归档、索引、游标回放 | `事件存储.mjs:20-31`；`scripts/事件流回放窗口测试.mjs` | 断线恢复与跨会话审计的基础 |
| E-03 | 写入协调（锁/暂存/外部重叠/受保护目标/发布/丢弃） | `写入协调.mjs:161-311,344-603` | 多 Run 并发下不互相污染；产物发布可回滚 |
| E-04 | 产物验收 + 发布/回滚 + 内容哈希归属 | `产物验证.mjs:25-75`；`成果验收.mjs:164-365`；`成果管理.mjs:68-238` | 回答“产物是不是这一轮产生的、能不能交付” |
| E-05 | 完成语义（显式声明 + 推断 + 客观下调） | `运行轨迹.mjs:24-102` | 区分“回答完了”和“任务真完成了” |
| E-06 | 首字延迟 8 阶段 + spans + P50/P95 | `首字延迟.mjs:23-66,217-241` | 体验回归的可观测基线 |
| E-07 | 运行预算 + 重复失败门禁 + 周期进度播报 + 工具级门禁扩展 | `运行预算.mjs:16-27,122-211`；`轮次预算.mjs:11-51`；`pi-extensions/工作台把关.mjs` | 长任务不失控；模型有“做到哪了”的表达 |
| E-08 | 产品模式能力白名单 + 能力计划 + 契约测试 | `task.mjs:16-41,88-179`；`scripts/能力契约测试.mjs` | “声明了却调不到”会被测试拦住 |
| E-09 | 子代理确定性编排 + 对抗核验 + roster 持久化 | `子代理编排器.mjs:132-282` | 比“模型自治分派”更可测、更适合交付场景 |
| E-10 | 领域硬约束 + Review 证据链 | `工作流校验.mjs`；`review_*` 事件族 | 交通规划的可信度基础 |
| E-11 | 内置浏览器接管 lease | `内置浏览器.mjs`；`BROWSER_USER_TAKEOVER` | 人机协作而非纯自动化 |
| E-12 | 工作区隔离与路径校验 | `workspace.mjs`；`写入协调.mjs:101-133` | 防止越界读写与跨项目污染 |

---

## 7. 综合结论

1. **可补的（外围可落地）：** 工具元数据、权限 ruleId、结果外置、用量归集、记忆召回、记忆自动抽取、上下文段落契约、Skill 注入契约、4 事件 Hook、子代理 profile/后台、统一错误 envelope、配置优先级文档。
2. **需改造的（形态不同）：** 工作流可重放（只做最小 journal，不做 TS 引擎）、计划文件持久化（不做 PlanMode）、插件包清单（不做市场）、MCP 命名（不改名，只补文档）。
3. **不引入的：** 关系型数据库、OTel、Cron/OffPeak、完整插件市场、17 级权限链（用 3 值 + 元数据 + 决策记录替代）。
4. **必须保持的：** 事件注册表、写入协调、产物验收/发布/回滚、完成语义、首字延迟、领域硬约束、模式能力白名单。
5. **最重要的判断：** Open Plan 的短板不在“功能数量”，而在“治理与观测的粒度”。补 P0 的目的是让每一次调用、每一份记忆、每一份产物都能被解释和追溯，而不是把产品改成 ZCode。

---

## 8. 局限与未验证项

- ZCode 侧依据的是逆向交接文档，不是源码；“17 级权限链/7 事件/Hook 信任态”等按文档口径描述，未逐条复核其实现细节。
- Open Plan 侧本轮为静态代码检索，未启动服务做动态验证；以下事项需实测：
  - Pi SDK 是否支持同层工具并行执行（决定 H-01 的并发调度能否落地）；
  - 子代理 usage 事件是否可补齐（当前只看到父会话 `stats`）；
  - compaction 的实际摘要策略与“关键结论保留”效果；
  - MCP `readOnlyHint` 与审批规则的实际交互（代码与注释存在一处口径差异，见 `审批策略.mjs:21` 注释 vs `agent.mjs:1131-1140` 实现）。
- 未覆盖前端交互、视觉层、SSE 协议细节；这些属于 R3/R8/R16，与 harness 对照只在“事件契约”层面相关。
- 工作区当前有未提交改动；行号以当前文件为准，合并后可能漂移。

---

## 9. 下一步

- 阅读配套清单 [ZCode-Harness 对标功能需求梳理清单](2026-10-27-ZCode-Harness对标功能需求梳理清单.md)，按 P0/P1/P2 决定实施范围。
- 任何实施前先确认：是否需要 ADR、是否新增运行时开关、是否触碰 Pi 内核边界。
- 本轮不修改任何代码。
