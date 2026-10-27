# ZCode Harness 对标实施记录

> 状态：已完成（自动化验证通过，待用户验收）
> 基线：v0.13.2（develop）
> 更新：2026-10-27
> 分支：`feature/zcode-harness-align`（基于 `develop` HEAD `2a5e6263`；`origin/main` 是其祖先，因此与 main 无分叉冲突）
> 关联：[工程对照与修改计划](2026-10-27-004-ZCode-Harness工程对照与修改计划.md)、[对照测试与验收计划](2026-10-27-005-ZCode-Harness对照测试与验收计划.md)、[变更日志](../../变更日志.md)
> 说明：本轮一次性完成计划的 H1–H4 代码与自动化测试；**未升版本号**，所有新能力默认关闭（`OAW_HARNESS_ALIGN` 可一键开启整族）。

---

## 1. 交付摘要

- 新建分支 `feature/zcode-harness-align`，从 `develop` 当前 HEAD 拉出；`origin/main` 已在历史中（merge-base 为 `ed29cc2a`），不存在与 main 的版本分叉。
- 新增 16 个 Harness 模块、19 个测试脚本、8 个诊断 API；修改 9 个既有模块完成接线。
- `npm run test:harness` 全绿（含 17 个模块/契约脚本 + Harness API 冒烟）。
- `npm run verify` 全绿（全部 server 语法检查、Vite 构建、临时服务 API 冒烟）。
- 受影响回归全绿：事件注册表/负载、能力契约、审批作用域、交互归属、执行句柄、子代理编排/归约、记忆准入、运行预算、运行轨迹、首字延迟、工作流契约、领域硬约束、产物、写锁。
- 未升版本；Harness 相关改动已提交到 `feature/zcode-harness-align`，工作区原有未提交改动保持未暂存。

---

## 2. 实施范围

| WP | 能力 | 状态 | 关键实现 | 开关 |
|---|---|---|---|---|
| H1-1 | 工具能力元数据 | 完成 | `server/工具元数据.mjs`；注册期校验；Chat 只读断言 | `OAW_TOOL_METADATA` |
| H1-2 | 权限决策可审计 | 完成 | `审批策略.mjs` 决策对象 + ruleId；ask/deny 审计事件；auto 保留 `originalAction` | `OAW_PERMISSION_AUDIT` |
| H1-3 | 工具结果外置 | 完成（自定义工具 + grep/find/ls） | `server/工具结果外置.mjs`；自定义工具与 read/write/edit/bash/grep/find/ls 统一包装；Bash tail 预览 | `OAW_TOOL_RESULT_ARTIFACT` |
| H1-4 | 用量归集 | 完成 | `server/用量归集.mjs`；主会话/子代理/压缩归因；JSONL | `OAW_USAGE_LEDGER` |
| H2-1 | 记忆语义召回 | 完成（同步关键词 + 模型 seam） | `server/记忆召回.mjs`；每轮动态上下文替换全量摘要 | `OAW_MEMORY_RECALL` |
| H2-2 | 记忆自动抽取 | 完成 | `server/记忆抽取调度.mjs`；Run 收尾异步、只读子会话、候选进待审核 | `OAW_MEMORY_EXTRACT` |
| H2-3 | 上下文分段契约 | 完成 | `server/上下文段落.mjs`；7 段顺序/预算/注入目标 | `OAW_CONTEXT_SECTIONS` |
| H2-4 | Skill 注入契约 | 完成 | `server/Skill注入.mjs`；`<skill_content>` + 20KB 预算 + 哈希 | `OAW_SKILL_INJECTION` |
| H3-1 | Hook 声明式事件层 | 完成（4 事件） | `server/Hook事件层.mjs`；Pre/PostToolUse 包装；UserPromptSubmit/Stop 回合接线；命令白名单/超时/信任 | `OAW_HOOK_EVENTS` |
| H3-2 | 子代理 profile/后台/计量 | 完成 | `server/子代理配置.mjs`；profile 冻结事件；后台派发；子代理用量 | `OAW_SUBAGENT_PROFILE` |
| H3-3 | 统一工具错误 envelope | 完成（包装层） | `server/工具错误.mjs`；异常 → code/message/suggestion/retryable | `OAW_TOOL_ERROR_ENVELOPE` |
| H3-4 | 配置优先级与资源发现 | 完成（读取侧 source 已接入） | `server/配置来源.mjs`、`资源发现.mjs`；技能/记忆/计划读取侧带 source | `OAW_CONFIG_SOURCE` |
| H4-1 | 权限模式映射 | 保持既有实现 | Chat 白名单天然只读；Review 原文写保护不变；未新增模式 | — |
| H4-2 | 工作流可重放最小版 | 完成（Run 步骤更新路径） | `server/工作流日志.mjs`；`runs.mjs` 步骤更新写 journal；`/api/runs/:id/workflow-journal 与 /api/runs/:id/workflow-replay` | `OAW_WORKFLOW_JOURNAL` |
| H4-3 | 插件包清单与完整性 | 完成 | `server/插件清单.mjs`；Pi 扩展 `lastCheck.manifest`；哈希不匹配拒绝 | `OAW_PLUGIN_MANIFEST` |
| H4-4 | 计划文件持久化 | 完成 | `server/计划文件.mjs`；`GET/POST /api/harness/plans` | `OAW_PLAN_PERSISTENCE` |
| H4-5 | 观测导出 | 完成 | `server/观测导出.mjs`；`GET /api/harness/observability` | `OAW_OBSERVABILITY_EXPORT` |

