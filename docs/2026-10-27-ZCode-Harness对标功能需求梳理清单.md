# ZCode Harness 对标功能需求梳理清单

> 状态：草案（待确认，尚未实施）
> 基线：v0.13.2（develop）
> 更新：2026-10-27
> 关联：[功能需求对照文档](2026-10-27-ZCode-Harness与Open-Plan功能需求对照.md) / [AGENTS.md](../AGENTS.md) / [REQUIREMENTS.md](../REQUIREMENTS.md) / [Qoder 对标整改计划](plans/2026-10-18-001-Qoder对标整改与交通规划Harness迭代修改计划.md) / [优化开关决策记录](决策记录/0004-优化开关统一且默认关闭.md)
> 声明：**本文只梳理需求，不修改任何代码。** 所有实施需用户确认后另立计划；默认开关关闭，可一键回滚。
> 后续：本清单的 WP 编号与范围已收敛进 [ZCode-Harness 工程对照与修改计划](plans/2026-10-27-004-ZCode-Harness工程对照与修改计划.md)；本文保留为需求来源与验收口径参考。

---

## 0. 结论与使用方式

### 0.1 结论

1. ZCode 的 17 项能力中，**只有 6 项值得进入 P0**：工具元数据、权限决策可审计、工具结果外置、用量归集、记忆召回、记忆自动抽取。
2. 另有 **6 项 P1**、**5 项 P2**；**4 项明确不引入**（完整 TS 工作流引擎、Cron/OffPeak、数据库/OTel、插件市场）。
3. Open Plan 已有 **12 项领先能力**（事件注册表、写入协调、产物验收、完成语义、首字延迟、运行预算、领域约束等），对标时保持，不改成 ZCode 形态。
4. 所有需求都必须回答三个问题：**是否在 Pi 内核边界内？是否触碰产品模式？是否默认关闭？**

### 0.2 使用方式

- 先读 §2 总表做范围决策，再读 §3–§5 的详情确认验收口径。
- 每条需求都有“建议落点 / 验收 / 风险 / 是否需 ADR”，可直接转为实施计划的任务卡。
- 标 **需 ADR** 的条目，实施前必须先补决策记录；标 **内核边界** 的条目，只能做外围等价物，不能承诺与 ZCode 同构。

---

## 1. 判定口径与硬约束

### 1.1 优先级

| 级别 | 含义 | 处置 |
|---|---|---|
| **P0** | 没有它，harness 的治理/计量链条不完整，后续能力会建立在沙地上 | 建议进入下一轮实施 |
| **P1** | 决定体验上限与可维护性 | 排入中期 |
| **P2** | 加分项，依赖 P0/P1 | 按需 |
| **不引入** | 越界、过度设计或与产品形态冲突 | 写明理由，保留复核入口 |

### 1.2 硬约束（来自 AGENTS.md 与既有 ADR）

1. 不修改 `node_modules/`、Pi SDK 源码，不伪造内核能力。
2. 不新增产品模式；`office` 只是历史兼容值，前端仍只展示 Chat / Work / Review。
3. 不引入数据库、消息队列、微服务、桌面壳；运行时数据继续用文件 + JSONL。
4. 任何新行为默认关闭，统一走 `server/运行开关.mjs`，可一键回滚（ADR 0004）。
5. 新增/改名事件必须登记 `server/事件注册表.mjs`，payload schema 可校验。
6. 不改公开 API/SSE 契约、工具白名单、审批策略语义，除非先取得用户确认并补 ADR。
7. 产物必须写入当前工作区；不把用户文档写入项目目录。
8. 每条需求必须能追溯到 PRD 编号；新增范围先更新 PRD。

### 1.3 工作量标记

| 标记 | 含义 |
|---|---|
| S | 1–2 人日，改动集中在一个模块 |
| M | 3–5 人日，跨 2–3 个模块，需要测试与开关 |
| L | 6 人日以上，涉及契约/架构，必须先 ADR |

---

## 2. 需求总清单

### 2.1 P0（6 项）

