# 0022 Harness 并发采用短锁与版本 CAS，而不是跨会话工作区锁

- 状态：已采纳
- 记录日期：2026-11-04
- 决策者：用户（批准 A+B+C 方案）
- 基线：v0.13.3（develop）
- 关联：[计划 016](../plans/2026-11-04-016-Harness并发模型对标DSH计划.md)、`server/写入协调.mjs`、`server/文件版本.mjs`、`server/bash写锁.mjs`、`server/技能目录.mjs`

## 1. 背景

同一工作区并行 3–5 个任务时，`stageWrite` 把目标锁持有到 Run 结束，`bashWriteTargets` 对无法推导的命令回退锁工作区根；长任务会长期挡住其他会话。Skills 又按会话创建时的固定 top-8 与复杂度阈值路由，新增 workspace 技能不可见。DSH/ZCode 的实践是“会话独立 + 文件版本 CAS + 无跨会话工作区锁”。

## 2. 问题

如何在保留产物暂存/发布安全边界的前提下，让长任务不被整区锁死、同工作区多会话互不阻塞，并让技能目录按任务实际可见？

## 3. 备选方案

### 方案 A：继续用跨会话工作区/目标长锁

- 做法：沿用 stage 锁持有到 Run 结束，未知 bash 回退工作区根。
- 优点：实现简单，同一文件绝对串行。
- 代价/风险：长任务互相拖死；只读/未知命令也会排队；测试已实测 20s 冲突。

### 方案 B：完全去掉文件锁，只靠最后写入者

- 做法：照搬 bash 的 last-writer-wins，不做版本检查。
- 优点：最简单、并发最高。
- 代价/风险：静默覆盖产物，无法追责，违背本地优先数据安全。

### 方案 C：短锁 + 版本 CAS + 冲突副本（采纳）

- 做法：`write/edit` 只锁写 staging 瞬间；发布时短锁内比对 `baseRevision`；变化则写 `name.conflict-<runId>` 副本并发事件。bash 只锁可推导目标；未知命令 advisory 不锁工作区根；git 写锁 `.git`。
- 优点：长任务不再整区阻塞；同一文件不静默覆盖；可回滚、可观测。
- 代价/风险：冲突副本会多出文件；bash 盲写同文件仍可能竞态；实现复杂度上升。

## 4. 决策

选择 **方案 C**。适用边界：

- 同一文件的两个 `write/edit` 并发发布 → 后发布者生成冲突副本，不覆盖。
- bash 无法静态推导写目标 → 默认不锁工作区根，发 `write_scope_unknown`；需要强串行时用 `OAW_BASH_SCOPE=strict`。
- git 写操作只锁 `.git`；会改工作树的子命令额外标记 unscoped，由单写者约定协调。
- 读后写守卫默认 advisory；严格模式用 `OAW_FS_OBSERVATION=strict`。

## 5. 理由

- 项目约束是“本地优先、可回滚、可测试、单一事实来源”：不能为了并发静默丢文件，也不能让锁把整个工作区变成单线程。
- DSH 的 per-path 短锁 + stat 版本 CAS 已在同目录多会话场景验证；本项目保留 staging/发布，额外获得冲突副本，比 DSH 更适合产物交付。
- Skills 的固定 top-8/复杂度阈值是拍脑袋规则；目录注入 + 模型判断与 DSH 一致，且 workspace 技能可热更新。

## 6. 影响

### 正面

- 长任务早期写过的文件不再挡住其他会话。
- 未知 bash（构建脚本）不再锁工作区根；git commit 不挡文件编辑。
- 同一文件冲突可见、可恢复，不静默覆盖。
- 每轮技能目录随 workspace 变化，新增技能下一轮可见。

### 负面 / 代价

- 冲突副本增加产物数量，需要终态摘要/产物面板标注。
- bash 盲写同一文件仍 last-writer-wins；强一致需 strict 模式。
- 模型/Office 并发默认提高后，provider 可能限流；可由环境变量降回。

### 迁移与回滚

- 迁移：旧 manifest 无 `baseRevision` 时按“不校验”兼容；无需数据迁移。
- 回滚：`OAW_BASH_SCOPE=strict` 恢复 bash 工作区根锁；`OAW_FS_OBSERVATION=strict` 提高写入门槛；删除新增模块不影响旧数据。
- 契约：新增事件 `artifact_conflict`/`artifact_materialize_skipped`/`write_scope_unknown`/`write_stale` 已登记；旧事件不变。

## 7. 验证

- `test:version-cas`、`test:session-concurrency`、`test:parallel-write-lock`、`test:write-lock`、`test:bash-locks`、`test:phase1` 全绿。
- `npm run verify` EXIT=0。
- 真实验收：同 workspace 3 会话并行、同文件冲突副本、切会话不中断。

## 8. 复审触发条件

- 并行会话数长期超过 6，或 provider 限流成为主要故障。
- 冲突副本出现频率高到影响产物目录可用性。
- bash 盲写导致的数据损坏成为实际事故。
- Pi SDK 或存储模型变更，使 staging/版本 CAS 不再适用。

## 9. 参考

- [DSH Harness 机制总结](../../../dsh文件夹/DSH-Harness-机制总结.md)（外部资料）
- [计划 016](../plans/2026-11-04-016-Harness并发模型对标DSH计划.md)
- `server/文件版本.mjs`、`server/写入协调.mjs`、`server/bash写锁.mjs`、`server/技能目录.mjs`