---

## 3. 新增文件

### 3.1 服务端模块

- `server/工具元数据.mjs`
- `server/工具结果外置.mjs`
- `server/用量归集.mjs`
- `server/记忆召回.mjs`
- `server/记忆抽取调度.mjs`
- `server/上下文段落.mjs`
- `server/Hook事件层.mjs`
- `server/工具错误.mjs`
- `server/配置来源.mjs`
- `server/工作流日志.mjs`
- `server/插件清单.mjs`
- `server/计划文件.mjs`
- `server/观测导出.mjs`
- `server/Skill注入.mjs`
- `server/子代理配置.mjs`
- `server/资源发现.mjs`

### 3.2 测试脚本

- `scripts/工具元数据契约测试.mjs`
- `scripts/权限决策审计测试.mjs`
- `scripts/工具结果外置测试.mjs`
- `scripts/用量归集测试.mjs`
- `scripts/记忆召回测试.mjs`
- `scripts/记忆抽取调度测试.mjs`
- `scripts/上下文段落契约测试.mjs`
- `scripts/Skill注入契约测试.mjs`
- `scripts/Hook事件层测试.mjs`
- `scripts/子代理profile与后台测试.mjs`
- `scripts/工具错误契约测试.mjs`
- `scripts/配置优先级测试.mjs`
- `scripts/工作流日志测试.mjs`
- `scripts/工作流执行器接线测试.mjs`
- `scripts/插件清单测试.mjs`
- `scripts/计划文件测试.mjs`
- `scripts/观测导出测试.mjs`
- `scripts/Harness开关对照测试.mjs`
- `scripts/Harness接口冒烟测试.mjs`

### 3.3 文档

- `docs/plans/2026-10-27-008-ZCode-Harness实施记录.md`（本文）

---

## 4. 修改文件与接线点

| 文件 | 修改 |
|---|---|
| `server/运行开关.mjs` | 新增 18 个 H 线开关 + 4 个数值配置；`OAW_HARNESS_ALIGN` 总开关；快照下发 |
| `server/事件注册表.mjs` | 新增 21 个事件（元数据/权限/外置/用量/召回/抽取/Hook/profile/段落/Skill/配置/journal/插件/计划） |
| `server/审批策略.mjs` | `matchToolDecision` 返回 ruleId/ruleSource/matchedPattern/reason；auto 保留 `originalAction`；审批载荷在 flag 关闭时保持基线键集 |
| `server/agent.mjs` | 导入并接线元数据校验、工具包装（Hook/外置/错误）、usage 记录（主/子/压缩）、记忆召回、上下文段落、Skill 注入、子代理 profile/后台/用量、UserPromptSubmit/Stop Hook、记忆抽取子会话 |
| `server/执行句柄.mjs` | Run 成功后异步触发记忆抽取（条件/预算/候选提交），不阻塞终态 |
| `server/index.mjs` | 新增 `/api/harness/tools`、`/usage`、`/observability`、`/plans`（GET/POST）、`/hooks`；`/api/runs/:id/workflow-journal 与 /api/runs/:id/workflow-replay` |
| `server/runs.mjs` | 工作流步骤更新时写 journal 与 `workflow_journal_updated` 事件（flag 开启） |
| `server/pi扩展管理.mjs` | 清单模式下附加 `manifest` 与 `lastCheck.manifest`（flag 关闭不加字段） |
| `server/Pi运行时管理.mjs` | 导出 `createGrepToolDefinition/createFindToolDefinition/createLsToolDefinition`，供结果外置包装使用 |
| `package.json` | 新增 19 个 `test:*` 别名（含聚合 `test:harness`） |

---

## 5. 验证证据

### 5.1 新增测试

```text
npm run test:harness
  ✓ 18 个模块/契约脚本全部通过（约 90 条断言）
  ✓ Harness API 冒烟 7 条（含 POST /api/harness/plans）
```

### 5.2 仓库门禁

```text
npm run verify
  ✓ server/*.mjs 语法检查（含全部新模块）
  ✓ vite build 成功
  ✓ 临时服务启动与 API 冒烟全部通过
```