| ID | 需求 | 对应 ZCode | 现状 | 目标一句话 | 工作量 | 需 ADR | PRD |
|---|---|---|---|---|---|---|---|
| OP-H-01 | 工具能力元数据表 | H-01 | 只有 label/description/parameters | 每个工具声明只读/破坏性/副作用域/风险/是否需审批/结果预算 | M | 是 | R2、R13 |
| OP-H-02 | 权限决策可审计 | H-02 | 返回 allow/ask/deny，无 ruleId | 每次决策返回命名规则与来源，可回放审计 | M | 是 | R2、R13 |
| OP-H-03 | 工具结果外置与预览 | H-11 | 统一截断 16K 字符 | 超阈值结果落盘，模型只拿预览，可回溯 | M | 否 | R3、R13 |
| OP-H-04 | 用量归集与归因 | H-12 | 每回合 stats，无 actor/query_source | 能回答“本轮 token 花在主会话/子代理/压缩/记忆哪一段” | M | 否 | R3、R15 |
| OP-H-05 | 记忆语义召回 | H-04 | 全量摘要 2800 字符 | manifest + 模型选择 + 上限 + 时效警告，可人工审计 | M | 否 | R14 |
| OP-H-06 | 记忆自动抽取调度 | H-05 | 靠提示词自觉 | 满足条件时后台抽取候选，预算受限，不污染队列 | L | 是 | R14 |

### 2.2 P1（6 项）

| ID | 需求 | 对应 ZCode | 现状 | 目标一句话 | 工作量 | 需 ADR | PRD |
|---|---|---|---|---|---|---|---|
| OP-H-07 | 上下文分段契约 | H-06 | 静态大段提示词 + 动态上下文 | 固定段落顺序、注入目标、稳定/动态标记，可按段测试 | M | 否 | R2、R4 |
| OP-H-08 | Skill 注入契约与预算 | H-08 | 按需读取全文 | 调用时注入 `<skill_content>`，元数据预算 ≤20KB | S | 否 | R6 |
| OP-H-09 | Hook 声明式事件层（最小 4 事件） | H-13 | 只有代码扩展 | PreToolUse/PostToolUse/UserPromptSubmit/Stop 可声明、可 deny、可审计 | L | 是 | R2、R16 |
| OP-H-10 | 子代理 profile 快照/后台/计量 | H-09 | 角色固定、同步、无 token 计量 | profile 冻结可追溯；支持后台；子代理用量可见 | M | 否 | R2、R6 |
| OP-H-11 | 统一工具错误 envelope | §3.4 | `content/isError/details` 混用 | 错误含稳定 code、可执行 suggestion、retryable | S | 否 | R2、R3 |
| OP-H-12 | 配置优先级与资源发现 | §3.3 | 分散在 env/应用数据/工作区 | 文档化优先级与发现顺序，测试可验证 | S | 否 | R12、R15 |

### 2.3 P2（5 项）

| ID | 需求 | 对应 ZCode | 现状 | 目标一句话 | 工作量 | 需 ADR | PRD |
|---|---|---|---|---|---|---|---|
| OP-H-13 | 权限模式映射（不新增用户模式） | H-02/H-14 | 三模式白名单 + 审批 | 把“只读沙箱”语义落到 Chat/Review，不引入 plan/yolo 用户入口 | S | 是 | R2 |
| OP-H-14 | 工作流可重放最小版 | H-10 | 声明式工作流 + 流水线 | 阶段 + journal + 幂等重跑，不做 TS 脚本引擎 | L | 是 | R6 |
| OP-H-15 | 插件包清单与完整性 | H-17 | 路径登记 + 启停 | 扩展包清单/版本/完整性校验，不做市场 | M | 是 | R6 |
| OP-H-16 | 计划文件持久化（不做 PlanMode） | H-14 | 只有 todo | 计划落 `docs/plans/` 或工作区计划文件，可恢复 | S | 否 | R6 |
| OP-H-17 | 观测导出（不引入 OTel/DB） | H-12 | stats/事件流/延迟样本 | JSONL 聚合导出 + 报表 API，供诊断与回归 | M | 否 | R3、R16 |

### 2.4 明确不引入（4 项）

| ID | 能力 | 不引入理由 | 复核条件 |
|---|---|---|---|
| N-01 | 完整 TS 动态工作流引擎（agent/hole/world.run/artifact/channel/future + amend 缓存） | 等于在 Pi 之外再造运行时；违反“不改内核、不新增服务拆分”；调试与安全成本高 | 若未来产品需要“可编程批量任务”，先做 ADR 与沙箱方案 |
| N-02 | Cron / OffPeak 定时与空闲调度 | 本地优先工作台没有常驻调度需求；会引入新的生命周期与权限问题 | 出现明确的定时批处理场景再评估 |
| N-03 | 关系型数据库 / OTel trace | 违反“不引入数据库”；OTel 对单机本地产品收益低于事件流 | 若做团队版/服务化再评估 |
| N-04 | 完整插件市场 / `mcp__` 强制改名 | 市场需要签名、版本、回滚、供应链治理；改名是破坏性变更，收益低 | 若开放第三方生态再评估 |

---

## 3. P0 需求详情

### OP-H-01 工具能力元数据表

