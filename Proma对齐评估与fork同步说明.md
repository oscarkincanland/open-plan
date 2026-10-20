# Proma 对齐：fork 同步说明 + 三模块评估与结论

> 生成时间：2026-10-19
> 涉及对象：open plan（本地项目 `e:\open plan`）与 Proma fork（`oscarkincanland/Proma-open-plan`，上游 `proma-ai/Proma`）
> 许可提示：**Proma 为 AGPL-3.0**，本仓仅作"能力/交互语义对齐"，不得复制其源码或文案。

---

## 0. 结论摘要（TL;DR）

| 请求项 | 结论 | 说明 |
|---|---|---|
| ① fork 与上游同步配置 | ✅ **已完成（本地）** | 全历史 + upstream remote + 同步流程；GitHub 侧需你本人操作（本机无 `gh`） |
| ② provider 层"重构" | ⚠️ **不建议重构**，建议 opt-in 增量 | 你与 Proma 的 provider 是两套不同设计（Pi 原生目录 vs Channel 实体）；重构会推翻现有可用实现 |
| ③ 子 agent "完全复现 Proma" | ❌ **不能 100% 复现** | 两者运行时架构不同（见 §3）；可复现的是"能力项"，不是"形态" |
| ④ 皮肤系统"重构" | ⚠️ **已存在，无需重构** | `theme.jsx` 已有多主题 + 变量注入 + 无缝切换（含 "Proma 清晰" 皮肤） |
| ⑤ 全量回归 + 修改说明文档 | 本次仅新增本文件 | 因 ②③④ 均未改动核心，无新增回归面 |

> 根因：本次请求的措辞（"重构/调整核心"）与项目既有铁律（**对齐项独立开关、默认关闭、开关关闭时核心代码逐字保留、三层可回滚、不得推翻原有架构意图**）以及 AGPL 约束**正面冲突**。为了让项目保持可运行、可回滚，本次**未对核心做任何重构**。

---

## 1. 第 1 项：fork 与上游同步配置（已完成）

### 1.1 已完成的配置

克隆位置：`C:\Users\Administrator\.cache\reference\proma-open-plan`（完整历史，非浅克隆）

| 项目 | 值 |
|---|---|
| `origin` | `https://github.com/oscarkincanland/Proma-open-plan.git`（你的 fork） |
| `upstream` | `https://github.com/proma-ai/Proma.git`（原作者仓库） |
| 默认分支 | `main`（双方一致） |
| 提交历史 | 完整：**2101 commits**（已 `--unshallow`） |
| tags | 已从 upstream 拉取 |
| 与上游差距 | 领先 0 / 落后 0（当前完全同步） |
| 工作分支 | `open-plan`（从 `main` 切出，用于承载后续本地改动） |

### 1.2 使用指南：日常同步上游

```powershell
# 1) 切到承载本地改动的分支
git switch open-plan

# 2) 拉取上游最新
git fetch upstream --tags

# 3) 把上游合入（保留你的增量）
git merge upstream/main

# 4) 推回你自己的 fork（可选，用于备份/多人协作）
git push origin open-plan
```

### 1.3 避免后续合并冲突的规则（重要）

1. **不要往 `main` 提交**：`main` 只做"上游镜像"，永远用 `git merge upstream/main` 快进或合并，保持与上游零分歧。
2. **本地改动只加不改**：所有自有内容放在**新增文件/新目录**（例如 `open-plan/` 覆盖层）里，**绝不修改 Proma 原有文件的同一行**。这是避免冲突的根本手段。
3. **建议开启两项本地配置**（本次**未代改**，遵循"不擅自改 git config"）：
   ```powershell
   git config rerere.enabled true      # 记住冲突解法，重复合并自动复用
   git config merge.conflictStyle zdiff3  # 冲突块显示更完整，便于判断
   ```
4. **不要 squash**：保留完整提交历史，否则后续每次同步都会产生巨大冲突。

### 1.4 GitHub 侧（需你本人完成）

本机**未安装 `gh`**，我无法代你操作 GitHub。请自行确认/执行：

- 在 GitHub fork 页面确认上游为 `proma-ai/Proma`（网页 "Sync fork" 按钮即可一键同步）。
- 若希望命令行同步，安装 `gh` 后：`gh repo sync oscarkincanland/Proma-open-plan --source proma-ai/Proma`。

---

## 2. 第 2 项：provider 层评估

### 2.1 两边的设计本质不同

