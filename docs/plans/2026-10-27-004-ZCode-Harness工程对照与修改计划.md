# ZCode Harness 工程对照与修改计划

> 状态：已完成（实施，待用户验收）
> 基线：v0.13.2（develop）
> 更新：2026-10-27
> 关联：[功能需求对照文档](../2026-10-27-ZCode-Harness与Open-Plan功能需求对照.md)、[对标需求清单](../2026-10-27-ZCode-Harness对标功能需求梳理清单.md)、[对照测试与验收计划](2026-10-27-005-ZCode-Harness对照测试与验收计划.md)、[AGENTS.md](../../AGENTS.md)、[REQUIREMENTS.md](../../REQUIREMENTS.md)、[Qoder 对标计划](2026-10-18-001-Qoder对标整改与交通规划Harness迭代修改计划.md)、[优化开关决策记录](../决策记录/0004-优化开关统一且默认关闭.md)
> 说明：本计划把前两份分析文档收敛为可执行的工程计划；实施结果见 [ZCode-Harness 实施记录](2026-10-27-008-ZCode-Harness实施记录.md)。

---

## 0. 结论先行

1. **目标不是复刻 ZCode，而是补齐 Open Plan 的“治理颗粒度 + 计量颗粒度”。** ZCode 的六层模型值得借鉴，但其中工具元数据、权限链、结果外置、用量采集都与 Pi 内核强耦合，只能做外围等价物。
2. **范围锁定：6 个 P0 + 6 个 P1 + 5 个 P2；4 项明确不做。** P0 解决“每次调用可解释”，P1 解决“上下文与扩展可维护”，P2 只做不改变产品形态的收尾项。
3. **独立 H 线推进，不与 v0.12.x–v0.17.x 现有列车混排。** 版本号由 `版本管理计划.md` 确认；建议作为独立 minor 线，避免与 AVA 队列线、Office 排版线互相阻塞。
4. **五个门禁 G0–G4。** G0 先做 3 个内核探针（并行工具、子代理 usage、compaction 事件完整性），探针不通过就调整范围，不硬做。
5. **每个 WP 一个开关，默认关；关闭时行为与基线逐字一致。** 新数据文件全部是增量写入，不做迁移；回滚只关开关，不删用户数据。
6. **最大不确定性不是代码量，而是 Pi 内核边界。** 本计划把“内核不可改”写成硬约束，所有“与 ZCode 同构”的承诺都降级为“外围等价 + 明确局限”。

---

## 1. 范围与非目标

### 1.1 本计划做什么

| WP | 能力 | 对应 ZCode | 优先级 | 一句话交付 |
|---|---|---|---|---|
| **H1-1** | 工具能力元数据 | H-01 | P0 | 每个工具有只读/破坏性/副作用域/风险/审批/结果预算声明 |
| **H1-2** | 权限决策可审计 | H-02 | P0 | 每次 ask/deny 返回稳定 ruleId，可回放 |
| **H1-3** | 工具结果外置 | H-11 | P0 | 超阈值结果落盘，模型只拿预览，可回溯 |
| **H1-4** | 用量归集与归因 | H-12 | P0 | 回答“本轮 token 花在主会话/子代理/压缩哪一段” |
| **H2-1** | 记忆语义召回 | H-04 | P0 | manifest + 模型选择 + 上限 + 时效警告 |
| **H2-2** | 记忆自动抽取 | H-05 | P0 | 满足条件时后台产出待审核建议，不污染队列 |
| **H2-3** | 上下文分段契约 | H-06 | P1 | 固定段落顺序/预算/注入目标，可按段测试 |
| **H2-4** | Skill 注入契约 | H-08 | P1 | 调用时注入 `<skill_content>`，预算 ≤20KB |
| **H3-1** | Hook 声明式事件层 | H-13 | P1 | 4 个高价值事件可声明、可 deny、可审计 |
| **H3-2** | 子代理 profile/后台/计量 | H-09 | P1 | profile 冻结、后台可查、用量可见 |
| **H3-3** | 统一工具错误 envelope | §3.4 | P1 | code/message/suggestion/retryable 稳定 |
| **H3-4** | 配置优先级与资源发现 | §3.3 | P1 | 优先级与发现顺序文档化、可测试 |
| **H4-1** | 权限模式映射 | H-02/H-14 | P2 | 只读沙箱落到 Chat/Review，不新增用户模式 |
| **H4-2** | 工作流可重放最小版 | H-10 | P2 | 阶段 journal + 幂等重跑，不做脚本引擎 |
| **H4-3** | 插件包清单与完整性 | H-17 | P2 | 扩展包清单/版本/哈希，不做市场 |
| **H4-4** | 计划文件持久化 | H-14 | P2 | 计划落盘可恢复，不做 PlanMode |
| **H4-5** | 观测导出 | H-12 | P2 | JSONL 聚合导出 + 只读报表 API |