**对应能力：** H-01；**PRD：** R2、R13；**需 ADR：是**；**内核边界：部分**。

**现状与差距**

- 自定义工具通过 `defineTool` 注册，只有 label/description/parameters（`server/agent.mjs:3070-3071`）。
- 工具可见性由 `server/task.mjs:16-41` 的白名单决定；审批由 `server/审批策略.mjs:18-59` 的规则表决定。两者与“工具风险属性”没有结构化关联。
- 没有 readOnly/destructive/concurrentSafe/sideEffectScope/riskLevel/needsApproval，也没有 resultBudget。
- MCP annotations 被明确视为不可信（`agent.mjs:1126-1140`），这是正确做法，但缺少本地元数据来补位。

**目标**

1. 新增 `server/工具元数据.mjs`（名称可再定），为每个工具声明：
   - `readOnly`、`destructive`、`sideEffectScope`（none/session/workspace/network/system/userInteraction）、`riskLevel`（low/medium/high/critical）、`needsApproval`；
   - `resultBudget`（maxInlineBytes / maxModelBytes / strategy / preview.direction）；
   - `permission.patternSource`（path / command / input）。
2. 元数据是“能力事实”，`task.mjs` 白名单仍是“模式可见性事实”；两者由契约测试保证一致：白名单里的工具必须有元数据，元数据里的工具必须能解释为什么不在某个模式。
3. 原生 Pi 工具（read/bash/grep/find/ls/write/edit）通过一张静态表补齐；不改内核。
4. **并发调度先不做承诺**：先核实 Pi SDK 是否支持同层并行工具调用；若不支持，元数据只用于权限/审计/结果预算，不宣称并发能力。

**实施要点**

- 新增元数据表 + `getToolMetadata(name)` + `validateToolMetadata()`。
- 在工具注册处做启动期校验；缺失元数据时开发环境直接失败，生产环境降级为 `unknown` 并记事件。
- 审批策略可从元数据派生默认规则（例如 `destructive && needsApproval` → ask），但保留现有规则表作为覆盖层。
- 新增开关 `OAW_TOOL_METADATA`（默认关；关闭时行为与基线一致）。

**验收**

- `scripts/工具元数据契约测试.mjs`：
  - 白名单与元数据双向一致；
  - 缺元数据的工具注册失败；
  - `write/edit/bash/officecli/map_edit` 的风险级别与副作用域符合预期；
  - MCP 工具的 annotations 不被当作授权依据。
- `npm run verify` 通过。

**风险/依赖**

- 元数据表可能变成“第二份白名单”，必须用契约测试绑定。
- 若未来 Pi 内核升级改变工具注册方式，需要重新映射。

---

### OP-H-02 权限决策可审计

**对应能力：** H-02；**PRD：** R2、R13；**需 ADR：是**；**内核边界：是（外围近似）**。

**现状与差距**

- `matchToolAction` 只返回 `allow/ask/deny`（`审批策略.mjs:97-112`），不返回是哪条规则命中。
- 只对副作用工具调用 `requireToolApproval`（`agent.mjs` 多处），只读工具没有逐次决策记录。
- 没有 plan 只读沙箱、没有 17 级链；但已有“worker 子代理降级 scout”的权限不放宽机制（`子代理编排器.mjs:38-43`）。

**目标**

1. 决策结果从字符串升级为对象：`{ action, ruleId, ruleSource, matchedTool, matchedPattern, reason }`。
2. 规则 ID 稳定可审计：
   - 默认规则：`default.officecli.set`、`default.bash.rm`、`default.map.shared.deny` 等；
   - 用户规则：`user.<序号>`；
   - 模式兜底：`mode.chat.readOnly`、`mode.review.noNetwork`。
3. 每次 ask/deny 落事件（复用 `tool_approval_request`），附带 ruleId；allow 可按采样/开关记录，避免事件膨胀。
4. 不复制 17 级链；用“元数据 + 规则表 + 模式白名单 + 决策记录”表达同等治理目标。
5. 子代理权限继承：保留“worker 需父会话可写，否则降级 scout”，并补测试断言“子代理不能比父会话更宽”。

**实施要点**

- `审批策略.mjs` 内部维护规则数组时保留索引，返回 `ruleId`。
- `requireToolApproval` 的 reject error 增加 `ruleId` 字段。
- 事件注册表新增/扩展 `tool_approval_request/resolved` schema，要求 `ruleId`。
- 新增开关 `OAW_PERMISSION_AUDIT`（默认关；关闭时只返回旧字段，保持兼容）。

**验收**

