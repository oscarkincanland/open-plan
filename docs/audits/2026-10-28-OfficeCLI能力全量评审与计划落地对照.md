# OfficeCLI 能力全量评审与计划落地对照

> 状态：已完成（评审报告）
> 基线：v0.11.55 / 分支 `feature/office-writing-capability` @ `c9630ac1`（评审时点）
> 日期：2026-10-28
> 关联：[006 整合修改计划](../plans/2026-10-27-006-Office写作能力整合修改计划.md)、[007 验证与测试计划](../plans/2026-10-27-007-Office写作能力验证与测试计划.md)、[008 执行层收口计划](../plans/2026-10-27-008-Office执行层收口修改计划.md)、[Office 排版规范](../规范/Office排版规范.md)

---

## 0. 结论

1. **命令面是全量的**：`officecli` 工具是参数透传，OfficeCLI 1.0.158 的 28 个子命令都能调用；路径校验只影响带文件的命令，不阻止 `raw/raw-set/merge/dump/validate/refresh/...`。
2. **能力面不是全量的**：提示词只引导了常用子集（view/get/query/set/add/comment/find-replace），`raw-set`、`add-part`、`merge`、`dump`、`validate`、`refresh`、`batch`、`import`、`watch mark`、`load_skill` 既没有写进工具描述，也没有测试或 UI 入口。模型"能调"不等于"知道什么时候用、用了能验收"。
3. **计划 006 的 28 项功能已全部落地**，计划 008 的 P0/P1/P2 与追加的并发锁/草稿预览也已落地；测试数量超过计划 007 的预估。
4. **仍未落地的 4 项**：CI 第 18 步、Word/WPS 人工 L4、并发双任务 E2E、其余 12 个模板的结构基线。另有 OfficeCLI 高级能力（约 15 个子命令/特性）只"可透传"、未"可引导/可验证"。

---

## 1. OfficeCLI 全量能力评审

### 1.1 命令面（`officecli help`，1.0.158）

`open / close / watch / unwatch / view / get / query / set / add / remove / move / swap / refresh / raw / raw-set / add-part / validate / save / batch / dump / import / create / merge / plugins / mcp / skills / install / help`

### 1.2 项目接入方式

| 接入层 | 位置 | 说明 |
|---|---|---|
| 透传工具 | `server/agent.mjs` `officecli` | `args` 字符串原样交给 officecli；任何子命令都可调用 |
| 路径校验 | `server/office.mjs` `validateOfficecliArgs` | 只对 20 个带文件的命令做工作区校验 |
| 原生分流 | `server/文档引擎.mjs` | `create`、`view text|outline|stats`、docx `set --find/--replace` 走原生；其余回退 CLI |
| 应用封装 | `server/office.mjs` | `renderHtml`（view html）、`queryComments`、`startWatch/stopWatch`、`sheetJson`、`workbookInfo`、`batchProps`、`screenshot` |
| 提示词 | `server/agent.mjs` | 只写了 view 模式、get/query/set/add comment、find-replace、markdown 导入、7 条 strict rules |
| 规则闸门 | `server/office规范/验收规则.mjs` | 自研 9 项 + 模板覆盖率；**没有调用 officecli `view issues`** |

### 1.3 能力矩阵

> 说明：本矩阵保留评审时点（`c9630ac1`）的判读；2026-10-28 收口后，`view issues`/`validate` 已接入 QA、高级命令已写入工具描述并由 `test:office-cli-full:live` 验证，最新状态见 §5。