### 1.2 明确不做

| 不做项 | 理由 |
|---|---|
| 修改/fork Pi SDK，或伪造内核能力 | AGENTS.md §5.1；所有内核内能力只做外围等价 |
| 新增用户可见模式（plan/yolo/guarded） | 产品只暴露 Chat/Work/Review；只读语义落到现有模式 |
| 关系型数据库、消息队列、微服务、桌面壳 | AGENTS.md §1；继续文件 + JSONL |
| 完整 TS 动态工作流引擎（agent/hole/world.run/channel/future + amend 缓存） | 等于再造运行时；违反“不改内核、不新增服务拆分” |
| Cron / OffPeak 定时与空闲调度 | 本地优先工作台无常驻调度需求 |
| OTel trace / 完整插件市场 / `mcp__` 强制改名 | 收益低于成本，且改名是破坏性契约变更 |
| 17 级权限链逐级复制 | 用“元数据 + 规则表 + 决策记录 + 模式白名单”表达同等治理目标 |
| UI 大改、视觉重做 | 本计划只补必要的诊断/展示入口，不触碰 DESIGN 基线 |

### 1.3 与既有对标工作的关系

- Qoder 对标计划已落地 U1–U10（工具门禁扩展、事件规范化、项目信任、缓存保活、侧车、交互归属等），本计划**不重复**这些项；只在需要时复用其开关与模块。
- AVA 线（v0.12.x–v0.16.x）在改对话状态、队列、分支；本计划**不改**这些状态模型，只在其外围增加观测与治理。
- Office 排版线（v0.17.x）在改文档引擎；本计划只通过“工具元数据/错误 envelope”与文档工具交互，不改排版逻辑。

---

## 2. 基线、证据与差距

### 2.1 17 项能力对照（压缩版）

> 详细证据与逐项分析见[功能需求对照文档](../2026-10-27-ZCode-Harness与Open-Plan功能需求对照.md)。本表只保留决策所需信息。

| ID | 能力 | 现状判定 | 本计划动作 |
|---|---|---|---|
| H-01 | 工具注册与元数据 | 部分对齐 | H1-1 补元数据 |
| H-02 | 权限决策 | 部分对齐 | H1-2 补 ruleId/审计 |
| H-03 | 项目记忆（文件型） | 部分对齐（治理更强） | 不重构；H2-1/H2-2 补召回与抽取 |
| H-04 | 语义召回 | 缺失 | H2-1 |
| H-05 | 记忆自动抽取 | 缺失 | H2-2 |
| H-06 | 上下文组装 | 部分对齐 | H2-3 |
| H-07 | 上下文压缩 | 基本对齐 | 保持；只补事件/失败可见性 |
| H-08 | Skill 注入 | 部分对齐 | H2-4 |
| H-09 | 子 agent 派发 | 部分对齐（编排更强） | H3-2 |
| H-10 | 动态工作流 | 缺失（形态不同） | H4-2 只做最小重放 |
| H-11 | Artifact 外置 | 部分对齐（产物链路更强） | H1-3 |
| H-12 | 用量与 trace | 部分对齐 | H1-4 + H4-5（导出） |
| H-13 | Hook | 部分对齐 | H3-1（4 事件） |
| H-14 | 计划模式 | 缺失 | 不做 PlanMode；H4-4 只做计划文件持久化 |
| H-15 | MCP 接入 | 基本对齐 | 保持；只补文档 |
| H-16 | 定时/空闲调度 | 缺失 | 不做 |
| H-17 | 插件体系 | 部分对齐 | H4-3（清单，不做市场） |

### 2.2 必须承认的架构差距

1. **内核归属：** 工具执行、上下文基础提示词、压缩、usage 事件都在 Pi 内；外围只能加元数据、钩子、归集，不能替换内核。
2. **治理时机：** ZCode 每次调用必过治理；Open Plan 是“模式白名单 + 副作用工具审批”双轨。补 ruleId 与元数据是为了让双轨也可解释，而不是改成单轨。
3. **事实来源：** ZCode 用表；Open Plan 用事件流。用量归集必须走 JSONL + 聚合，不能引入数据库。
4. **编排主体：** ZCode 模型自治；Open Plan 代码编排。不要为了“工作流”把确定性编排改成模型自治。
5. **扩展模型：** ZCode Hook/Plugin 是声明式生态；Open Plan 是代码扩展。Hook 只做最小 4 事件，不做插件市场。

### 2.3 必须保留的领先项

事件注册表与回放、写入协调、产物验收/发布/回滚、完成语义、首字延迟分段、运行预算/重复门禁、模式能力白名单、子代理确定性编排、领域硬约束、浏览器接管 lease、工作区隔离。

**原则：** 这些能力只允许“补接口/补观测”，不允许为了与 ZCode 对齐而替换实现。

---