### 5.3 受影响回归

```text
test:event-registry        ✓（140 种事件；persist ⊆ lifecycle）
test:event-payload         ✓（新增事件 schema 不破坏存量）
test:capability-contract   ✓
test:approval              ✓（更新为 ruleId/auto 语义断言）
test:interaction-owner     ✓（flag 关闭时审批载荷键集与基线一致）
test:exec-handle           ✓
test:subagent-orchestrator ✓
test:subagent-trace        ✓
test:memory-admission      ✓
test:run-budget            ✓
test:run-trace             ✓
test:first-token-latency   ✓
test:workflow-contract     ✓
test:domain-guard          ✓
test:artifacts             ✓
test:write-lock            ✓
test:workflow-executor     ✓（Run 步骤 → journal → 重放计划）
```

### 5.4 开关打开冒烟

```text
OAW_HARNESS_ALIGN=1 npm run test:harness-api
  ✓ 服务可启动
  ✓ 6 个诊断接口结构正常

隔离真实模型冒烟（临时数据目录，环境 MINIMAX_API_KEY，minimax-cn/MiniMax-M2.7）
  ✓ Chat：Run completed，最终文本 “OK”；context_sections_assembled / memory_recall_selected / stats 均出现
  ✓ Chat 用量：2 条 usage 记录，合计 13574 tokens；/api/harness/usage 与 observability 均可读
  ✓ Work：read 工具 + complete_task 执行，最终文本 HARNESS_L3_TOOL2_OK
  ✓ 结果外置：OAW_TOOL_RESULT_MAX_BYTES=64 时 read 结果外置 4116 字节，tool_result_externalized 事件可回放
  ! 国际 minimax 端点返回 401；minimax-cn 端点可用（同一 Key 的端点差异）
```

---

## 6. 偏差、限制与未验证项

1. **工具结果外置覆盖范围：** 自定义工具与 `read/write/edit/bash/grep/find/ls` 已统一包装；Pi SDK 内部未暴露为工具定义的其它内部输出不在本包装层范围内。
2. **记忆召回的同步路径使用关键词选择。** `selectMemoriesWithModel` 已提供模型选择 seam，但每轮 prompt 组装使用同步关键词选择，避免额外模型调用；模型选择未接入真实回合。
3. **工作流 journal 已接入 Run 步骤更新路径。** `updateRunStep` 在 flag 开启时写 journal 与 `workflow_journal_updated`；`/api/runs/:id/workflow-replay` 返回重放计划。当前仍没有独立的“领域工作流中央执行引擎”，重放由调用方消费计划执行。
4. **配置来源已接入读取侧 source。** 技能根目录、记忆 manifest、计划列表返回 `source/sourceKind/sourcePath`；既有资源发现顺序保持兼容，未做破坏性重排。
5. **H4-1 未新增权限模式。** Chat 只读依赖既有 `task.mjs` 白名单；Review 原文写保护保持既有实现。
6. **压缩用量为“计数可见、token 未知”。** 记录 `actorKind=compaction`、`querySource=compact`，但 token 字段为 `null`，不估算。
7. **L4 人工验收未做。** L3 已在隔离临时数据目录通过（`minimax-cn/MiniMax-M2.7`：Chat 完成、上下文段落/记忆召回/用量可见；Work 完成 read 工具调用与结果外置）。L4 仍需人工验收：界面审批 UX、Hook 拒绝后的模型反应、后台子代理的用户可见性、产物面板展示。
8. **已按 Harness 范围提交。** 本轮 Harness 相关文件已提交到 `feature/zcode-harness-align`（52 个文件，6205 行新增）；工作区仍保留本轮之前的 AVA/Office/Goal 未提交改动，未混入提交。

---

## 7. 回滚

- 所有新能力默认关闭；关闭后行为与基线一致。
- 新增数据文件（usage/tool-results/hooks-trust/journal/plans）均为增量写入；关闭开关即停止写入，不迁移、不删除用户数据。
- 新增事件只在开关开启时发；旧事件 schema 未改。
- 审批载荷在 `permissionAudit` 关闭时保持基线键集（`test:interaction-owner` 已验证）。

---

## 8. 验收建议

1. 在 `feature/zcode-harness-align` 分支上先跑：`npm run test:harness`、`npm run verify`。
2. 开启 `OAW_HARNESS_ALIGN=1` 跑 3 个真实任务：Work 生成 Word、Review 审文档、Chat 查资料；重点看审批 ruleId、结果外置、用量、记忆召回、Hook（如配置）。
3. 若只验收部分能力，按 WP 单独开开关，避免整族一起开。
4. 验收通过后再决定是否合并 `develop`/`main`；本轮不升版本、不打 tag。