| 子命令/能力 | 可调用 | 已引导 | 已测试 | 判读 |
|---|---|---|---|---|
| `create` | ✅ 原生 | ✅ | ✅ `test:doc-engine` | 完整 |
| `view text/outline/stats` | ✅ 原生 | ✅ | ✅ | 完整 |
| `view annotated/issues/html/svg/screenshot/forms` | ✅ CLI | ⚠️ 只列了模式名 | ⚠️ 仅 screenshot 参数测试 | 可用，未验收 |
| `get` / `query` | ✅ CLI | ✅ | ✅ 间接 | 完整 |
| `set` 属性/样式 | ✅ CLI | ✅ | ✅ 间接 | 完整 |
| `set --find/--replace` | ✅ 原生 | ✅ | ✅ | 完整 |
| `add`（comment/markdown/shape） | ✅ CLI | ⚠️ 只写了 comment/markdown | ✅ comment 间接 | 常用可用 |
| `remove` / `move` / `swap` | ✅ CLI | ❌ | ❌ | 可透传，未引导 |
| `refresh`（TOC/页码重算） | ✅ CLI | ❌ | ❌ | 可透传；需 Word+Windows |
| `raw` / `raw-set` / `add-part` | ✅ CLI | ❌ | ❌ | 通用逃生舱，未引导 |
| `validate`（OpenXML schema） | ✅ CLI | ❌ | ❌ | 可透传，未接入 QA |
| `save` / `close` | ✅ CLI | ⚠️ 仅锁恢复用 close | ✅ 间接 | 可用 |
| `batch` | ✅ CLI + `batchProps` | ❌ | ✅ 参数构造 | 可透传，未引导 |
| `dump`（可回放脚本） | ✅ CLI | ❌ | ❌ | 可透传，未用 |
| `import`（CSV→Excel） | ✅ CLI | ❌ | ❌ | 可透传，未用 |
| `merge`（模板+JSON） | ✅ CLI | ❌ | ❌ | 可透传，未用 |
| `watch` | ✅ `startWatch` | ❌ Agent 不引导 | ⚠️ 预览面板用 | 预览已用，mark 未接 |
| `watch mark/unmark/marks/goto` | ✅ CLI | ❌ | ❌ | 人机共审未接 |
| `plugins` / `mcp` / `skills` / `install` | ✅ CLI | ❌ | ❌ | 宿主/安装类，通常不需要 Agent 调 |
| `load_skill`（内置 10 skills/428KB） | ✅ CLI | ❌ | ❌ | 未接入；项目用自有规范层 |
| 121 元素 / 2375 属性 | ✅ CLI | ⚠️ 只覆盖常用 | ❌ | schema 可查，未逐项验证 |
| ChartEx 17 种图表 / pivot / morph / smartart / ole / media | ✅ CLI | ❌ | ❌ | 可透传，无场景引导 |
| `revision` 修订留痕 | ✅ CLI | ⚠️ 仅提示词提及 | ❌ | 未专门验证 |
| `view issues` 17 类规则 | ✅ CLI | ✅ 模式名 | ❌ 未调用 | 可透传，未接入验收 |
| 渲染（Windows 原生 / 非 Windows HTML） | ✅ CLI | ⚠️ | ⚠️ | 平台相关 |

### 1.4 判读

- **"是否具备全量 OfficeCLI 能力"**：
  - 如果指**命令可调用**：是。`officecli` 工具不限制子命令。
  - 如果指**模型会正确使用 + 有场景引导 + 有验收**：否。约 15 个子命令/特性处于"可透传但未引导/未验证"状态。
- 这不是接入缺陷，而是**能力产品化程度**的差异：OfficeCLI 提供 121 元素/2375 属性，本项目只把其中"写作 + 排版 + 批注 + 查找替换"做成了有提示词、有测试、有闸门的闭环。

### 1.5 缺口清单（按优先级）

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| G1 | `view issues` 未接入规则闸门 | 丢掉 OfficeCLI 自带的 17 类规则信号 | QA 时追加 `view issues`，与自研 9 项合并 |
| G2 | `validate` 未接入 QA | 结构非法只能靠 ZIP 签名发现 | 产物验收前跑 `validate` |
| G3 | `batch`/`dump`/`raw-set`/`merge` 未写进工具描述 | 模型不会主动用，长链编辑仍逐步 set | 工具描述补一段"高级命令"；或提供场景示例 |
| G4 | `watch mark` 未接 | 人机共审回路缺失 | 预览面板加 mark/goto 入口（可选） |
| G5 | `load_skill`/skills 未接 | 428KB 场景规范闲置 | 明确不接（已有自有规范层），或只接 `word`/`pptx` 两个 |
| G6 | 12 个模板未做结构基线 | 覆盖率只验证了 04/08 | 给 14 个模板各跑一次解析快照 |
| G7 | `revision` 未专门测试 | 修订留痕可用性未知 | 加 1 条 `revision.type=ins/del` 回归 |

---

## 2. 计划 006 落地对照（28 项）