## 3. 目标架构

### 3.1 修改后的数据流

```text
用户输入
  → 上下文段落组装（H2-3）
      ← 记忆召回（H2-1） / AGENTS.md / 任务摘要 / 引用
  → Pi 回合
      → UserPromptSubmit Hook（H3-1）
      → 工具调用
          → PreToolUse Hook（H3-1）
          → 工具元数据（H1-1） → 权限决策（H1-2）
          → 工具执行
              → 结果外置（H1-3）
          → PostToolUse Hook（H3-1）
      → 子代理（H3-2） → 子代理用量（H1-4）
  → 事件注册表 / 事件流（保持 E-01/E-02）
  → 用量归集（H1-4） → 观测导出（H4-5）
  → 完成语义 / 产物验收（保持 E-04/E-05）
  → Run 收尾 → 记忆自动抽取（H2-2）→ 待审核建议
```

### 3.2 新增模块（计划路径，实施时可合并到既有模块以避免碎片化）

| 模块 | 职责 | 主要依赖 | 开关 |
|---|---|---|---|
| `server/工具元数据.mjs` | 工具五维元数据 + resultBudget + 校验 | `task.mjs` 白名单 | `OAW_TOOL_METADATA` |
| `server/权限决策.mjs`（或扩展 `审批策略.mjs`） | 规则匹配、ruleId、决策对象 | 元数据、用户规则 | `OAW_PERMISSION_AUDIT` |
| `server/工具结果外置.mjs` | 超阈值落盘、预览、清理 | Run 目录、事件 | `OAW_TOOL_RESULT_ARTIFACT` |
| `server/用量归集.mjs` | JSONL 追加、内存聚合、查询 | stats/子代理/压缩 | `OAW_USAGE_LEDGER` |
| `server/记忆召回.mjs` | manifest、选择、注入、审计 | 记忆目录、模型能力 | `OAW_MEMORY_RECALL` |
| `server/记忆抽取调度.mjs` | 触发判断、只读子会话、候选提交 | 子代理、记忆准入 | `OAW_MEMORY_EXTRACT` |
| `server/上下文段落.mjs` | 段落数组、预算、顺序、注入目标 | 记忆召回、任务、引用 | `OAW_CONTEXT_SECTIONS` |
| `server/Hook事件层.mjs`（P1） | 配置解析、4 事件派发、超时、信任 | 事件注册表、工作区 | `OAW_HOOK_EVENTS` |
| `server/工具错误.mjs` | 统一 error envelope 工厂 | 工具返回 | 无（渐进使用） |
| `server/配置来源.mjs`（P1） | 资源发现顺序、source 字段 | env/应用数据/工作区 | `OAW_CONFIG_SOURCE` |
| `server/工作流日志.mjs`（P2） | 阶段 journal、幂等重跑 | 领域工作流 | `OAW_WORKFLOW_JOURNAL` |
| `server/插件清单.mjs`（P2） | 扩展清单、哈希、版本 | Pi 扩展管理 | `OAW_PLUGIN_MANIFEST` |
| `server/观测导出.mjs`（P2） | 用量/延迟导出与报表 API | 用量归集、首字延迟 | `OAW_OBSERVABILITY_EXPORT` |

### 3.3 预计修改模块

| 模块 | 修改点 | 风险级别 |
|---|---|---|
| `server/agent.mjs` | 工具注册处读取元数据；prompt 组装改为调用段落模块；usage/子代理/结果外置接线 | 高 |
| `server/审批策略.mjs` | 返回决策对象与 ruleId；保留旧接口兼容 | 高 |
| `server/task.mjs` | 白名单与元数据一致性校验；不改变模式可见性语义 | 中 |
| `server/事件注册表.mjs` | 新增事件与 schema；保持 lifecycle/persist 约定 | 中 |
| `server/运行开关.mjs` | 新增 H 线开关；默认全关 | 低 |
| `server/执行句柄.mjs` | Run 收尾触发用量结算与记忆抽取；失败不影响主终态 | 中 |
| `server/子代理编排器.mjs` / `agent.mjs` 子会话 | profile 快照、后台、用量 | 中 |
| `server/记忆管理.mjs` | 接收自动抽取的候选；复用现有审核流程 | 低 |
| `server/工作流注册表.mjs` / `工作流校验.mjs`（P2） | journal 与重放阶段标记 | 中 |
| `server/index.mjs` | 用量汇总/观测导出/配置诊断的最小只读 API | 低 |
| `client/` | 仅在需要展示“结果已外置/扩展开关状态”时做最小提示，不做视觉重做 | 低 |

> 以上为**计划改动面**，不是已实施事实；实施时以任务卡和代码评审为准。

---

## 4. 数据与契约

> 以下 schema 是计划草案；最终字段以 ADR/实现评审为准。所有新增事件必须先登记 `server/事件注册表.mjs`。

