# AGENT.MD — Open Plan 工作准则

## 项目定位
面向**交通规划工程师**的 Office 工作台：web 前端（React/Vite）+ 后端（Express/pi agent）+ officecli 文档处理。

## 治理规则（2026-10-20 起强制）
文件管理 / 测试分级门禁 / 验收 DoD 详见 `docs/2026-10-20-项目文件管理与测试验收规则.md`。
要点：一次提交=一条工作流（pathspec 提交，禁 `git add -A`）；提交前 L4 `npm run verify` 必过 + 改动面对照表定向回归；`临时-` 前缀脚本当次会话删除；目标层/架构/ADR/路线图见 `docs/2026-10-20-*` 四篇。

## 命名规范（强制）
- 所有新文件**必须中文命名**，禁止英文文件名（文档/报告/脚本/组件说明类）。
- 例外：代码文件按语言惯例（.jsx/.mjs/.md 等，如 Icon.jsx）。

## 坐标与数据校验（交通规划数据）
- 中国坐标范围：经度 73-135°E，纬度 18-54°N；转换后超范围立即报警。
- OD/客流数据导入后：验证记录数（expected vs actual），不完整不继续。

## 开发工作流
1. 每轮需求：从 develop 拉 `feature/xxx` 分支。
2. 修改后跑 `npm run verify`（语法+构建+冒烟），通过才提交。
3. 更新「变更日志.md」，提交信息格式：`类型: 描述`（feat/fix/docs/chore）。
4. 合并回 develop，稳定后合 main 打 tag `v0.x.y`。

## 编码准则
- 简单优先：最小代码解决问题，不做投机性抽象。
- 最小侵入：只改必须改的，匹配现有风格，不顺手重构。
- 目标驱动：任务转成可验证目标，循环到验证通过。
- 修改前端组件前先看同目录其他组件的写法，复用 `Icon.jsx` 统一图标，样式变量用 CSS 变量。

## 对话与界面约定
- 对话需同时支持 Office 编辑（officecli）与创作模式。
- 界面需保持暗/亮双主题（CSS 变量驱动）。
- 涉及 agent 能力/新功能时，在对话末尾用简短条目更新本文件（保持 <80 行）。
- 每次用户请求都应形成 TaskEnvelope：明确目标、当前文件、引用、工作流、输出格式和约束。
- Agent 完成任务时固定总结：读取来源、修改文件、产物、假设、下一步；无法读取的引用必须明示。
- 复杂任务先输出 2-6 项 Markdown 待办清单，并在完成每项后将对应的 `- [ ]` 更新为 `- [x]`；前端会将其固定显示在指令栏上方。
- 长期记忆先以“记忆建议”呈现，用户确认后才写入 `memory/MEMORY.md`。

## pi agent 能力边界（调研结论 v0.83）
- 官方**不支持** subagent / plan mode；todo 列表已由前端"执行步骤"实现。
- 多技能协作通过「技能集合/智能体广场」预置工作流模拟（一次 @ 多 skill + 角色指令）。
- 新能力需求 → 优先做成 skill / 前端工作流，而非改 pi 内核。

## 已知坑（v0.83）
- 并发 prompt：agent 收尾（compaction/post-run）时 `entry.busy` 已 false 但 pi 内部仍 isStreaming，直接 prompt 会抛 "Agent is already processing" → 已加竞态重试（走 steer）。
- 创作模式产物必须写入工作区（`office-workspace`），否则 `snapshotWorkspace` 检测不到、产物不显示。已写入 agent 上下文约束。
- 前端组件内 hooks 不得放在 `if (!open) return null` 之后（React 规则），曾导致技能弹窗白屏。
- 运行记录保存在项目 `.oaw/runs/`（已加入 `.gitignore`），用于产物归属、审计和可选回滚，不应提交到 Git。

## pi 内核独立 app（调研结论，未实施）
- pi 提供完整 SDK（`createAgentSession`/`ModelRuntime`/`setThinkingLevel`），现有 web 版已是嵌入式用法。
- 打包方案：Electron/Tauri 壳 + 现有 server/前端，或 `bun build --compile` 单文件二进制。
- 优势：独立进程稳定、可离线本地；成本：需维护壳层、自动更新、officecli 分发。

## 当前能力（目标 v0.10.2）
- 对话顶部固定执行流，支持折叠及隐藏/恢复；思考块默认展开并固定 240px 独立滚动。
- 顶部控制区提供模型上下文用量环形圈和 Codex 风格审批模式按钮；自动批准不覆盖显式 deny 规则。
- CAD 能力（双开关默认关）：`OAW_CAD_PREVIEW=1` 后 DXF/DWG 进文件树并可 SVG 预览（图层显隐/缩放/块展开，`CadViewer.jsx`）；`OAW_CAD_AGENT=1` 后 agent 可经 `context_read`/`cad_read` 读图纸摘要、`cad_edit` 做白名单修改（替换文字/图层改名/移层/删实体/加 LINE/CIRCLE/TEXT，写入走审批）。DWG 依赖外部转换工具（ODA/LibreDWG 或 `OAW_DWG_CONVERTER`），未装自动降级并提示；零新增 npm 依赖，解析见 `server/CAD解析.mjs`/`server/CAD修改.mjs`，专项文档 `docs/CAD预览专项/`。