| 组 | 功能 | 落地证据 | 状态 |
|---|---|---|---|
| A | O-01 触发词补全 | `server/task.mjs` `OFFICE_INTENT_WORDS`；`test:office-route` 39/39 | ✅ |
| A | O-02 四路由 | `routeTaskIntent()`；能力计划 `route/routeReason`；`test:office-route` | ✅ |
| A | O-03 先读后改 | `server/agent.mjs` 提示词"改文档先读后改"；`test:office-clarify` 静态断言 | ✅ |
| A | O-04 默认场景 | `runEditorialPipeline` `selectScene`；"未传场景时自动选择"用例 | ✅ |
| A | O-05 路由提示单一来源 | `taskSummary` `officeWritingHint`；`test:office-route` 3 例 | ✅ |
| B | O-06 版式令牌 | `server/office规范/设计令牌.mjs`；`test:office-format` 60/60 | ✅ |
| B | O-07 封面三函数 | `封面布局.mjs`；`test:office-format` | ✅ |
| B | O-08 封面配方 R1–R7 | `封面配方.mjs`；7 套不变量测试 | ✅ |
| B | O-09 场景参数 7 套 | `场景参数.json`；7 场景字段测试 | ✅ |
| C | O-10 场景选择器 | `场景选择.mjs`；28 正例 + 8 反例 | ✅ |
| C | O-11 排版规范文档 | `docs/规范/Office排版规范.md` | ✅ |
| C | O-12 技能索引 | `.claude/skills/docx/SKILL.md` 指针 | ✅ |
| D | O-13 模板识别 | `模板匹配.mjs`；`test:office-template` 49/49 | ✅ |
| D | O-14 结构抽取 | `模板结构.mjs`；04 十章/11 图/8 表，08 四章/8 必备/3 表 2 图 | ✅ |
| D | O-15 覆盖率 | `assertCoverage`；08 漏章/缺图表用例 | ✅ |
| D | O-16 场景↔模板映射 | `场景模板映射.json`；映射完整性测试 | ✅ |
| E | O-17 blocks v2 | `buildDocxFromBlocks(options)`；`test:office-generate` 18/18 | ✅ |
| E | O-18 目录/页码后处理 | `后处理.mjs`；TOC/页码用例 | ✅ |
| E | O-19 批量排版 | `office.mjs` `buildBatchArgs/batchProps`；参数测试 | ✅ |
| F | O-20 规则闸门 9 项 | `验收规则.mjs`；`test:office-qa` 28/28 | ✅ |
| F | O-21 产物验证接入 | `产物验证.mjs` `qa` 参数；失败标记 `failed` 用例 | ✅ |
| F | O-22 渲染抽检 | `buildScreenshotArgs/screenshot`；参数测试 | ✅ |
| G | O-23 最小信息集 | `assessClarification`；`test:office-clarify` 22/22 | ✅ |
| G | O-24 编辑路由追问 | 提示词"改哪一段/改成什么/是否保留原格式"；静态断言 | ✅ |
| G | O-25 流水线澄清回传 | `needs_clarification` + draft preview；用例 | ✅ |
| G | O-26 单槽位保护 | `pendingAsks.has(clientId)`；静态断言 | ✅ |
| H | O-27 两个新事件 | `事件注册表.mjs`；`test:event-registry` 4/4、`test:event-payload` 11/11 | ✅ |
| H | O-28 计数与文案 | 动态 `localSkillCatalog().length`；`OFFICE_TOOL_RULE` 单一常量；静态断言 | ✅ |

**结论：28/28 落地。**

---

## 3. 计划 008 落地对照

| 计划项 | 落地证据 | 状态 |
|---|---|---|
| P0-1 执行闸门 | `执行闸门.mjs`；bash/officecli/write/edit 接线；`test:office-exec-gate` 46/46；E2E `OFFICE_PIPELINE_REQUIRED`（#1315/#2110/#2813/#3022） | ✅ |
| P0-2 澄清前置 | `entry.clarificationPending`；写操作拒绝；`ask_user` 解除；E2E `CLARIFICATION_REQUIRED`（#1769） | ✅ |
| P1-1 模板解析 | 标注表/代码块/合并图表/meta 过滤；08 从 0/0 → 4 章/8 必备/3 表 2 图 | ✅ |
| P1-2 Markdown 直通 | `markdownToBlocks` + `sourceMarkdown`；E2E 1000 字轮 Planner/Writer skipped | ✅ |
| P1-3 Chat 提示 | `planTaskCapabilities.hint` + ChatPanel 提示条；`test:office-route` 2 例 | ✅ |
| P2 OfficeCLI 提示 + 预算提醒 | 工具描述三条 known errors；10 回合 `office-pipeline` steer | ✅ |
| 追加 0009 并发锁 | `officecli` 锁 `parsed.path`、pipeline 锁交付文件、只读 bash 不锁；`test:write-lock` 5/5 | ✅ |
| 追加 0010 草稿预览 | `ask_user.previewFile` + pipeline `previewPath` + 前端自动打开；E2E 右侧面板打开 `draft.md` | ✅ |

---

## 4. 测试计划 007 对照