### 4.1 工具元数据

```json
{
  "name": "write",
  "readOnly": false,
  "destructive": false,
  "sideEffectScope": "workspace",
  "riskLevel": "medium",
  "needsApproval": true,
  "concurrencySafe": false,
  "permission": { "patternSource": "path", "denyPriority": 100 },
  "resultBudget": {
    "maxInlineBytes": 30720,
    "maxModelBytes": 30720,
    "strategy": "artifact",
    "preview": { "direction": "head" }
  }
}
```

规则：
- `sideEffectScope ∈ none | session | workspace | network | system | userInteraction`。
- `riskLevel ∈ low | medium | high | critical`。
- 原生工具用静态表补齐；MCP 工具使用“本地保守默认值”，不采用服务端 annotations 作为授权依据。
- `concurrencySafe` 先只作为审计字段；Pi 内核并行能力未确认前，不承诺调度效果。

### 4.2 权限决策对象

```json
{
  "action": "ask",
  "ruleId": "default.officecli.set",
  "ruleSource": "default",
  "tool": "officecli",
  "matchedPattern": "set *",
  "reason": "Office 写入类命令默认先问",
  "owner": { "kind": "turn", "id": "run_..." }
}
```

规则：
- `ruleId` 稳定、可读、不可复用；用户规则用 `user.<n>`，模式兜底用 `mode.<mode>.<reason>`。
- 拒绝错误保留 `code=APPROVAL_DENIED`，新增 `ruleId`。
- allow 默认不逐次落盘；`OAW_PERMISSION_AUDIT=all` 时才记录 allow。

### 4.3 用量记录

```json
{
  "runId": "run_...",
  "turnId": 3,
  "actorKind": "main",
  "actorId": "main",
  "provider": "provider",
  "model": "model-id",
  "querySource": "agent_step",
  "inputTokens": 12000,
  "outputTokens": 800,
  "cacheReadTokens": 40000,
  "cacheWriteTokens": 0,
  "contextTokens": 52000,
  "cost": 0.012,
  "durationMs": 4200,
  "ttftMs": 900,
  "toolCallCount": 5,
  "finishReason": "stop",
  "at": "2026-10-27T00:00:00.000Z"
}
```

规则：
- `actorKind ∈ main | subagent | pipeline | compaction | memory`。
- `querySource ∈ agent_step | compact | memory_extract | memory_recall | pipeline_stage | unknown`。
- 取不到的字段写 `null`，不估算、不伪造。
- 文件：`.oaw/usage/用量.jsonl`，按事件流同样的轮转策略归档。

### 4.4 记忆召回

```json
{
  "manifest": [
    { "file": "project.md", "type": "project", "description": "项目背景", "mtime": "..." }
  ],
  "selected": ["project.md", "feedback.md"],
  "injectedBytes": 12000,
  "truncated": false,
  "fallback": false
}
```

规则：
- manifest 不含正文；选择结果必须可审计。
- 总量上限 60KB；超限显式标注 `truncated=true`。
- 模型不支持 JSON schema 时 `fallback=true`，退回现有全量摘要。

### 4.5 上下文段落

```json
{
  "id": "workspace-rules",
  "target": "system",
  "cacheHint": "stable",
  "budgetChars": 4000,
  "content": "..."
}
```

固定顺序：
1. 内核基础提示词（只读）
2. 工作区准则（AGENTS.md）
3. 工具使用规则（按模式裁剪）
4. 动态上下文（工作区/当前文件/记忆）
5. 任务摘要 + 引用摘要
6. 恢复的用户回答
7. 用户本轮输入

### 4.6 Hook 配置（P1）

```json
{
  "version": 1,
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": { "tool": "write|edit|bash" },
      "command": "node scripts/my-hook.mjs",
      "timeoutMs": 3000,
      "enabled": true
    }
  ]
}
```

规则：
- 先支持 4 事件：`UserPromptSubmit / PreToolUse / PostToolUse / Stop`。
- 默认关；命令白名单；超时杀进程；输出上限；声明哈希变更需重授信。
- 不复制 ZCode 的 7 态信任，先做 `pending → trusted → revoked` 三态。

### 4.7 工具错误 envelope

```json
{
  "code": "invalid_value",
  "message": "Unknown element type 'x'",
  "suggestion": "Valid types: paragraph, run, table",
  "retryable": false
}
```

放在 `details.error`，保持 `content/isError` 不变。

### 4.8 子代理 profile 快照

```json
{
  "childId": "subagent_...",
  "role": "worker",
  "readOnly": false,
  "tools": ["read", "grep", "find", "ls", "write", "edit", "officecli"],
  "model": "provider/model",
  "budget": { "timeoutMs": 180000, "maxTurns": 5 },
  "parentToolCallId": "tool_...",
  "frozenAt": "..."
}
```