- `scripts/权限决策审计测试.mjs`：
  - 每条默认规则可命中并返回预期 ruleId；
  - 用户“总是允许”规则命中 `user.*`；
  - deny 不会被 auto 模式绕过；
  - Chat/Review 工具白名单外的调用被阻止；
  - worker 在只读父会话中降级 scout。
- 审批事件可在事件流中回放，ruleId 不丢失。

**风险/依赖**

- 只读工具逐次审计会增加事件量；建议默认只记录 ask/deny，allow 采样。
- ruleId 一旦对外暴露，改名属于契约变更，需要版本化。

---

### OP-H-03 工具结果外置与预览

**对应能力：** H-11；**PRD：** R3、R13；**需 ADR：否**；**内核边界：是（自定义工具可做，原生工具受限）**。

**现状与差距**

- 工具输出统一 `limitToolText` 截断到 16000 字符（`agent.mjs:281-306`），超出部分直接丢失。
- 没有“落盘 + 预览 + 可回溯”的统一机制。
- 已有暂存/发布链路是给“用户产物”的，不是给“工具结果”的。

**目标**

1. 自定义工具结果超过阈值（建议 30KB）时：
   - 写入 Run 专属目录（如 `.oaw/runs/<runId>/tool-results/<toolCallId>.txt`）；
   - 模型只收到预览（默认 head；Bash 默认 tail）；
   - 工具结果 details 里返回 `artifactPath`、`bytes`、`truncated`。
2. 预览与全文分离：`maxInlineBytes` 与 `maxModelBytes` 分开配置。
3. 结果保留期与 Run 一致；Run 清理时回收。
4. 原生工具：先通过 Pi 扩展或包装层对 `bash` 输出做 tail 预览；`read` 已分页，不强制外置。

**实施要点**

- 新增 `server/工具结果外置.mjs`（纯函数 + 落盘），供自定义工具统一调用。
- 在 `defineTool` 包装器或各工具 execute 返回处接入；不要改 Pi 内核。
- 事件：`artifact_staged` 已存在，可复用或新增 `tool_result_externalized`（需登记）。
- 开关 `OAW_TOOL_RESULT_ARTIFACT`（默认关）。

**验收**

- `scripts/工具结果外置测试.mjs`：
  - 31KB 输出落盘，模型只拿 ≤30KB 预览；
  - Bash 预览取尾部，错误信息不丢；
  - `artifactPath` 可读、SHA-256 可校验；
  - 关闭开关时行为与基线逐字一致。

**风险/依赖**

- 事件流/产物面板不要把工具结果误当“用户产物”；需要 kind 区分。
- 磁盘增长需要 Run 清理策略。

---

### OP-H-04 用量归集与归因

**对应能力：** H-12；**PRD：** R3、R15；**需 ADR：否**；**内核边界：是（采集在内核，归集在外围）**。

**现状与差距**

- 每回合发 `stats`，包含 input/output/cacheRead/cacheWrite/context/total/cost（`agent.mjs:3113-3135`）。
- 有 `context_usage` 与首字延迟样本，但没有“按 actor / query_source 归集”的 usage 表。
- 子代理会话没有 token 计量（子会话订阅只处理 tool/text/thinking）。
- 没有“本轮 token 花在哪”的报表 API。

**目标**

