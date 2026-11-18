# 0040 宪法新增 oil-dev 开发约定小节供开发流程套件读取

- 状态：已采纳
- 记录日期：2026-11-18
- 决策者：用户（本轮对话直接指令：「agent,md按照你说的稍微修改一下吧」——按上一轮提议在 `AGENTS.md` 增加 Dev profile (oil-dev) 小节）
- 基线：v0.13.25（`develop @ 8fc02209`）
- 关联：`AGENTS.md` v2.9 §12、[ADR 0003](0003-事件注册表作为事件流唯一事实来源.md)、[ADR 0039](0039-开发工作流按改动规模分级与方案对抗审查.md)、oil-dev-skills（外部开发流程 Skill 套件，安装于宿主 `~/.trae-cn/skills/`）

## 1. 背景

仓库开发环境引入外部 Skill 套件 oil-dev-skills（探索 / 方案 / 委托 / 审查 / 缺陷修复 / 治理六个环节）。该套件约定从仓库根 `AGENTS.md`（无则 `CLAUDE.md`）读取**标题含 `oil-dev` 的小节**作为唯一配置源：快测怎么跑、合并前跑什么、哪些目录改动须走独立深审。宪法 §5.1、§7.1、§7.2 已有 Pi 边界、提交门禁与关联快测要求，但以条款形式存在，机器不可读；不落地该小节，套件只能回退到内置默认值自行猜测。

## 2. 决策

在 `AGENTS.md` 末尾新增 `## 12. 开发约定（oil-dev）`，条目如下：

- **快测**：`npm run test:{target}`——`{target}` 为 `package.json` 中的主题脚本名（仓库测试全部按主题脚本组织，无全局可过滤 runner），对应 §7.2 关联快测；
- **门禁**：`npm run verify`；S2 / S3 另加 `npm run test:ui-smoke`（§7.2 既有口径）；
- **高风险**：`server/事件注册表.mjs`（事件唯一事实来源，[ADR 0003]）、`server/task.mjs`（模式 / 工具白名单唯一事实来源）、`server/agent.mjs`、`server/Pi运行时管理.mjs`、`server/项目信任.mjs`（§5.1 仅有的三个可直接 import Pi SDK 的模块）、`client/src/会话流/**`（[ADR 0039] 复盘数据：会话流单模块吃掉 31% 的 fix）；
- **不写「禁改」条目**：`node_modules/`、`client/dist/`、`.oaw/` 等均被 Git 忽略，不会出现在 diff 中，套件格式规范明确此类目录无需列出。

本小节是**配置性索引**，复述既有条款，不新增、不放宽任何约束；与 §5.1、§7.1、§7.2 冲突时以后者为准。

## 3. 备选与取舍

- **方案 A（采纳）**：宪法末尾新增小节。收益：套件直接读取，人与机器共用同一处事实；代价：宪法多一个需随测试入口与目录演进同步维护的配置块（已在 §12 中声明条目变更按 §11 执行）。
- 方案 B：写入单独的 `dev-profile.md` 或 `~/.oil-dev/preferences.md`。不采纳：套件只扫 `AGENTS.md` / `CLAUDE.md` 中标题含 `oil-dev` 的小节，单独文件不会被读取。
- 方案 C：把 §5.1 / §7.2 条款整体重写为 profile 形态。不采纳：改动面大，违背用户「稍微修改一下」的指示，且条款的效力顺序与解释规则无法压缩为命令行条目。

## 4. 落地

- `AGENTS.md` v2.8 → v2.9：版本头更新，末尾新增 §12；
- `变更日志.md` 记一条 `docs`；决策记录索引新增 0040 行并更新头部日期。

## 5. 验证

- §12 标题含 `oil-dev`、小节 ≤10 行，符合套件读取约定；
- 快测命令实跑抽验：`npm run test:capability-contract` 通过（0.2s，秒级）；
- 高风险路径全部真实存在：`ls` 校验 `server/事件注册表.mjs`、`server/task.mjs`、`server/agent.mjs`、`server/Pi运行时管理.mjs`、`server/项目信任.mjs`、`client/src/会话流/` 均在；
- 纯文档改动，不触发 §7.0 文档先行闸门（无代码变更）；提交前跑 `npm run verify` 与 `npm run check:commit-gate`。