规则：派发时写入 `subagent_planned`；后续不得静默变更；变更必须发新事件。

### 4.9 新增事件清单（草案）

| 事件 | lifecycle | persist | 用途 |
|---|---|---|---|
| `tool_metadata_missing` | true | true | 元数据缺失告警 |
| `permission_decision` | true | false | 高频决策；ask/deny 另见审批事件 |
| `tool_result_externalized` | true | true | 结果外置可回溯 |
| `usage_recorded` | true | false | 实时用量；JSONL 为事实 |
| `memory_recall_started/selected/skipped` | true | true | 召回审计 |
| `memory_extraction_started/finished/skipped` | true | true | 抽取审计 |
| `hook_started/finished` | true | false | 高频 |
| `hook_denied` | true | true | 拒绝可审计 |
| `subagent_profile_frozen` | true | true | profile 快照 |
| `context_sections_assembled` | true | false | 段落预算诊断 |
| `skill_injected` | true | true | 技能注入审计 |
| `config_source_resolved` | true | false | 配置来源诊断 |
| `workflow_journal_updated` | true | true | P2 重放 |
| `plugin_manifest_invalid` | true | true | P2 完整性 |
| `plan_persisted` | true | true | P2 计划文件 |

> 事件名与 schema 以实施时的注册表评审为准；未登记事件不得发。

---

## 5. 工作包（WBS）

### H0 基线与探针（Gate G0）

**目标：** 在写代码前确认范围、内核边界和契约命名，避免“按 ZCode 假设”做出无法落地的设计。

| 任务 | 内容 | 产出 | 退出条件 |
|---|---|---|---|
| H0-1 | 冻结 6 P0 + 6 P1 + 3 P2 范围；确认不做清单 | 本计划定稿 | 用户确认 |
| H0-2 | 内核探针：① Pi 是否支持同层工具并行；② 子代理 usage 是否可取；③ compaction 事件是否完整 | 探针记录（只读脚本/日志） | 三项都有明确结论 |
| H0-3 | 冻结开关名、事件名、ruleId 命名 | 命名表 | 与事件注册表/运行开关不冲突 |
| H0-4 | ADR 草案：工具元数据与权限审计；Hook（若做） | ADR 草案 | 评审通过 |

**H0 不通过的分支：**
- 不支持并行 → H1-1 的 `concurrencySafe` 只作审计，不承诺调度。
- 子代理无 usage → H1-4 记录 `unknown`，H3-2 的“用量可见”降级为“调用次数可见”。
- compaction 事件不完整 → H2-3 不依赖 compaction 细节，只做段落预算。

---

### H1 治理与计量（Gate G1）

#### H1-1 工具能力元数据（P0，M，4–5 人日）

**步骤：**
1. 新增元数据表与 `getToolMetadata/validateToolMetadata`。
2. 为白名单工具逐个补五维 + resultBudget；原生工具用静态表。
3. 在工具注册/启动期校验：缺失时开发失败、生产告警。
4. 契约测试绑定 `task.mjs` 白名单与元数据表。
5. 开关 `OAW_TOOL_METADATA`。

**验收：** 所有白名单工具有元数据；缺元数据测试失败；MCP annotations 不被当授权；关闭开关行为不变。

**风险：** 元数据与白名单漂移 → 双向契约测试。

#### H1-2 权限决策可审计（P0，M，3–4 人日）

**步骤：**
1. 规则匹配返回 `ruleId/ruleSource/matchedPattern`。
2. 审批拒绝错误带 `ruleId`；事件 payload 带 `ruleId`。
3. 用户规则编号稳定；模式兜底规则命名。
4. 增加 allow 采样开关（默认只记 ask/deny）。
5. 补“子代理不能放宽”的测试。

**验收：** 每条默认/用户规则可命中并返回预期 ruleId；deny 不被 auto 绕过；worker 在只读父会话降级 scout。

**风险：** ruleId 成为对外契约 → 版本化，不改名。

#### H1-3 工具结果外置（P0，M，4–5 人日）

**步骤：**
1. 新增外置模块：阈值、落盘、预览、清理。
2. 自定义工具统一接入；Bash 预览取 tail。
3. 结果 details 返回 `artifactPath/bytes/truncated`。
4. 事件 `tool_result_externalized` 入注册表。
5. 开关 `OAW_TOOL_RESULT_ARTIFACT`。

**验收：** 31KB 输出落盘且模型只拿 ≤30KB 预览；Bash 错误在预览中；文件可回溯；关闭开关逐字一致。

**风险：** 磁盘增长、与产物面板混淆 → 用 kind 区分、Run 清理。

#### H1-4 用量归集与归因（P0，M，4–5 人日）

**步骤：**
1. 新增 JSONL 追加 + 内存聚合 + 查询。
2. 主会话从 `stats` 归集；子代理补 usage（取不到写 unknown）；压缩补 `querySource=compact`。
3. 只读 API：按 Run/actor/querySource 汇总。
4. 文件轮转复用事件流策略。
5. 开关 `OAW_USAGE_LEDGER`。