| 维度 | Proma | 你的项目 |
|---|---|---|
| 概念 | **渠道 Channel**（一等实体） | **Pi 内置目录 + 一键导入** |
| 类型定义 | `ProviderType` 白名单 ~22 项，**按协议**拆分（anthropic / openai / openai-responses / google / custom…）+ 默认 URL + 显示名 | `Pi内置供应商.json`（从 Pi SDK bundle 固化）+ `IMPORTABLE_APIS` 协议白名单 |
| 凭据 | `~/.proma/channels.json`，**Electron safeStorage 加密** | UI 凭据存储 / 环境变量（`auth.json`、`models-store.json` 为空） |
| 预设模型 | 各厂商 preset + `enabled` + 版本迁移（新增模型不复活用户删过的） | 由 `models.json` + 能力反查（上下文窗口/图片/思考） |
| 接进运行时 | `resolveChannelRuntimeApiKey(channelId)` → `buildModel()` → Pi `modelRuntime` | `Pi配置管理.mjs` / `Pi运行时管理.mjs` 直接驱动 Pi |
| 治理层 | 连接测试（15s 超时）+ 模型拉取 + **配额查询** + OAuth 刷新 | 目录反查 + 套餐目录；无统一连接测试层 |
| 相关文件 | `packages/shared/src/types/channel.ts`、`main/lib/channel-manager.ts`、`adapters/pi-agent-adapter.ts` | [供应商目录.mjs](file:///e:/open%20plan/server/%E4%BE%9B%E5%BA%94%E5%95%86%E7%9B%AE%E5%BD%95.mjs)、[Pi配置管理.mjs](file:///e:/open%20plan/server/Pi%E9%85%8D%E7%BD%AE%E7%AE%A1%E7%90%86.mjs)、[Pi运行时管理.mjs](file:///e:/open%20plan/server/Pi%E8%BF%90%E8%A1%8C%E6%97%B6%E7%AE%A1%E7%90%86.mjs) |

> 说明：Proma 的"分层/依赖注入"是 **Electron 主进程 + 渲染进程** 的产物（`apps/electron` + `packages/core|ui|shared`）；open plan 是**扁平 Node ESM + React Web**，该范式**无法 1:1 映射**。所谓"对齐 DI 范式"在此项目上并不成立。

### 2.2 为什么不建议"重构"

- 现有 provider 链路是 Pi 原生路径，**已在运行**；重构等于推翻现有可用实现，违背铁律。
- 无收益：Proma 的 Channel 抽象服务于"多运行时（Claude/Pi 双内核 + 飞书/Slack 桥）"，你只有单一 Pi 运行时，引入 Channel 实体是**纯粹的抽象负担**。

### 2.3 建议的 opt-in 增量（不动核心，独立开关，默认关）

1. **统一连接测试层**：对任一已配置供应商做 `models` 端点探测 + 延迟/错误归一化（独立开关，默认关）。
2. **凭据落盘加密可选化**：若你将来开放局域网访问，再考虑加密存储（当前本地单机，非必需）。
3. **协议化预设模型**：把"默认启用模型"做成白名单常量 + 一次性候选更新（避免复活用户删过的模型）。

---

## 3. 第 3 项：子 agent —— "能否完全复现 Proma 的功能？"

### 3.1 直接回答：**不能 100% 复现**

原因是**形态不同**，不是"功能没写全"：

| 维度 | Proma | 你的项目 |
|---|---|---|
| 驱动方式 | **模型自治**：内置 `collaboration` MCP 工具 + SKILL 教模型何时用 | **代码确定性编排**（[子代理编排器.mjs](file:///e:/open%20plan/server/%E5%AD%90%E4%BB%A3%E7%90%86%E7%BC%96%E6%8E%92%E5%99%A8.mjs) 注释明确"编排用代码，不用模型自治"） |
| 子会话本质 | **真实可见的独立 Agent 会话**（`agent-session-manager` + headless runner） | 进程内子任务（角色化执行器） |
| 工具面 | `delegate_agent(s)` / `wait_for_delegations`（收敛屏障）/ `list/get_delegations` / `set_delegation_thinking_level` / `stop_delegation(s)` | 角色表驱动：`scout/reviewer/planner/verifier/worker` |
| 并发上限 | 每父会话 50（SKILL 建议实际 2–8） | `SUBAGENT_CONCURRENCY=2`、单批 `MAX_TASKS=4` |
| 收敛语义 | **启动 ≠ 完成**；父必须先 `wait_for_delegations` 才可交付，超时不得伪造汇总 | verifier 回环（revise 1 轮）+ 事件溯源 |
| 交互回传 | **阻塞事件冒泡**（子会话 `ask_user`/权限请求冒泡到父） | 子代理以只读为主，无交互回传 |
| 幂等 | 有：Pi 会重放 tool call，故有**委派幂等缓存** | 无（当前编排是确定性单次派发） |
| 可观测 | 灵动岛 / `CollapsedDelegatedSessionsPopover` | `subagent_planned/started/result/verified/closed` 事件可回放 |
| 子会话权限 | 不高于父；子会话**不能再派子会话** | `resolveRole` 降级（worker 需父可写，否则降 scout） |
| 可继承项 | 渠道 `channelId` + `modelId` + `thinkingLevel` | 继承父会话模型 |

### 3.2 可复现 / 不可复现清单

**可复现（增量即可，opt-in）**
- 委派**幂等缓存**（若你在 Pi 流上遇到 tool call 重放）。
- **阻塞事件冒泡**（子会话的 `ask_user`/权限冒泡到父会话）。
- **"启动≠完成"的显式收敛语义**（你现在 verifier 回环已接近，可显式化）。
- 子任务**指定模型 / thinkingLevel**。

**不可复现（除非重写架构）**
- "真实可见的独立子会话"（你的子代理不是独立会话对象）。
- 前端"子会话面板/灵动岛"级别的可视追溯。
- 每父 50 并发的大规模扇出（与你 2/4 的设计取向相反）。

> 若目标是"完全复现"，代价 = 重写子代理 + 会话管理 + 前端子会话面板，等同把 open plan 改成 Proma 形态。**不建议**，也与"低侵入"矛盾。

---

## 4. 第 4 项：皮肤系统评估

### 4.1 现状：你**已经有**多主题系统（无需重构）

[theme.jsx](file:///e:/open%20plan/client/src/theme.jsx) 已实现：

- **两个正交维度**：`theme`（`dark` / `light`）× `skin`（7 套：`proma` "Proma 清晰" / `glass` 磨玻璃 / `default` / `ocean` / `forest` / `sunset` / `violet`）。
- **全局注入**：`<html data-theme=... data-skin=...>` 驱动 CSS 变量。
- **无缝切换 + 防闪**：`ThemeProvider`/`useTheme` + localStorage 持久化。
- 另有 [界面外观.js](file:///e:/open%20plan/client/src/%E7%95%8C%E9%9D%A2%E5%A4%96%E8%A7%82.js) 的动效/跑马灯等 `data-*` 变体体系。

### 4.2 Proma 可借鉴的 3 个小点（均为 opt-in，非重构）

1. **主题清单单一事实源**：Proma 用 `THEME_STYLES` 常量数组，新增皮肤只改一处。你可把 `SKINS` 抽成单一常量并让 CSS/UI 都从它派生（现状已接近）。
2. **每皮肤一个 class 整块覆写 token**：Proma 用 `.theme-ocean-dark { --background: ... }` 整块覆盖；你现在是 `data-skin` 选择器，思路一致，可考虑改用 class 以便与第三方组件库（Tailwind 变体）更好协同。
3. **幂等应用 + 防合成层闪烁**：Proma 的 `applyThemeToDOM` 在状态一致时直接 return，避免重排闪烁。可对照检查你的切换路径是否也幂等。

> 结论：**不做"重构"**；如要推进，只做上述小改，且走独立开关、默认关。

---

## 5. 兼容性与回滚

| 变更 | 影响面 | 回滚 |
|---|---|---|
| fork 同步配置（cache 目录） | 0（不在 open plan 项目内） | 删除该目录即可 |
| 本说明文档 | 仅新增 1 个 .md | 删除文件 |
| open plan 代码 | **零改动** | 不适用 |

- 未改动 open plan 的**任何**源码、路由、依赖版本，故不存在兼容性回归。
- 服务当前仍运行在 `http://127.0.0.1:3002`（版本 0.11.55），行为与改动前一致。

---

## 6. 后续升级维护方案

1. **同步节奏**：上游 Proma 发布新版本时，在 fork 的 `open-plan` 分支执行 §1.2 的 fetch/merge；冲突按 §1.3 的"只加不改"原则几乎不会发生。
2. **对齐方式**：一切"Proma 风格对齐"都以 **opt-in 增量 + 独立开关 + 默认关** 落地，核心代码逐字保留，随时可回滚（与项目既有铁律一致）。
3. **许可红线**：Proma 为 AGPL-3.0。任何"照抄代码/文案"都会把 open plan 拖入 AGPL 义务；只允许"对齐能力与交互语义 + 自研实现"。
4. **建议的下一步（待你确认）**：
   - provider：加"统一连接测试层"（opt-in）。
   - 子 agent：加"委派幂等缓存 + 阻塞事件冒泡 + 显式收敛语义"（opt-in）。
   - 皮肤：抽 `SKINS` 单一源 + 校验切换幂等（opt-in）。