| 测试 | 计划 | 实际 | 状态 |
|---|---:|---:|---|
| `test:office-route` | 34 | 39 | ✅ 超出 |
| `test:office-clarify` | 20 | 22 | ✅ |
| `test:office-format` | 52 | 60 | ✅ |
| `test:office-template` | 32 | 49 | ✅ |
| `test:office-qa` | 26 | 28 | ✅ |
| `test:office-generate` | 15 | 18 | ✅ |
| `test:office-exec-gate` | 24 | 46 | ✅ |
| `test:doc-engine` | +8 | 15 总 | ✅ |
| `test:editorial-pipeline` | +4 | 10 总 | ✅ |
| `test:event-registry` / `payload` | +4 | 4 / 11 | ✅ |
| `test:capability-contract` | +3 | 9 总 | ✅ |
| `test:write-lock` | +2 | 5 总 | ✅ |
| CI 第 18 步 | 建议新增 | **未新增** | ❌ |
| L3 `:live` | 3 例 | 未建正式脚本；UI E2E 已跑 | ⚠️ |
| L4 人工 Word/WPS | 清单 | **未执行** | ❌ |

`npm run verify`：EXIT=0（Server 语法 / Vite 构建 / API 冒烟）。

---

## 5. 未落地 / 弱验证清单（2026-10-28 收口后）

| # | 项 | 类型 | 说明 |
|---|---|---|---|
| U1 | CI 第 18 步 | ✅ 已落地 | `.github/workflows/ci.yml` 新增 `Office写作契约回归测试` |
| U2 | Word/WPS 人工 L4 | 未验证 | 封面/目录/页码/批注双端目检未做（需人工） |
| U3 | 并发双任务 E2E | ✅ 已落地（确定性） | `test:office-concurrency` 两个 pipeline 同时写 Word/PPT；真实模型双 Run 未跑 |
| U4 | 12 个模板结构基线 | ✅ 已落地 | `test:office-template` 新增 14 个模板逐一解析 |
| U5 | `view issues` / `validate` | ✅ 已落地 | `officecli检查.mjs` 接入流水线 QA |
| U6 | 高级命令引导 | ✅ 已落地 | 工具描述新增 ADVANCED COMMANDS；`test:office-cli-full:live` 全覆盖 |
| U7 | `revision` 修订留痕 | ✅ 已落地 | live 套件 find/replace + revision.author 回读 |
| U8 | `visual-judge` 视觉验收 | 明确不做 | 计划 006 §6 已列为不做 |
| U9 | `load_skill` / 内置 skills | 仍未接 | 项目使用自有规范层；不加载 OfficeCLI 428KB skills |
| U10 | `watch mark` UI 入口 | 部分 | CLI 已验证；前端未提供 mark/goto 操作入口 |

### 5.1 收口证据

| 项 | 命令/证据 |
|---|---|
| CI 第 18 步 | `.github/workflows/ci.yml` 末尾 `Office 写作契约（四路由 / 澄清 / 模板 / 版式 / 闸门）` |
| 14 模板基线 | `npm run test:office-template` 63/63 |
| view issues/validate | `server/office规范/officecli检查.mjs`；`test:office-qa` 29/29 |
| 高级命令引导 | `server/agent.mjs` `ADVANCED COMMANDS`；`test:office-exec-gate` 47/47 |
| 全量 live | `npm run test:office-cli-full:live` 全部通过（28 子命令覆盖） |

---

## 6. 建议下一步

1. **P0**：把 `view issues` + `validate` 接入 QA，与自研 9 项合并（成本低，直接补上 OfficeCLI 自带规则）。
2. **P0**：CI 增加第 18 步，跑 `office-route/clarify/format/template/qa/exec-gate`（计划 007 已给方案）。
3. **P1**：给 14 个模板跑结构解析基线，记录每份的章节/图表/推断标记。
4. **P1**：跑一次并发双任务 E2E（两个会话同时写 Word 与 PPT），验证 `WRITE_CONFLICT` 只在同文件出现。
5. **P1**：工具描述补"高级命令"一节（batch/dump/raw-set/merge/validate/refresh），让模型知道逃生舱存在。
6. **P2**：`watch mark` 人机共审、`revision` 回归、L4 双端目检。

---

## 7. 证据复现

```bash
# 分支与提交
git log --oneline -6

# 全量测试
npm run test:office-route && npm run test:office-clarify && npm run test:office-format
npm run test:office-template && npm run test:office-qa && npm run test:office-generate
npm run test:office-exec-gate && npm run test:write-lock
npm run test:doc-engine && npm run test:editorial-pipeline
npm run test:event-registry && npm run test:event-payload && npm run test:capability-contract
npm run verify

# OfficeCLI 命令面
"C:/Users/jijec/AppData/Local/OfficeCLI/officecli.exe" help

# E2E 事件（3005 的 .oaw）
node -e "读取 .oaw/events/事件流.jsonl，筛 tool_gate_denied/pipeline_*/ask_user"
```