**验收：** 一轮主会话有记录；子代理记录 actorKind=subagent 或 unknown；汇总能回答 token 去向；关闭开关无新文件。

**风险：** 事件与 usage 双写不一致 → 明确“usage 为计量事实，事件为展示事实”。

---

### H2 记忆与上下文（Gate G2）

#### H2-1 记忆语义召回（P0，M，4–5 人日）

**步骤：**
1. 生成 manifest（文件名/分类/描述/mtime/大小）。
2. 召回流程：manifest → 模型选择（JSON schema）→ 逐条注入 + 时效警告。
3. 60KB 上限与截断标记。
4. 召回事件与审计字段。
5. 开关 `OAW_MEMORY_RECALL`；不支持 schema 时回退。

**验收：** manifest 不含正文；选择与注入一致；无选择只注入 manifest；超限标注；回退成功。

**风险：** 额外模型调用成本/延迟 → 默认关，按项目开启。

#### H2-2 记忆自动抽取（P0，L，6–8 人日）

**步骤：**
1. 触发判断：本轮未写记忆 + 用户散文 ≥3 词。
2. Run 收尾后启动只读子会话（预算 5 轮）。
3. 输出只允许“一条候选”或 `Nothing to save.`。
4. 候选走现有 `createMemoryProposal`，不直接写 `MEMORY.md`。
5. 事件与开关 `OAW_MEMORY_EXTRACT`。

**验收：** 触发/不触发条件正确；已写不重复；预算内结束；候选进待审核；关闭无行为变化。

**风险：** 成本与质量 → 默认关，仅 Work 模式，复用准入规则。

#### H2-3 上下文分段契约（P1，M，4 人日）

**步骤：**
1. 定义 7 段顺序、`target`、`cacheHint`、`budgetChars`。
2. 把 `agent.mjs` 的拼接改为调用段落模块。
3. 按模式裁剪工具规则，不再全量注入。
4. 段落组装事件（persist false）。
5. 开关 `OAW_CONTEXT_SECTIONS`。

**验收：** 顺序稳定；Chat/Work/Review 差异正确；同一 state 可复现；超预算截断有标记。

**风险：** 提示词行为回归 → 字符串测试 + 真实模型抽样。

#### H2-4 Skill 注入契约（P1，S，2 人日）

**步骤：**
1. 技能元数据补 `hash/size/description`。
2. `skills_read` 注入 `<skill_content>` 块。
3. 20KB 预算与截断提示。
4. 事件 `skill_injected`。

**验收：** 未调用不注入；调用有块；预算生效；哈希可校验。

---

### H3 扩展与编排（Gate G3）

#### H3-1 Hook 声明式事件层（P1，L，8–10 人日）

**步骤：**
1. 配置解析（工作区 + 用户目录），默认关。
2. 4 事件派发：UserPromptSubmit / PreToolUse / PostToolUse / Stop。
3. 命令白名单、超时、输出上限、声明哈希。
4. 信任三态：pending → trusted → revoked。
5. 事件 `hook_started/finished/denied`。

**验收：** 4 事件可触发；deny 能阻断；超时不挂死；声明变更需重授信；关闭开关无行为变化。

**风险：** 新执行面 → 默认关、白名单、超时、审计；需 ADR。

#### H3-2 子代理 profile/后台/计量（P1，M，4 人日）

**步骤：**
1. `subagent_planned` 写入 profile 快照。
2. 支持后台派发与任务中心可见。
3. 子代理用量接 H1-4。
4. 保留“父只读 → 子不可写”。

**验收：** profile 不漂移；后台可查/可取消；用量可见；权限不放宽。

#### H3-3 统一工具错误 envelope（P1，S，2 人日）

**步骤：**
1. `toolError(code, message, suggestion, retryable)` 工厂。
2. 先迁移 officecli/map/write/bash/approval。
3. 保持 `content/isError` 不变。

**验收：** code 稳定；suggestion 非空；retryable 正确；拒绝含 ruleId。

#### H3-4 配置优先级与资源发现（P1，S，2 人日）

**步骤：**
1. 写清优先级与发现顺序（规范/文档）。
2. 读取函数补 `source` 字段。
3. 冲突诊断。
4. 测试同名资源选择。

**验收：** 优先级可测；冲突有诊断；不改变既有默认行为。

---

### H4 可选与收口（Gate G4）