1. 新增 JSONL 用量记录（不引入数据库）：`.oaw/usage/用量.jsonl`，字段：
   - `runId`、`turnId`、`actorKind`（main/subagent/pipeline/compaction/memory）、`actorId`；
   - `provider`、`model`、`querySource`（agent_step/compact/memory_extract/memory_recall/...）；
   - `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`contextTokens`、`cost`；
   - `durationMs`、`ttftMs`、`toolCallCount`、`finishReason`、`at`。
2. 主会话从现有 `stats` 归集；子代理在 `createSubagentRunner` 的会话事件里补 usage；压缩从 `context_compacted` 事件补。
3. 提供只读 API（如 `GET /api/usage/summary?runId=`）返回按 actor/query_source 的汇总；不做 UI 大改。
4. 若内核拿不到子代理 usage，明确标注 `unknown`，不估算、不伪造。

**实施要点**

- 新增 `server/用量归集.mjs`（追加写 + 内存聚合 + 查询）。
- 在 `emitUsage` 与子代理结果处调用；事件仍保留 `stats` 作为实时展示。
- 开关 `OAW_USAGE_LEDGER`（默认关）。

**验收**

- `scripts/用量归集测试.mjs`：
  - 一轮主会话产生 ≥1 条 usage；
  - 子代理记录 actorKind=subagent（若内核无 usage，记录 `unknown` 并说明）；
  - 压缩记录 querySource=compact；
  - 汇总 API 能回答“主/子/压缩各多少 token”；
  - 关闭开关时无新文件、无新事件。

**风险/依赖**

- 事件与 usage 双写可能不一致；以 usage 为计量事实，事件为展示事实，需在文档写清。
- JSONL 需要轮转，复用事件流的归档策略。

---

### OP-H-05 记忆语义召回

**对应能力：** H-04；**PRD：** R14；**需 ADR：否**；**内核边界：否（完全外围）**。

**现状与差距**

- 每轮把 `AGENTS.md` + `memory/*.md` 摘要全量注入，总预算 2800 字符（`agent.mjs:818-826,4323-4400`）。
- 没有 manifest、没有模型选择、没有“可能过时”的逐条警告。
- 项目多了以后，摘要会截断，且模型无法知道哪些记忆存在但没被注入。

**目标**

1. 建立记忆 manifest：文件名、分类、描述、mtime、大小。
2. 召回流程（默认关）：
   - 先注入 manifest；
   - 允许模型用 JSON schema 选择相关记忆；
   - 被选中的记忆逐条注入，附“可能过时，需对照当前代码/文件”的警告；
   - 总量上限 60KB；超限按相关性/更新时间截断并标注。
3. 模型不支持 JSON schema 时，退回现有全量摘要，不阻断主流程。
4. 召回结果可人工审计：事件里记录 manifest、选择结果、注入字节数。

**实施要点**

- 新增 `server/记忆召回.mjs`；复用 `readMemoryLayers` 的目录扫描。
- 在 `buildDynamicContext` 前调用；召回失败时静默回退。
- 开关 `OAW_MEMORY_RECALL`（默认关；关闭时与基线一致）。

**验收**

- `scripts/记忆召回测试.mjs`：
  - manifest 包含所有记忆文件且不含正文；
  - 选择结果与注入内容一致；
  - 无选择时不注入正文，只注入 manifest；
  - 超过 60KB 时有显式截断标记；
  - 模型不支持 schema 时回退成功。

**风险/依赖**

- 额外一次模型调用会增加延迟与成本；默认关，按项目规模开启。
- 召回选择可能不稳定；需要事件审计与可回退。

---

### OP-H-06 记忆自动抽取调度

**对应能力：** H-05；**PRD：** R14；**需 ADR：是**；**内核边界：否**。

**现状与差距**

- 系统提示要求模型在回合结束主动调用 `memory_update`（`agent.mjs:1090,2520`）。
- 没有触发条件、没有预算、没有“Nothing to save”的显式出口；抽不抽取决于模型自觉。
- 已有准入规则（`记忆准入.mjs:42-82`）和人工审核，污染风险已被治理，但“漏记”仍存在。

**目标**

1. 回合结束后由外围调度器判断是否抽取：
   - 本轮没有直接写记忆；
   - 用户散文 ≥3 个词（中文按字符/分词后的有效词计）；
   - 本轮不是纯问答/一次性咨询（可复用现有提示词判断，或由调度器做启发式）。
2. 满足条件时启动一个只读子代理（Read/Grep/Glob + 只读 Bash + 记忆目录内写），预算 5 轮；
3. 输出只能是：
   - 一条待审核建议（走现有 `createMemoryProposal`）；
   - 或 `Nothing to save.`。
4. 抽取结果不影响主 Run 终态；失败静默记录事件，不打断用户。

**实施要点**

- 新增 `server/记忆抽取调度.mjs`；复用 `run_subagent` 的子会话能力或直接创建轻量只读会话。
- 触发点在 Run 收尾后（`执行句柄.mjs` 的完成路径），不要在模型回合内阻塞。
- 事件：`memory_extraction_started/finished/skipped`（需登记）。
- 开关 `OAW_MEMORY_EXTRACT`（默认关）。

**验收**

- `scripts/记忆抽取调度测试.mjs`：
  - 散文 ≥3 词且本轮未写记忆 → 触发；
  - 本轮已调用 `memory_update` → 不重复；
  - 预算 5 轮内结束；
  - 候选进入待审核队列，不直接写 `MEMORY.md`；
  - 关闭开关时无行为变化。

**风险/依赖**

- 子代理会增加 token 成本；默认关，且只对 Work 模式开启。
- 抽取质量依赖提示词与准入规则；需要与 R14 的记忆治理界面联动。

---

## 4. P1 需求详情

### OP-H-07 上下文分段契约

**对应能力：** H-06；**PRD：** R2、R4；**需 ADR：否**。

- **现状：** 静态 `.agent-context.md` 大段规则（`agent.mjs:1074-1100`）+ 每轮动态上下文（`:3875-3918`）+ taskSummary + references，拼接顺序散落在 `_promptEntry` 中。
- **目标：** 定义固定段落：
  1. 内核基础提示词（不可改，只读）；
  2. 工作区准则（AGENTS.md）；
  3. 工具使用规则（按模式裁剪，不再全量注入）；
  4. 动态上下文（工作区/当前文件/记忆）；
  5. 任务摘要 + 引用摘要；
  6. 恢复的用户回答；
  7. 用户本轮输入。
  每段标注 `injectionTarget: system | prompt`、`cacheHint: stable | dynamic`、`budgetChars`。
- **实施：** 新增 `server/上下文段落.mjs`，纯函数返回段落数组；`agent.mjs` 只负责拼接；规则文本按模式拆分。
- **验收：** `scripts/上下文段落契约测试.mjs` 断言顺序、预算、Chat/Work/Review 的差异；同一 state 输出可复现。
- **风险：** 提示词行为回归需要真实模型抽样验收，不能只靠字符串测试。

### OP-H-08 Skill 注入契约与预算

**对应能力：** H-08；**PRD：** R6；**需 ADR：否**。

- **现状：** `noSkills: true`；`skills_search/skills_read` 按需读取；`skills_read` 返回全文（`agent.mjs:1886-1918`）。
- **目标：** 调用技能时注入 `<skill_content>` 块；技能元数据预算 ≤20KB；未调用不注入；注入内容与技能文件哈希绑定，便于审计。
- **实施：** 在 `skills_read` 返回处加包装；`技能目录` 增加 `hash/size/description` 元数据；超预算时截断并提示。
- **验收：** `scripts/Skill注入契约测试.mjs` 断言未调用不注入、调用时有块、预算生效、哈希可校验。
- **风险：** 技能全文可能很大；截断策略要保守，优先保留指令与步骤。

### OP-H-09 Hook 声明式事件层（最小 4 事件）

**对应能力：** H-13；**PRD：** R2、R16；**需 ADR：是**。

- **现状：** Pi Extension 代码扩展 + 内置 `工作台把关.mjs`（tool_call 拦截、压缩钩子）；项目信任薄封装（默认关）。
- **目标：** 支持声明式 Hook 配置，先做 4 个事件：
  - `UserPromptSubmit`：可注入上下文、可拒绝；
  - `PreToolUse`：可 allow/deny、可改写输入（先只做 deny + 注入原因）；
  - `PostToolUse`：可记录/转换结果（先只做记录）；
  - `Stop`：回合结束可做收尾检查。
  - 暂不做 `PermissionRequest/PostToolUseFailure` 的独立事件，先并入相邻事件。
- **实施：** JSON 配置文件（工作区 `.oaw/hooks.json` + 用户目录），声明命令/脚本、匹配器、超时；执行结果进入事件流；信任态先做 `pending → trusted → revoked` 三态，不复制 7 态。
- **验收：** `scripts/Hook事件层测试.mjs` 断言事件可触发、deny 能阻断、声明变更需重授信、超时不挂死。
- **风险：** Hook 是新的执行面，必须默认关、白名单命令、超时与输出上限；需要 ADR 明确信任模型。

### OP-H-10 子代理 profile 快照/后台/计量

**对应能力：** H-09；**PRD：** R2、R6；**需 ADR：否**。

- **现状：** 5 种角色、并发 2、最多 4、verifier/revise、roster 持久化；缺 profile 快照、后台、token 计量。
- **目标：**
  1. 派发时冻结 profile（角色、工具白名单、预算、模型）到 `subagent_planned`，后续不可静默变更；
  2. 支持后台子代理（不阻塞父回合），结果通过事件与任务中心可见；
  3. 子代理 usage 进入 OP-H-04 的归集；
  4. 保留“父只读 → 子不可写”的降级规则。
- **实施：** 扩展 `subagent_planned` payload 与 `createSubagentRunner`；后台模式复用现有 Run 事件；计量接 OP-H-04。
- **验收：** `scripts/子代理profile与后台测试.mjs` 断言 profile 快照不漂移、后台可查、用量可见、权限不放宽。
- **风险：** 后台子代理的生命周期与取消需要与执行句柄统一，避免“看不见还在跑”。

### OP-H-11 统一工具错误 envelope

**对应能力：** ZCode §3.4；**PRD：** R2、R3；**需 ADR：否**。

- **现状：** Pi 工具返回 `{content, isError, details}`；部分错误有 `code`，但没有统一的 `suggestion/retryable`。
- **目标：** 在 `details.error` 中统一：
  ```json
  { "code": "invalid_value", "message": "...", "suggestion": "可直接执行的修复建议", "retryable": false }
  ```
  保持 `content/isError` 不变，避免破坏 Pi 契约。
- **实施：** 新增 `server/工具错误.mjs` 的 `toolError()` 工厂；逐步替换高频工具（officecli/map/write/bash/approval）。
- **验收：** `scripts/工具错误契约测试.mjs` 断言 code 稳定、suggestion 非空、retryable 正确、拒绝含 ruleId。
- **风险：** 历史工具返回格式不一，需分批迁移，不能一次性大改。

### OP-H-12 配置优先级与资源发现

**对应能力：** ZCode §3.3；**PRD：** R12、R15；**需 ADR：否**。

- **现状：** env 开关（`运行开关.mjs`）、应用数据目录配置（MCP/扩展/供应商）、工作区文件、项目设置分散。
- **目标：** 文档化并测试：
  - 配置优先级：显式参数 > 环境变量 > 会话/项目设置 > 用户配置 > 默认值；
  - 资源发现顺序：显式路径 > 应用数据目录 > 工作区 `.pi/.agents/.claude` > 技能目录；
  - 同名先到先得，冲突时输出诊断。
- **实施：** 先写规范/测试，不急于重构；对现有读取函数补 `source` 字段。
- **验收：** `scripts/配置优先级测试.mjs` 断言同名资源选择、冲突诊断、env 覆盖顺序。
- **风险：** 改变优先级可能影响存量用户；先文档化，再逐步收敛。

---

## 5. P2 需求详情

### OP-H-13 权限模式映射（不新增用户模式）

- **目标：** 把“只读沙箱”落到 Chat/Review 的强制白名单与扩展拦截；不引入 plan/yolo/guarded 用户入口。
- **验收：** Chat/Review 无法调用写工具、无法联网（Review）、无法写地图；扩展到 Chat 的工具必须只读。
- **备注：** 若未来要“计划模式”，只做计划文件 + 只读校验，不做新权限模式。

### OP-H-14 工作流可重放最小版

- **目标：** 领域工作流增加 `journal`（阶段开始/结束/产物/错误），支持失败后从最后一个成功阶段重跑；不做 TS 脚本、不做 token 级缓存。
- **验收：** 同一工作流重跑不重复已经成功的阶段；journal 可回放；产物幂等。
- **风险：** 需要明确“哪些阶段可重放、哪些有副作用”；先只做只读/幂等阶段。

### OP-H-15 插件包清单与完整性

- **目标：** Pi 扩展从“路径登记”升级为“清单”：名称、版本、入口、权限声明、SHA-256、依赖；安装时校验，冲突时拒绝。
- **验收：** 清单可导出/导入；哈希不匹配拒绝加载；启停不影响其他扩展。
- **备注：** 不做市场、不做在线安装。

### OP-H-16 计划文件持久化（不做 PlanMode）

- **目标：** 复杂任务的计划落盘为 Markdown（工作区或 `docs/plans/`），Run 恢复时可读；不做“模型主动进入只读模式”。
- **验收：** 计划文件与 todo 同步；恢复后计划可见；不改权限语义。

### OP-H-17 观测导出（不引入 OTel/DB）

- **目标：** 把 stats/首字延迟/运行预算/usage JSONL 聚合为只读报表 API 与导出文件；供诊断和回归对比。
- **验收：** 可导出某 Run/某时间段的用量与延迟；字段稳定；不新增数据库。
- **备注：** 与 OP-H-04 共用归集层。

---

## 6. 保持项（Open Plan 领先，不照抄 ZCode）

| ID | 能力 | 保持理由 | 相关测试 |
|---|---|---|---|
| E-01 | 事件注册表（lifecycle/persist/schema） | 新增事件不会漏登记；回放/投影共用契约 | `test:event-registry`、`test:event-payload` |
| E-02 | 事件流归档/索引/游标回放 | 断线恢复与审计基础 | `test:event-archive`、`test:event-replay` |
| E-03 | 写入协调（锁/暂存/外部重叠/发布/丢弃） | 多 Run 并发不互相污染 | `test:write-lock`、`test:workspace-isolation` |
| E-04 | 产物验收 + 发布/回滚 + 内容哈希归属 | 交付可信度 | `test:artifacts`、`test:run-view` |
| E-05 | 完成语义（complete_task + 推断 + 客观下调） | 区分回答结束与任务完成 | `test:conclusion`、`test:run-trace` |
| E-06 | 首字延迟 8 阶段 + spans + P50/P95 | 体验回归基线 | `test:first-token-latency` |
| E-07 | 运行预算 + 重复失败门禁 + 进度播报 + 工具门禁 | 长任务不失控 | `test:run-budget`、`test:repeat-guard`、`test:progress-narration` |
| E-08 | 模式能力白名单 + 能力计划 + 契约测试 | 声明与工具一致 | `test:capability-contract` |
| E-09 | 子代理确定性编排 + 对抗核验 + roster | 可测、可回放 | `test:subagent-orchestrator`、`test:subagent-trace` |
| E-10 | 领域硬约束 + Review 证据链 | 交通规划可信度 | `test:domain-guard`、`test:review-fixes` |
| E-11 | 浏览器接管 lease | 人机协作 | `test:browser` |
| E-12 | 工作区隔离与路径校验 | 防止越界/污染 | `test:workspace-isolation` |

**原则：** 这些能力已经是 Open Plan 的事实来源；对标时只允许“补接口/补观测”，不允许为了与 ZCode 对齐而替换实现。

---

## 7. 里程碑建议

| 里程碑 | 范围 | 退出条件 |
|---|---|---|
| **M1 治理与计量** | OP-H-01、02、03、04 | 新增工具缺元数据测试失败；每次 ask/deny 有 ruleId；>30KB 结果可回溯；能回答 token 花在哪 |
| **M2 记忆与上下文** | OP-H-05、06 + OP-H-07、08 | 3 轮对话产生 ≥1 条合法记忆候选；召回可审计；段落顺序稳定；Skill 注入有预算 |
| **M3 扩展与编排** | OP-H-09、10、11、12 | Hook deny 能阻断且可审计；子代理 profile 不漂移；错误有 suggestion；配置优先级可测 |
| **M4 可选** | OP-H-13、14、15、16、17 | 按需启动；每项都有独立开关与回滚路径 |

**排序理由：** 先把“每次调用可解释”做出来（元数据/权限/结果/用量），再做“记忆与上下文”，最后做扩展与工作流。否则后面的能力没有可靠的观测与治理基础。

---

## 8. 风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pi 内核不支持并行工具调用 | OP-H-01 的并发声明无法落地 | 只把元数据用于权限/审计/预算；并发作为“未来能力”标注 |
| 内核 usage 不覆盖子代理 | OP-H-04 无法完整归因 | 记录 `unknown`，不估算；在文档中声明局限 |
| 额外模型调用（召回/抽取）增加延迟与成本 | 体验下降 | 默认关；按项目规模开启；设置预算与超时 |
| 权限审计事件量膨胀 | 事件流膨胀/性能下降 | 默认只记 ask/deny；allow 采样；不落盘高频事件 |
| Hook 成为新的攻击面 | 任意命令执行 | 默认关；命令白名单；超时/输出上限；信任态与声明哈希 |
| 元数据表与白名单双份事实 | 漂移 | 契约测试强制双向一致；单一模块导出 |
| 提示词段落重构导致行为回归 | 输出质量波动 | 字符串测试 + 真实模型抽样；按模式灰度 |
| 工作流重放引入隐式状态 | 重复副作用 | 只允许幂等阶段重放；journal 记录副作用 |

---

## 9. 需要用户确认的决策点

> 以下是实施前必须拍板的点；未确认前不进入编码。

1. **元数据表的归属：** 新增 `server/工具元数据.mjs` 作为元数据事实源，`task.mjs` 只保留模式可见性（推荐）；还是把元数据合并进 `task.mjs`（改动小但职责混杂）。
2. **只读工具是否逐次审计：** 只记录 ask/deny（推荐，成本低）；还是 allow 也全量记录（审计完整但事件量大）。
3. **记忆召回是否允许额外模型调用：** 默认关、按项目开启（推荐）；还是始终开启（体验好但慢/贵）。
4. **Hook 的事件范围：** 先做 4 事件（推荐）；还是直接对齐 ZCode 的 7 事件（完整但工作量大）。
5. **工作流做到什么程度：** 只做“阶段 + journal + 幂等重跑”（推荐）；还是引入 TS 脚本引擎（不建议）。
6. **结果外置阈值与预览方向：** 30KB + Bash tail / 其他 head（推荐）；还是沿用 16000 字符截断（改动最小但会丢内容）。

---

## 10. 本轮不做声明

- 本文档只做需求梳理与对照，**没有修改任何代码、配置、脚本或测试**。
- 未创建分支、未提交、未运行会改变状态的命令。
- 所有“验收脚本”名称是建议，不是已存在的文件；实施时需按仓库命名规范创建。
- 下一步：用户确认范围后，按 AGENTS.md §7 另立实施计划（`docs/plans/YYYY-MM-DD-NNN-*.md`），再进入编码与测试。