| WP | 内容 | 工作量 | 验收 |
|---|---|---|---|
| H4-1 | Chat/Review 只读沙箱映射，不新增模式 | S（2） | 写工具/联网/地图写在对应模式不可达 |
| H4-2 | 工作流 journal + 幂等重跑（只读/幂等阶段） | L（8） | 重跑不重复成功阶段；journal 可回放 |
| H4-3 | 插件清单/版本/哈希；不做市场 | M（4） | 哈希不匹配拒绝加载；启停隔离 |
| H4-4 | 计划文件持久化（不做 PlanMode） | S（2） | 计划与 todo 同步；恢复可见 |
| H4-5 | 观测导出（JSONL 聚合 + 只读 API） | M（3） | 可导出 Run/时间段用量与延迟 |
| 收口 | 全量回归、缺陷修复、文档/变更日志、回滚演练 | 3 | `npm run verify` + 测试矩阵通过 |

---

## 6. 里程碑、依赖与关键路径

| 里程碑 | 范围 | 粗略人日 | 退出条件 | 依赖 |
|---|---|---|---|---|
| **G0** | H0 探针 + 范围冻结 + ADR 草案 | 2–3 | 三个探针有结论；范围确认 | 用户确认 |
| **G1** | H1-1、H1-2、H1-3、H1-4 | 15–19 | 治理/计量测试通过；关=基线 | G0 |
| **G2** | H2-1、H2-2、H2-3、H2-4 | 16–19 | 记忆/上下文测试通过；无提示词回归 | G1 |
| **G3** | H3-1、H3-2、H3-3、H3-4 | 16–18 | 扩展/编排测试通过；无 P0/P1 缺陷 | G1；H3-2 依赖 H1-4 |
| **G4** | H4-1..H4-5 + 收口 | 19–22 | 全量回归 + 文档 + 回滚演练 | G3 |

**关键路径：** G0 → H1-1 → H1-2 → H1-4 → H3-2 → G3 → G4。

**可并行：**
- H1-3（结果外置）与 H1-4（用量）可并行。
- H2-1/H2-2 可在 H1-1 后并行；H2-3 独立于 H1。
- H3-3/H3-4 可提前到 G1 后并行，不阻塞 G2。
- H3-1 必须在 H1-1/H1-2 之后（需要元数据与 ruleId 语义）。

**不建议并行的：**
- H2-3（上下文段落）与 AVA 对话流改动同时改 `agent.mjs` 的 prompt 路径 → 需要串行或明确分工。
- H1-1 与 H1-2 同时改审批/工具注册 → 先元数据后决策对象，避免双份事实。

---

## 7. 质量门禁与完成定义

### 7.1 门禁

| 门禁 | 必须通过 | 证据 |
|---|---|---|
| **G0** | 范围冻结；三个探针结论；ADR 草案；命名表 | 计划评审记录 + 探针日志 |
| **G1** | H1 全部契约/集成测试；`npm run verify`；开关关=基线；受影响回归 | 测试报告 + 事件流片段 + usage JSONL |
| **G2** | H2 全部测试；提示词段落字符串测试；3 个代表性任务人工验收 | 测试报告 + 人工验收记录 |
| **G3** | H3 全部测试；Hook deny/超时；子代理 profile/后台；错误 envelope | 测试报告 + 事件流片段 |
| **G4** | `npm run verify` + 全量回归矩阵；文档/变更日志；回滚演练；无 P0/P1 缺陷 | 最终测试报告 + 实施记录 |

### 7.2 DoD（对齐 AGENTS.md §8）

- [ ] 需求可追溯到 PRD 编号（R2/R3/R4/R6/R12/R13/R14/R15/R16）。
- [ ] 代码/文档改动最小且已自测。
- [ ] 每个新功能至少 1 条行为测试；每个缺陷修复有回归测试。
- [ ] `npm run verify` 通过；受影响的关键 `test:*` 通过。
- [ ] 新增/变更事件已登记，payload schema 通过校验。
- [ ] 已更新 `变更日志.md`；PRD/DESIGN/规范/决策相关文档已同步。
- [ ] 无密钥、无用户数据、无运行时产物进入提交。
- [ ] 交付总结如实说明未验证项与风险。

---

## 8. 风险、回滚与观测

### 8.1 风险表

| 风险 | 概率 | 影响 | 缓解 | 触发条件 |
|---|---|---|---|---|
| Pi 不支持并行工具 | 高 | 中 | 元数据只作审计；不承诺并发 | H0 探针 |
| 子代理 usage 取不到 | 高 | 中 | 记录 `unknown`，不估算 | H0 探针 |
| 提示词重构导致输出回归 | 中 | 高 | 字符串测试 + 真实模型抽样 + 分模式灰度 | G2 人工验收 |
| 事件量膨胀 | 中 | 中 | allow 采样；高频事件 persist=false | G1 事件量检查 |
| 审批疲劳 | 中 | 中 | 只对破坏性动作 ask；ruleId 让用户可解释 | G1 体验抽检 |
| Hook 新执行面 | 中 | 高 | 默认关、命令白名单、超时、信任三态 | G3 安全评审 |
| 元数据与白名单漂移 | 高 | 中 | 双向契约测试；单一导出 | G1 |
| 范围蔓延 | 高 | 高 | 固定 P0/P1；P2 单独立项；不做清单 | 每次评审 |

### 8.2 回滚策略

1. **开关回滚：** 每个 WP 独立开关；默认关；关闭时行为与基线逐字一致。
2. **数据回滚：** 新文件（usage/tool-results/hook 配置/journal）全部是增量；关闭开关即停止写入；不删除用户数据。
3. **事件回滚：** 新事件只在开关开启时发；关闭后事件流回到基线；旧事件 schema 不变。
4. **权限回滚：** ruleId 只增字段，不改旧字段；旧消费方仍可只读 action。
5. **Hook 回滚：** 关闭开关；杀掉超时子进程；验证无孤儿进程。
6. **提示词回滚：** 关闭 `OAW_CONTEXT_SECTIONS` 即回到原拼接；保留原字符串作为基线。

**回滚演练：** 每个门禁至少做一次“开→关→再开”的对照，确认事件/文件/行为无残留。

### 8.3 观测指标

- 每次 Run 的新增事件数（应 ≤ 基线 + N）。
- usage JSONL 每次 Run 的字节数。
- 首字延迟 P95 变化（目标：不劣化超过 10%，以基线样本为准）。
- 审批 ask/deny 次数与 ruleId 分布。
- Hook 超时/拒绝次数。
- 记忆召回注入字节数、回退次数。
- 子代理 usage 的 `unknown` 比例。

---

## 9. 追踪矩阵

| WP | ZCode 能力 | PRD | 测试 ID（详见测试计划） | 状态 |
|---|---|---|---|---|
| H1-1 | H-01 | R2、R13 | ZT-H1-01/02 | 未开始 |
| H1-2 | H-02 | R2、R13 | ZT-H1-03/04/05/06 | 未开始 |
| H1-3 | H-11 | R3、R13 | ZT-H1-07/08/09 | 未开始 |
| H1-4 | H-12 | R3、R15 | ZT-H1-10/11/12 | 未开始 |
| H2-1 | H-04 | R14 | ZT-H2-01/02/03 | 未开始 |
| H2-2 | H-05 | R14 | ZT-H2-04/05/06/07 | 未开始 |
| H2-3 | H-06 | R2、R4 | ZT-H2-08/09 | 未开始 |
| H2-4 | H-08 | R6 | ZT-H2-10 | 未开始 |
| H3-1 | H-13 | R2、R16 | ZT-H3-01..06 | 未开始 |
| H3-2 | H-09 | R2、R6 | ZT-H3-07/08 | 未开始 |
| H3-3 | §3.4 | R2、R3 | ZT-H3-09 | 未开始 |
| H3-4 | §3.3 | R12、R15 | ZT-H3-10 | 未开始 |
| H4-1 | H-02/H-14 | R2 | ZT-H4-01 | 未开始 |
| H4-2 | H-10 | R6 | ZT-H4-02 | 未开始 |
| H4-3 | H-17 | R6 | ZT-H4-03 | 未开始 |
| H4-4 | H-14 | R6 | ZT-H4-04 | 未开始 |
| H4-5 | H-12 | R3、R16 | ZT-H4-05 | 未开始 |

**能力对照验收：** H-01..H-17 的最终状态在测试计划 §6.8 的对照验收矩阵中逐项签字；未达到“对齐”的项必须写明“部分/不适用”及理由。

---

## 10. 待确认的决策点

> 未确认前不进入编码。建议按括号内推荐项拍板。

1. **版本线归属：** 独立 H 线（推荐）还是并入现有 v0.12.x–v0.17.x 某一线。
2. **元数据归属：** 新增 `server/工具元数据.mjs`，白名单只保留可见性（推荐）；还是合并进 `task.mjs`。
3. **只读审计粒度：** 默认只记 ask/deny（推荐）；还是 allow 全量记录。
4. **记忆召回成本：** 默认关、按项目开启（推荐）；还是默认开启。
5. **Hook 事件范围：** 先 4 事件（推荐）；还是直接 7 事件。
6. **工作流重放程度：** 阶段 journal + 幂等重跑（推荐）；还是完整脚本引擎（不建议）。
7. **结果外置阈值：** 30KB + Bash tail/其他 head（推荐）；还是沿用 16000 字符截断。

---

## 11. 本轮声明

- 本轮已完成代码与自动化测试，实施记录见 [ZCode-Harness 实施记录](2026-10-27-008-ZCode-Harness实施记录.md)。
- 分支：`feature/zcode-harness-align`；未升版本、未提交、未打 tag。
- 所有新能力默认关闭，`OAW_HARNESS_ALIGN` 可一键开启整族。
- 未验证项（真实模型端到端、原生工具结果外置、记忆模型选择、工作流 journal 接入）见实施记录 §6。
