# Skills 发现与依赖卡死审查（2026-11-07）

> 状态：审查结论（只读调查，未修改任何产品代码/测试/其它文档）
> 日期：2026-11-07　基线：`main @ 6ac8dc58`（工作区有未提交的会话流/地图改动，与本审查无关）
> 运行实例：`127.0.0.1:3002`，v0.13.24（`/api/status`），`skillInjection=false`、`contextSections=false`
> 审查对象：Open Plan 的 Skills 发现、选择、注入、读取与依赖执行链路；重点解释“多个会话卡在下载依赖”“PPT master 技能多次调用不成功”
> 关联：上一轮 `docs/audits/2026-10-31-Skills自主发现与调用审查/审查报告.md`；PRD R6（`REQUIREMENTS.md:168-186`，2026-11-04 已更新）；DESIGN `DESIGN.md:310`；AGENTS §5/§7
> 方法：静态读码 + `/api/skills`、`/api/projects`、`/api/status` 只读 GET + 会话流水/Run/Job 运行记录统计 + 纯函数复刻实验（Node 导入产品模块，只读）+ 环境只读探测。**没有**触发真实 Agent 运行，**没有**执行任何 pip/npm 安装。

---

## 0. 结论先行

### 0.1 一句话结论

**“PPT master 调用不成功”不是模型不会用技能，而是发现（描述坏/中文搜索 0 命中）→ 读取（16k 字符截断，正好切掉核心执行步骤）→ 运行时（本机无 Python 3.10）→ 依赖（pip SSL/直连失败 + 120s 后台化坏结果）→ 闸门（写作路由禁止 python 脚本）五层缺口叠加的结果；其中“依赖下载卡死”的直接放大器是 bash 120s 后台化路径返回坏 payload，而不是 pip 本身慢。**

### 0.2 交付要点（4 条）

1. **上一轮 S-01～S-08 复核**：3 条已修/部分已修（目录注入、`@技能`解析、频次排序），4 条仍存在（搜索算法、frontmatter 解析、可观测性、测试覆盖），另发现 8 条新问题（见 §2）。
2. **依赖卡死量化**：14 个会话出现 72 次安装类命令（其中 12 次 ≥30s、8 次 ≥60s、4 次 ≥120s）；17 个 Run 含安装命令、合计 1352s；最重的 `run_dea3fb50` 单 Run 1471s 中 1015s（69%）耗在装依赖；4 次 pip 触发 120s 后台化并返回破坏性错误（累计 480s 白等），另有约 387s 花在 `sleep+tail` 轮询等待。
3. **PPT master 三次真实尝试**：两次被“写作路由闸门”或“只确认不生成”拦下，一次（2026-11-07）补齐 Python 3.12 + 13/15 依赖后才跑通技能脚本并导出 1 页测试 PPTX——但用户要的正式汇报版并未由该技能产出。
4. **规则建议一句话**：把“发现/选择”做成服务端确定性前置（触发矩阵 + 来源优先级 + 依赖预检 + top-N 回退），把“装依赖”降级为用户显式同意的一次性动作，并在写作闸门上为声明式技能开受控执行通道；同时补齐 `skill_search/selected/read/preflight` 事件。

### 0.3 已验证 / 推断 / 未验证

- **已验证**：所有代码行号与运行记录数字；`/api/skills`、`/api/projects`、`/api/status` 返回；目录注入/搜索/截断/闸门判定的复刻结果；环境探测（无 python、QGIS 3.9.5、pip SSL 失败、无 `.venv`）。
- **推断**：修复后行为、各规则的收益量级；`.agents/skills` 占位链接的预期用途。
- **未验证**：未在真实 Run 中验证任何修复；未执行 pip/npm；未读取用户文档内容；未确认 2026-11-04 前后技能目录变更的完整 diff 意图。

---

## 1. 审查范围、证据来源与限制

### 1.1 代码与文档

| 链路 | 文件（本次实读） |
|---|---|
| 技能目录扫描/缓存 | `server/技能目录.mjs`、`server/资源发现.mjs` |
| 目录注入与预算 | `server/Skill注入.mjs`、`server/上下文段落.mjs` |
| 系统提示词与工具 | `server/agent.mjs`（460/478、522-530、1383-1390、1428、2856-2906、5884-5896、1906/1924、1502-1513、1805） |
| 路由/能力计划 | `server/task.mjs`（22/347-351/447-449/477-478）、`server/任务复杂度.mjs`（37-45） |
| 引用解析/Admission | `server/context.mjs`（90-93、204）、`server/index.mjs`（2760-2820、4880-4939） |
| 运行开关 | `server/运行开关.mjs`（72、223-225、261-271） |
| 后台任务 | `server/后台任务.mjs`（19-22）、`.oaw/jobs/**` |
| 写作闸门 | `server/office规范/执行闸门.mjs`（9-10、157-169、206-212、274-285） |
| 前端入口 | `client/src/components/ChatPanel.jsx`（1247-1264、1802、3960-3980）、`SkillsManager.jsx`、`SettingsPanel.jsx`（248-262）、`AgentMarket.jsx` |
| 事件/测试 | `server/事件注册表.mjs`（225-227）、`scripts/Skill注入契约测试.mjs` |
| 技能包 | `.claude/skills/ultimate-ppt-master-skill/{SKILL.md,INSTALL.md,requirements.txt}`、`.claude/skills/pptx/SKILL.md`、用户级 `powerpoint` 技能 |

### 1.2 运行记录（只读统计）

- `.规聚会话/*.jsonl`：146 个会话文件（含 8.4MB 大文件），流式解析 toolCall/toolResult。
- `.oaw/runs/*.json`：380 个 Run，含 `capabilityPlan`、`events`（tool_start/tool_end）、`finalText`。
- `.oaw/jobs/**`：925 个后台 Job（826 completed / 78 failed / 2 killed / 8 cancelled / 5 running / 6 interrupted），含命令、起止时间、退出码、日志。
- `.oaw/pending-asks.json`：93 条 ask_user 记录（75 answered / 16 expired / 2 pending）。
- `%APPDATA%\规聚\集成\skill-usage.json`：真实 `skills_read` 计数（当前总计 5 次）。

### 1.3 限制

- 严格只读：未调用 `POST /api/agent/prompt`、`/api/agent/answer` 等会触发真实运行/写用户数据的接口；仅用 GET 与 Node 纯函数导入。
- 未执行 pip/npm 安装实验；依赖结论来自已有 Job 日志、Run 输出与环境只读探测。
- 会话证据只给统计与脱敏片段；用户工作区路径在正文中统一写为 `D:/<用户工作区>`。
- 未修改产品代码/测试/其它文档；临时脚本只写入 `%TEMP%`。

---

## 2. 上一轮（2026-10-31）结论逐条复核

> 判定口径：**已修**＝代码/行为已解决且可验证；**部分已修**＝主路径已改但仍有缺口；**仍存在**＝与上轮一致；**新发现**＝本轮新增。

| 编号 | 上轮结论 | 本轮状态 | 现状与证据 |
|---|---|---|---|
| S-01 | `noSkills:true` + 不注入技能清单，模型不知道 65 个 Skill | **部分已修** | `noSkills:true` 仍在（`server/agent.mjs:1383-1390`），但 2026-11-04 起改为**每轮注入目录**（`agent.mjs:5884-5896` → `Skill注入.mjs:49-95`）；实测 23/146 个会话的 prompt 出现 `<available_skills>`（累计 70 条，目录段约 7394 字符）。缺口：8KB 预算整条丢弃 11/66；10 个描述仍是 `>`/`\|`（见 S-06）。 |
| S-02 | 提示词没有“先搜索再执行”的强制/建议规则 | **部分已修** | 目录 footer 已写规则（`Skill注入.mjs:70-71`）：“用户点名或任务明显匹配某条 description 时先 `skills_read`；目录截断/不确定时先用 `skills_search`”；系统提示同步（`agent.mjs:1428`）。缺口：没有“何时必须搜/何时不要搜”的判定矩阵与次数上限；模型仍可完全不搜。 |
| S-03 | `@技能` 与服务端 `#技能` 不一致、task payload 不带 skills | **部分已修** | 解析器已统一：`/[@#]技能\[([^\]]+)\]/g`（`server/context.mjs:90-93`）；admission 从文本抽取 `mentionedSkills` 并并入 `requestedSkills`（`server/index.mjs:4880-4885`），预检不通过会阻断（`index.mjs:4936`）。缺口：前端 payload 仍无结构化 `skills`（`ChatPanel.jsx:1802` 仍是拼 `@技能[...]` 文本；`send` 载荷无 skills 字段）；`#` 菜单只读 `project.settings.skills`（`ChatPanel.jsx:1250`），而 7/7 项目该值均为 `[]`（`/api/projects`），因此用户从输入框 `#` 根本看不到已装技能；技能广场“调用”仍靠文本草稿（`SkillsManager.jsx:326`）。 |
| S-04 | `skills_read` 只读说明、不注入；`skillInjection` 默认关；无权威事件 | **仍存在（关键）** | `/api/status` 显示 `skillInjection=false`（`运行开关.mjs:223`，默认关、需 `harnessAlign`）；flag 关时 `skills_read` 走 `limitToolText(raw)`＝**16000 字符**截断（`agent.mjs:460/478/2905`），不写 `skill_injected` 事件；`事件注册表.mjs` 只有 `skill_injected`（225），没有 search/read/selected/preflight 事件。 |
| S-05 | 搜索是空格 AND 词面匹配；无同义词/中文/排序 | **仍存在** | `searchLocalSkills` 一字未改（`agent.mjs:522-530`）；复刻实测：`PPT 演示`、`生成PPT`、`制作演示文稿`、`幻灯片`、`汇报PPT`、`ECharts 柱状图`、`文档审查`、`设计评审`、`数据分析`、`飞书` 等 17 个自然语言查询 **0 命中**；只有单词式 `PPT`/`pptx`/`ppt master` 命中（见 §4.2）。 |
| S-06 | frontmatter 不支持 `>`/`\|` block scalar，10/65 简介为空 | **仍存在** | `parseFrontmatter` 仍是单行正则（`技能目录.mjs:20-35`），`description: >` 只取到 `>`；`/api/skills` 与目录注入里 10 个技能描述为 `>`/`\|`/`>-`：`axi-front-design, codex, debugging-agent, design-review, humanizer, llm-wiki, prompt-optimizer, qa, review, ultimate-ppt-master`。目录注入真实行：``- `ultimate-ppt-master` [project]：>``。 |
| S-07 | 无自动发现测试；Skill 注入契约测试只测格式化 | **部分已修** | `scripts/Skill注入契约测试.mjs` 已覆盖注入格式/20KB 预算/哈希/截断/频次排序/目录排序（23-103 行），但仍无“搜索命中（中文）/block scalar 解析/截断是否切步骤/依赖预检/自动发现行为”的测试。 |
| S-08 | 项目默认 `skills:[]`、Agent skills 只作为 @mention 文本 | **仍存在** | `/api/projects` 7 个项目 `settings.skills` 全为 `[]`、`skillsPolicy` 全为 `auto`；`@智能体` 仍把 skills 拼成 `@技能[...]` 文本（`ChatPanel.jsx:3960-3980`、`AgentMarket.jsx:79`）。 |

### 2.1 本轮新发现

| 编号 | 新问题 | 严重度 | 证据 |
|---|---|---|---|
| N-01 | **写作路由闸门与技能脚本执行冲突**：`template/generate` 路由下，任何 `python X.py` / `node X.mjs` 都被判为“生成 Office 文档”而硬拦截，技能脚本（PPT master 全部是 `.py`）无法执行；同一技能在 `read` 路由下却能执行 | **P0** | `执行闸门.mjs:157-169`（`DOCX_GENERATION` 第 2/3 条直接匹配 `python *.py`、`node *.mjs`）、`274-285`；复刻判定：`python tools/analyze_data.py`、`node scripts/build-vector-tiles.mjs` 均 `blocked=true`；Run 对照见 §4.1。 |
| N-02 | **bash 120s 后台化返回坏 payload**：超时后走 `options?.onData?.(字符串)`，Pi 流写入期望 Buffer，抛 `The "input" argument must be an instance of ArrayBuffer or ArrayBufferView...`；模型拿不到 `jobId`，只能重复执行 | **P0** | `agent.mjs:1906`（字符串 onData）/`1924`（返回裸 `{exitCode:0}`）；`后台任务.mjs:19-22`（阈值 120000ms）；运行记录 8 次坏 payload/5 个 Run（`run_dea3fb50` 4 次），925 个 Job 中仅 3 次 `tool_backgrounded` 事件且全部来自 officecli 路径。 |
| N-03 | 目录 8KB 预算按 scope 排序，用户级技能被整条丢弃（含 `powerpoint`，即最贴近 .pptx 的英文技能） | P1 | 复刻 `buildSkillCatalog`：66 个中注入 55 个、丢弃 11 个：`hook-development, human-masked-content-creator, p5js, planning-with-files, powerpoint, prompt-optimizer, qa, research-paper-writing, reverse-engineer-anything, review, ugreen-nas-connect`；`Skill注入.mjs:78-92` 丢弃而非只截描述。 |
| N-04 | 技能标识三套名字并存：目录名 `ultimate-ppt-master-skill`、frontmatter `name: ultimate-ppt-master`、用户口语 “PPT master”；`skills_read` 必须用清单里的 `name` 精确匹配，用目录名会 404 | P2 | `技能目录.mjs:94-95`（frontmatter.name 覆盖目录名）、`agent.mjs:2883`（`item.name === name`）；`skill-usage.json` 同时存在 `ultimate-ppt-master-skill:2` 与 `ultimate-ppt-master:1`，证明历史上两种名字都被读过。 |
| N-05 | `.claude/skills` 下 20 个无扩展名占位文件指向不存在的 `../../.agents/skills/*`，扫描器按 `.md`/`SKILL.md` 过滤后全部不可见 | P3（待确认预期） | `.claude/skills/{baoyu-design,lark-doc,kb-retriever,…}` 为 29-33 字节文本，内容为 `../../.agents/skills/xxx`；仓库无 `.agents` 目录；`技能目录.mjs:51` 只收 `.md`。 |
| N-06 | `ask_user` 当前默认阻塞 **30 分钟**（`OAW_ASK_TIMEOUT_MS`），超时才自动继续；PPT/汇报类任务多次停在此处 | P1 | `agent.mjs:667-668`、`3987`；历史提交 `402f7d92`（2026-11-04 “ask_user 30 分钟超时与跳过继续”）；`.oaw/pending-asks.json` 93 条中 16 条 `expired`（用户未答、按超时继续）。 |
| N-07 | 技能依赖完全无声明、无预检：SKILL.md 只有人读的 `requirements.txt`/venv 说明，产品侧没有 `requires` 字段与可用性检查，模型只能“自由发挥”安装 | P1 | `ultimate-ppt-master-skill/SKILL.md:77-103`、`INSTALL.md:93-100`、`requirements.txt`（15 项）；`技能目录.mjs:97-105` 只存 name/description/path/source，无依赖字段。 |
| N-08 | 环境事实导致“装依赖”必然踩坑：系统无 Python，只有 QGIS 3.9.5；pip SSL 不可用，PyPI 直连失败；未配置代理/镜像 | P1（环境类） | 见 §5.1 探测结果与 Run 日志。 |

---

## 3. 当前 Skills 链路（2026-11-04 改造后）

### 3.1 发现：每轮注入目录（已生效），但目录质量与预算有损

- 目录来源：`技能目录.mjs:69-114` + 资源发现 `资源发现.mjs:19-56`，顺序 `workspace > project > user`；只认 `<dir>/SKILL.md` 与 `<name>.md`。
- 当前实例（`/api/skills`，projectDir=仓库、workspace=用户工作区）：**66 个** = `project.claude` 51 + `user.claude` 13 + `user.agents` 2。
- 每轮注入：`agent.mjs:5884-5896`；`skillsPolicy=off` 时不注入；`routing.skills` 为 `preflight/catalog/off`（`任务复杂度.mjs:37-45`）。
- 注入形态（复刻，默认 8KB）：`8179 字节 / 55 条 / truncated=true`；header/footer 含使用规则（`Skill注入.mjs:65-73`）。
- 真实会话验证：23/146 个会话、70 条消息含 `<available_skills>`（首次出现 2026-11-03）；`ultimate-ppt-master` 行确为 ``- `ultimate-ppt-master` [project]：>``。

**问题**：目录是“名称+截断描述”的平铺清单，没有分类、没有“本任务可能相关”的排序（只按 scope/使用频次），模型要在 55 条里靠字符串做判断；描述坏的 10 条等于只有名字。

### 3.2 选择：只有“启发式开关”，没有确定性选择器

- 路由：`planTaskCapabilities` 只要文本命中 `@技能/#技能/工作流/skill/workflow` 就标 `planned`（`task.mjs:347`）；否则 `routing.skills = resolveSkillsRouting(...)`。
- `resolveSkillsRouting`（`任务复杂度.mjs:37-45`）：
  - 显式点名/工作流 → `preflight`
  - `skillsPolicy=off` → `off`
  - 其余 → `catalog`（2026-11-04 起不再按复杂度裁剪）
- **实测语义**（Node 复刻）：`auto` 与 `always` 对简单/复杂任务都返回 `catalog`，二者**完全等价**；只有 `off` 真正改变行为（不注入目录）；显式 `#技能` + `off` 仍返回 `preflight`。
- 设置面板（`SettingsPanel.jsx:248-262`）仍写“自动（简单用默认，复杂才检索）/总是检索/关闭自动检索”，与现行实现不符（陈旧文案）；`DESIGN.md:310` 描述与代码一致（每轮注入），但“自动/总是”的差异未被定义。
- **结论**：DDESIGN/PRD 说的“技能策略开关”只实现了 `off` 一个有效档位；`auto`/`always` 无差别。`/api/status` 的 `skillInjection=false` 是另一个开关（H2-4 注入格式/20KB 预算），与“技能策略”不是同一个东西，不要混淆。

### 3.3 读取：`skills_read` 只返回说明，且默认截断 16000 字符

- 实现：`agent.mjs:2874-2906`；按 `name` 精确匹配目录项；读取全文；`recordSkillUsage(name)` 后返回。
- flag 关（当前）：`# ${name}\n\n${limitToolText(raw)}`；`TOOL_OUTPUT_MAX_CHARS = 16000`，`limitToolText` 取头 72% + 尾 28% + 截断标记（`agent.mjs:460/478-484`）。
- flag 开：`buildSkillInjection` 用 20KB 字节预算（`Skill注入.mjs:8/97-110`），对中文文件实际比 16000 字符更早截断。
- **PPT master 实测**：SKILL.md **26007 字节 / 25213 字符 / 440 行**；`skills_read` 返回 **16043 字符、truncated=true**（3 个 Run 均如此）。头 11520 字符 + 尾 4480 字符，**被切掉的是 Step 2–Step 6**（Project Init / Template / Strategist（MANDATORY）/ Image_Generator / Executor 开头），恰好是“可编辑 PPTX”工作流的核心执行段；可见的尾部只有 Step 7 Export 之后。
- `references/` 12 个文件、`scripts/` 28 个文件不会自动读取；模型要自己 `read`/`ls`（`run_dea3fb50` 的 finalText 说“全文 25213 字符加载成功”，实际来自后续 `read` 工具而不是 `skills_read`）。
- 因此任务书里“skills_read 截断 20KB？”的答案是：**文件 26007 字节；flag 关时按 16000 字符截断（头 72%+尾 28%），flag 开时按 20KB 字节截断；两种都会截掉核心步骤。**

### 3.4 用户入口：`@技能` 已能解析，但“看得到/点得动”仍不完整

- 输入框 `#` 菜单：只列 `project.settings.skills`（`ChatPanel.jsx:1247-1264`）；7/7 项目为空 → 菜单里没有 66 个已装技能。
- 技能广场：`SkillsManager.jsx` 展示 `/api/skills`，但“调用/加入 Agent 任务”只把 `@技能[name]` 文本填进输入框（`SkillsManager.jsx:326`），仍需用户手动发送；`startAgentTask` 同样只拼文本（`ChatPanel.jsx:1802`）。
- `@智能体`：skills 作为 `@技能[...]` 文本注入（`ChatPanel.jsx:3960-3980`）。
- Admission 已能从文本中解析 `@技能/#技能`（`index.mjs:4880`）并预检；预检失败会 409 阻断（`index.mjs:4936`）；Chat 模式不做技能依赖预检（`index.mjs:4890-4892`）。
- **结论**：S-03 的“解析断链”已修；剩下的是“结构化下发”（payload.skills）与“可发现性”（菜单/搜索/推荐）两个体验缺口。

### 3.5 执行：技能=说明，不是运行时

- `skills_read` 只读说明；没有“执行技能”的工具；依赖/脚本由模型自行用 bash 调用。
- 技能 frontmatter 只有 `name/description/metadata`（PPT master 见 `SKILL.md:1-15`），**没有 `requires` 字段**。
- 系统提示没有“不得自动安装依赖”的规则；只有 Office 写作闸门会间接拦截部分脚本（见 N-01）。
- 结果：装依赖变成模型的自由行动，失败后反复重试 → 用户感知“卡在下载依赖”。

---

## 4. PPT master 失败的真实主因链

### 4.1 三次显式尝试的复盘

| # | 时间 | Run / 会话 | 用户原话 | 路由 | 实际发生了什么 | 结果 |
|---|---|---|---|---|---|---|
| 1 | 2026-11-04 04:42Z | `run_cd23bb40-…`（2.3min） | “你现在可以用PPT master这个插件了吗？” | `template`（写作路由，闸门通电） | `skills_search("ppt master 演示文稿")` → **0 命中**；`skills_read("ultimate-ppt-master-skill")` → **16043 字符 truncated**；随后想探测 `.venv`/`python --version` 的 bash 被闸门**拦截**（`OFFICE_PIPELINE_REQUIRED`）；`ask_user` 72s | completed，但 finalText 明说“技能可读可用，但运行环境无法在这轮实测”，**未生成** |
| 2 | 2026-11-04 | `run_56a4d971-…`（6.7min） | “用PPT master这个skills来重新生成一版本” | `template`（闸门通电） | 模型读技能后尝试 bash，被闸门拦截；finalText 明说“这次用的不是 PPT Master 技能本身……写作路由直接禁用了 bash……技能目录下也没有可绕过的内置 `.venv`。我改用 `editorial_pipeline`” | completed，产物 `…汇报PPT_新版.pptx` 来自**编辑流水线**，不是技能 |
| 3 | 2026-11-07 13:12Z（本地 21:12） | `run_dea3fb50-…`（24.5min） | “看看你现在是否可以调用PPT master这个skills呢？” | `read`（闸门不通电） | 技能脚本可执行；但本机无 Python 3.10 → QGIS 3.9.5 pip SSL 失败 → nuget 便携 Python 3.12 → PyPI 直连 SSL 失败 → 4×120s pip 被后台化并返回坏 payload → 改用清华镜像**逐包**安装 → 13/15 依赖 → `project_manager.py init/import-sources/validate` 跑通 → 导出 1 页测试 PPTX | completed；`.pptmaster/…/exports/*.pptx`（34,515 B / 32,984 B）为技能链路真实产物，但**不是**正式汇报版 |

补充：`skill-usage.json` 显示 `ultimate-ppt-master-skill:2 + ultimate-ppt-master:1 = 3` 次真实读取；与“用了好几次”吻合。

### 4.2 六环主因链（每环都有证据）

**环 1：目录描述损坏 → 模型看不出这个技能适合“做 PPT”**
- `SKILL.md:2-15` 用 `description: >` 多行块；`技能目录.mjs:20-35` 单行解析只得到 `>`。
- 复刻注入行：``- `ultimate-ppt-master` [project]：>``；`/api/skills` 同样返回 `>`（10/66 个技能如此）。
- 影响：模型只能靠名字猜到它是 PPT 技能；按描述匹配的路径完全失效。

**环 2：中文搜索 0 命中 → 想主动找也找不到**
- `searchLocalSkills` = 空格切词 + 每词都必须在 `name+description` 中出现（AND 词面）。
- 实测复刻：`PPT 演示`、`生成PPT`、`做一个PPT`、`制作演示文稿`、`幻灯片`、`汇报PPT`、`终极融合PPT大师` 全部 **0 命中**；`ppt master` 才 1 命中。
- 真实 Run：`run_cd23bb40` 搜“ppt master 演示文稿” → `未找到匹配的 Skill。`。
- 影响：即使用户点名“PPT master”，只要模型顺手把中文用途词拼进 query，就会被判“无此技能”。

**环 3：读取截断 → 拿到一半说明书，正好缺执行步骤**
- `skills_read` 16043/25213 字符（见 §3.3）；被切掉的是 Step 2–6（含 MANDATORY 的 Strategist 与 Executor）。
- 影响：模型照着可见的“Mode 1 前 3 步 + Mode 2 Web 工作流”行事，容易半途而废或自行发挥；`run_dea3fb50` 是靠额外 `read` 全文才继续的（finalText 声称“全文加载成功”，非 `skills_read` 功劳）。

**环 4：运行时缺失 → 技能硬性要求 Python 3.10+，本机没有**
- `SKILL.md:77-83`：“Prefer the bundled virtual environment … `${SKILL_DIR}/.venv/bin/python`；否则用 Python 3.10+；Do not run with Python 3.9 or older”；`INSTALL.md:19-25/93-100` 同样给 `python3.10 -m venv .venv` + `.venv/bin/python -m pip install -r requirements.txt`。
- 环境探测：`python/python3/py` 均不在 PATH；`WindowsApps\python.exe`、`python3.exe` 均为 **0 字节** Store 壳；只有 QGIS 3.34.1 自带 **Python 3.9.5**；技能目录**无 `.venv`**。
- Windows 下 venv 实际路径是 `.venv/Scripts/python.exe`，`.venv/bin/python` 是 POSIX 路径 → **如果按技能文档创建 venv 再按文档路径调用，必然失败**（软失败：技能还给了“自备 3.10+”的兜底，因此不是唯一死因，但足以让模型浪费大量时间）。
- `run_6eaf6f3c`（“环境里面为什么没有Python呢？”）独立证实：Store 的 `python.exe` 只是 AppInstaller 跳转壳，注册表无 Python；最终靠 QGIS 3.9.5 + 手动 wheel 绕过。

**环 5：依赖安装卡死 → pip SSL / 直连失败 / 120s 后台化坏结果**
- QGIS 3.9.5 的 pip：`SSLError("Can't connect to HTTPS URL because the SSL module is not available.")`；修 `PYTHONHOME` 后变 `SSLEOFError(EOF occurred in violation of protocol)`。
- 便携 Python 3.12：直连 `pypi.org` 仍 SSL 证书失败；清华镜像可用（日志显示 34.5 MB/s）；一次装 15 包出现 `No matching distribution found`，改成逐包安装成功。
- 4 次 pip 安装各 120s 触发后台化，返回 `The "input" argument must be an instance of ArrayBuffer or ArrayBufferView...`（N-02），模型拿不到 `jobId`，连试 4 次（480s）。
- 另有约 387s 花在 `sleep 45/60/90/100 + tail` 轮询等待日志。
- 该 Run 共 23 次安装类命令、1015s，占 1471s 的 **69%**。

**环 6：写作闸门 → 即使依赖装好，`template/generate` 路由也不许跑技能脚本**
- `执行闸门.mjs:157-169`：`DOCX_GENERATION` 第 2 条 `/\bpython3?\b[^\n]*\b[\w./-]+\.py\b/i`、第 1 条 `node … .mjs` —— 任何 Python/Node 脚本都被视为“绕过管线生成 Office”。
- `274-285`：`template/generate` 路由下 bash 命中即 `OFFICE_PIPELINE_REQUIRED` 硬拦截；`252` 行：`officeFormat` 为 false 时放行（agent.mjs 用 `officeGateActiveFor(route, mode)` 计算，`template/generate` → true）。
- 复刻判定：`python tools/analyze_data.py`、`node scripts/build-vector-tiles.mjs` 均 blocked；`python -m venv`、`pip install` 不拦（因为它们不是 `*.py` 执行）。
- Run 对照：`run_56a4d971` route=`template` → 脚本全拦；`run_dea3fb50` route=`read` → 脚本放行并最终产出 PPTX。**同一个技能能不能跑，取决于任务被路由成什么，而“生成 PPT/汇报”天然落入写作路由。**
- 附带误伤：数据类/工具类 `.py` 脚本（与分析、CAD、格式转换无关 Office）在写作路由下也会被拦，模型只能改用 node -e / 其它路径。

### 4.3 直接回答“为什么好几次调用不成功”

- 第 1 次：用户是在**问能力**，模型只做了“可读性核实”，且被闸门挡住了运行时探测——所以“没看到效果”。
- 第 2 次：用户要**生成**，路由是写作路由，脚本被闸门拦死，模型按提示词回退到 `editorial_pipeline`——PPT 出来了，但**不是技能产的**，用户自然认为“技能没调用成功”。
- 第 3 次：用户问“能不能调用”，路由是 read，脚本能跑；但被 Python/依赖拖了 24.5 分钟，最后只产出一页测试 PPTX，没有正式汇报。
- 因此“调用不成功”是**发现、读取、依赖、闸门四类工程缺口**，不是模型能力问题；`editorial_pipeline`/`officecli` 一直在兜底，掩盖了技能链路的失败。

---

## 5. 依赖下载卡死：量化证据与环境事实

### 5.1 环境事实（只读探测，2026-11-07）

| 项 | 结果 | 证据 |
|---|---|---|
| `python` / `python3` / `py` | 均不在 PATH | `Get-Command` 全部 NOT FOUND |
| Store Python 壳 | `WindowsApps\python.exe`、`python3.exe` 均 **0 字节** | 目录探测；`run_6eaf6f3c` 证实是 AppInstaller 跳转壳 |
| 可用 Python | 仅 QGIS 3.34.1 自带 **3.9.5** | `C:\Program Files\QGIS 3.34.1\apps\Python39\python.exe -c "import sys;print(sys.version)"` → `3.9.5` |
| 技能内置 venv | **不存在** | `.claude/skills/ultimate-ppt-master-skill/.venv` = False；仓库根 `.venv` = False |
| pip 配置/代理 | 无 `pip.ini`；无 `HTTP(S)_PROXY` 环境变量；npm registry 为官方 `registry.npmjs.org` | 环境探测 |
| pip 网络 | QGIS Python：`SSL module is not available`；修 PYTHONHOME 后 `SSLEOFError`；便携 3.12：PyPI 直连 SSL 证书失败；**清华镜像可用**（34.5 MB/s） | Job 日志 `job_648253b3942a`、`job_38294e29b502`、`job_30c76be4932d`、`job_1f36611cbf5e` 等 |
| Node/npm | node 24.15.0 正常；npm 安装偶发 EPERM（升级 pi 时 205s，最终成功） | Job 记录/会话日志 |
| 技能包 git 状态 | `.claude/skills` 全部 **未跟踪**（`.gitignore:155`，`git ls-files .claude` = 0），磁盘仍保留 **13090 个文件** | `.gitignore` + `git ls-files`；`变更日志.md:16`（13,064 文件/约 50MB 改不跟踪） |

### 5.2 统计总表

| 指标 | 数值 | 来源 |
|---|---:|---|
| 含安装类命令的会话 | **14 / 146** | `.规聚会话/*.jsonl` 流式解析 |
| 安装类命令次数（会话） | **72**，其中 ≥30s 12、≥60s 8、≥120s 4 | 同上 |
| 会话内安装耗时最高 | **1079.5s**（会话 `01a1b17a…`，含多个 Run） | 同上 |
| 含安装类命令的 Run | **17 / 380** | `.oaw/runs/*.json` |
| 这些 Run 的安装命令总耗时 | **1352s**（Run 内 bash tool 时长求和） | 同上 |
| 最重单 Run | `run_dea3fb50`：**1015s / 1471s = 69%**，23 次安装类命令 | Run 事件 + Job 记录 |
| 后台 Job 总数 | **925**（826 completed / 78 failed / 2 killed / 8 cancelled / 5 running / 6 interrupted） | `.oaw/jobs/**` |
| 安装类 Job | **56** | 同上 |
| 运行 ≥60s 的 Job | **35** | 同上 |
| 120s 后台化坏 payload | **8 次 / 5 个 Run**（`run_dea3fb50` 4 次） | Run `tool_end` 结果 + `tool_backgrounded` 对照 |
| `sleep+tail` 轮询等待 | **约 387s**（100+91+90+60+45） | Job 日志 |
| ask_user 记录 | **93**：75 answered / **16 expired** / 2 pending | `.oaw/pending-asks.json` |
| “静默 3 分钟”强制收尾 | **12 个 Run**（另有 1 个“静默 64 分钟”） | Run error 文本统计 |

### 5.3 单次最慢命令（安装/依赖相关）

| 耗时 | 命令（脱敏） | 结果 |
|---:|---|---|
| 120.1s | `./python.exe -m pip install --target <工作区>/tools/pylibs312 python-pptx cairosvg …`（×4 次重试） | 坏 payload（ArrayBuffer 错误），无 `jobId` |
| 120.0s | `bash tools/install_pptdeps.sh; tail …` | 同上 |
| 100.4s | `sleep 100; grep … pptmaster_pip.log` | completed（纯等待） |
| 90.9s | `sleep 90; tail …; ls pylibs312 \| grep -c .` | completed（纯等待） |
| 90.2s | `sleep 90; tail …` | completed（纯等待） |
| 60.4s | `sleep 60; ls -la …/pptmaster_pip.log` | completed（纯等待，日志还为空） |
| 55.5s | `pip install … PyMuPDF mammoth markdownify ebooklib nbconvert …`（清华镜像） | completed，exit 0 |
| 49.2s | `pip install … ebooklib nbconvert requests beautifulsoup4 …` | completed，exit 0 |
| 45.3s | `sleep 45; tail …; ls pylibs312` | completed（`No matching distribution found`） |
| 205.1s | `npm install -g @earendil-works/pi-coding-agent`（升级内核） | completed（不是技能依赖，但同属长安装） |
| 55.2s | `npm install pdfjs-dist pdf-lib`（PDF demo） | completed（54s 装完） |
| 8.4s | nuget 下载便携 Python 3.12 | completed |

### 5.4 失败模式归类

| 模式 | 证据 | 影响 |
|---|---|---|
| A. 无 Python/版本不满足 | §5.1；`SKILL.md:77-83` 要求 3.10+ | 整个技能不可执行；模型开始“装 Python”长链 |
| B. pip SSL/证书链 | `job_648253b3942a`（SSL module not available）、`job_30c76be4932d`（SSLEOFError）、`job_38294e29b502` | 直连 PyPI 必败；只能 `--trusted-host` + 镜像 |
| C. 依赖解析失败 | 一次装 15 包 `No matching distribution found`；逐包成功 | 模型必须试错拆分，回合数膨胀 |
| D. 120s 后台化坏结果 | N-02；8 次 | 模型看不到进度、拿不到 jobId、重复执行（+480s） |
| E. 纯轮询等待 | `sleep 45/60/90/100 + tail` | 约 387s 无信息等待；用户端看起来“卡死” |
| F. 写作闸门拦截 | N-01；`run_cd23bb40/run_56a4d971` | 装好也不能按技能跑；最终回退 editorial_pipeline |
| G. ask_user 阻塞 | 93 条/16 expired；PPT 类 Run 多次 ask_user | 最长按 30 分钟超时；用户离开即挂起 |
| H. 静默看门狗收尾 | 12 个 Run “静默 3 分钟…按中断收尾” | 长任务被误杀/用户感知“卡住” |

### 5.5 与“好几个会话卡住”的对应

- 直接依赖卡死：`run_dea3fb50`（PPT，69% 时间在装依赖）、`run_6eaf6f3c`（Python 环境，29.6min）、`run_c725a57f`（npm PDF，55s 装包可接受）。
- 因“装依赖/后台长命令”间接卡住：`run_554831ce`（DWG 转换，多个后台 Job 分别 1955s/1622s/1288s，最终静默 64 分钟被收尾）、`run_7cb68351`（查询“为什么运行不下去”，5.4min 静默收尾）。
- 用户明确抱怨“卡住/卡死/卡在/没反应”的会话：**7 个**（含“之前任务卡死了，继续之前的任务”、“为什么卡死了呢…能不能让慢的进程后台运行”）。
- 结论：卡死的**直接来源不是网络慢**，而是（1）缺省环境与技能依赖不匹配、（2）安装命令长于 120s 后进入有缺陷的后台化路径、（3）写作闸门使“装好了也没用”。

---

## 6. 规则设计（交付重点）

> 目标：把“是否找技能、找哪个、能不能用、缺依赖怎么办”从模型自由发挥变成**确定性、可解释、可测试**的产品规则。以下规则均为建议，不在本轮实施。

### 6.1 什么时候找本地 skills：确定性触发矩阵

先定义三个输入：
- `explicit`：用户本轮是否点名技能（`@技能/#技能`、技能广场“调用”、`@智能体` 依赖技能）；
- `match`：任务的 `route/intent` + 关键词是否命中某个技能的 **name/description/别名表**（服务端计算，不依赖模型）；
- `productCapable`：该任务是否已有产品内一等能力（officecli / editorial_pipeline / OOXML 直写 / map_* / kb_* / browser_*）。

| # | 场景 | 条件 | 动作 | 预算 |
|---|---|---|---|---|
| T1 | 用户显式点名 | `explicit=true` | 立即 `preflight`：解析名字→校验存在/可读→读依赖声明；命中则**注入目录摘要 + 前 2KB 摘要 + “必须 skills_read 全文”指令**；缺失则**可解释阻断**（不静默回退） | 必读 1 个 |
| T2 | 任务类型命中且产品无同类能力 | `match.top1.score ≥ 阈值` 且 `productCapable=false` | `skills_read(top1)`；若其 `requires` 预检非 ready → 快速失败并给替代方案 | 1 次 search + 1 次 read |
| T3 | 任务类型命中但产品有同类能力 | `match` 命中且 `productCapable=true` | **不读技能**；在提示词中给“可选技能：X（未使用，原因：已有内置能力）”，由用户显式点名才升级到 T1 | 0 |
| T4 | 无命中 | `match.top1.score < 阈值` | **不搜索、不读取**；直接执行主任务；连续 2 轮无命中后本会话不再自动搜索 | 0 |
| T5 | 模型想主动找 | 模型自行调用 `skills_search` | 允许；但同一 Run 最多 2 次、同名同 query 只算 1 次；第 2 次空结果即返回“本会话不再建议搜索” | ≤2 次 |
| T6 | 用户点名但技能不存在 | `explicit` 且 preflight missing | 返回可解释错误 + **pnear 候选（按名字相似度）**；绝不“声明了却调不到” | 0 |
| T7 | 低信息量任务 | 闲聊/单步问答/纯代码/纯数据计算 | 不注入技能目录（或注入精简“仅名称”版本）；不搜索 | 0 |

**负向清单（明确“不要找”）：**
- 用户只是闲聊、确认、致谢、继续/停止类指令；
- 任务已有明确产品能力且技能只是其包装（如 `.pptx` 且 editorial_pipeline/officecli 可用）；
- 上一轮已 `skills_read` 同一技能且文件未变化（用 mtime/hash 判断），本轮不重复读；
- 同一 Run 内已经空搜一次，禁止换词反复空搜（当前实测模型会连续 4-8 次空搜）；
- 目录已完整注入且 `match` 无命中时，不要“为了保险再搜一遍”；
- 只读 Chat 模式不因“可能有技能”而增加写操作/依赖安装动作（Chat 保持只读）。

**触发判定的实现位置**：建议在 `planTaskCapabilities`（`server/task.mjs:334`）内做纯函数 `matchSkillsForTask({text, route, references, catalog, policy})`，输出 `{mustPreflight, candidates, reason, score}`；不引入模型调用、不新增外部依赖。

### 6.2 找什么 skills：来源优先级、去重、选择与回退

**候选来源优先级（沿用现有 rank，补强同名规则）：**
1. `workspace`：`<ws>/.zcode|.agents|.pi|.claude|.oaw/skills`（rank 10-14）
2. `project`：`<project>/.agents|.pi|.claude/skills`（20-22）＋父目录 `.claude/skills`（23）
3. `user`：`agentDir/skills`（30）、`~/.agents/skills`（31）、`~/.claude/skills`（32）
- 同名去重：以 **frontmatter `name`** 为主键；目录名作为**别名**保留（解决 N-04）；同一主键按 rank 取先到者，但保留 `shadowed` 列表以便诊断“为什么我改的技能没生效”。
- 目录名≠name 时，`skills_read` 同时接受主键与别名（当前只接受主键）。

**描述解析**：实现最小 YAML frontmatter 解析（仅 frontmatter 段落）：
- 支持 `key: value`、`key: "..."`、`key: '...'`、`key: >` / `|` / `>-` / `|-`（后续缩进行折叠为空格或保留换行）；
- 解析失败时回退到首 200 字符正文，而不是留空/`>`；
- 统一 `技能目录.mjs` 与 `/api/skills` 的解析实现（当前 `scanSkills` 复用同一模块，已统一，但解析器本身要修）。

**搜索排序（替代空格 AND）：**
- 查询归一化：全半角、大小写、去停用词；中文按 2-gram + 别名词典（`柱状图→bar/chart`、`演示文稿/幻灯片/PPT→pptx/slide/deck`、`公文→docx/report` 等）。
- 打分：`name 完全相等 +100` / `name 包含词 +40` / `name 包含 2-gram +15` / `description 命中词 +10` / `别名命中 +8` / 使用频次 `+log(1+count)`；**OR 匹配**，按分数取 top-N，返回 `hitReason`。
- 空查询：返回“最近使用 top3 + 按分类各 1 个”，不要返回全量 12 条（当前空查询把 officecli/ultimate-ppt-master 顶到前面纯属频次排序）。
- 无命中：返回 `{hits: [], suggestions: pnearTop3, stopAutoSearch: true}`，避免模型无限重试。

**目录注入预算（8KB 的改进）：**
- 不按 scope 整条丢弃：先按“任务命中的分类”过滤（PPT/文档/图表/审查/研究/地图各保底 1 个），再按使用频次排序；预算不足时**截断描述**而不是删条目（当前 `Skill注入.mjs:84-87` 先 `full` 后 `nameOnly`，但到行级预算就 break，导致后续整条丢失——应改为“先保证所有条目 name-only，再用剩余预算补描述”）。
- 保证 `powerpoint/pptx` 这类高频英文技能不被 user scope 排序挤出（它们现在被整条丢弃）。
- 注入头写明“本目录按预算可能截断，未列出≠不存在，优先用 skills_search”。

**选择与回退（top-N）：**
- `selected = top3`；`skills_read` 最多读 2 个（T1 允许 1 个必读 + 1 个候选）；
- 依赖预检：见 6.3；若 top1 `blocked`，自动降级 top2；全 blocked → **回退产品能力**（editorial_pipeline/officecli；地图用 map_*；检索用 kb_*）；
- 回退原因写入事件与最终答复（“技能 X 未使用：缺 Python 3.10；已改用编辑流水线”）。

### 6.3 依赖治理：禁止自动安装，声明式预检，快速失败

**硬规则（建议写入系统提示 + 工具门禁，两层）：**
1. Agent **不得**自行执行 `pip/pip3/uv/conda/npm i/pnpm/yarn/apt/brew/winget/choco/nuget/git clone` 等安装命令；除非用户在本轮**显式同意**（如点击“安装依赖”按钮或明确说“可以装”）。
2. 安装只允许落 `<workspace>/.oaw/skill-deps/`（或用户确认的隔离目录），不得改系统 Python/全局 npm。
3. 任何安装命令必须带超时（≤120s）与失败即停（同命令最多 1 次重试）；禁止 4 次重复 120s。
4. 技能没有声明 `requires` 时，视为“未知依赖”，**不允许自动装**；可以先 `skills_read` 看说明，但装依赖前必须问用户。

**技能 frontmatter 增加 `requires`（声明式）：**
```yaml
---
name: ultimate-ppt-master
description: >-
  终极融合PPT大师 …
requires:
  runtime: [{ kind: python, version: ">=3.10" }]
  python: [python-pptx, cairosvg, PyMuPDF, mammoth, markdownify, ebooklib, nbconvert, Pillow, numpy, requests, beautifulsoup4, curl_cffi, google-genai, openai, PyYAML]
  network: true
  platform: [win32, darwin, linux]   # 或声明 posix-shell
  exec: [python]                     # 需要执行的解释器
install: requirements.txt            # 仅作为提示，不自动执行
---
```
- `pptx` 技能声明 `python: [markitdown[pptx]]` + `npm: [pptxgenjs]`；`whisper` 声明 `exec: [ffmpeg]`；`powerpoint` 声明 `python: [python-pptx]`；`docx` 声明 `python: [python-docx]`。
- `requires` 是**声明**不是安装器：产品只做只读探测。

**预检（`skills_read` 前置 + 目录注入时懒预检）：**
- 只读探测：`which/where <exec>`；`<python> -c "import <pkg>"`（不装）；`node -e "require.resolve(...)"`；`test -d .venv`；平台/网络标记（不真联网，用配置/最近一次失败缓存）。
- 结果 `status: ready | degraded（可选依赖缺）| blocked（必需缺）`，并生成人话：`缺少 Python≥3.10（当前 3.9.5）`、`缺少 13 个 Python 包`、`需要 POSIX shell，当前 win32`。
- `skills_read` 返回内容时附：
```
<skill_requires status="blocked">
- python>=3.10: 缺失（当前 3.9.5，来源 QGIS）
- python-pptx 等 13 包: 未安装
建议：① 用内置 editorial_pipeline 生成 PPTX；② 或由你在工作区安装隔离依赖（需确认）
</skill_requires>
```
- `blocked` 时**不自动装**，直接给替代方案并结束该分支；`degraded` 时允许只读部分能力并告知风险。

**“装依赖”降级为显式一次性动作：**
- 技能广场/设置中展示“依赖状态”；`blocked` 提供按钮“安装到工作区（需确认）”，由**用户点击**触发一次性 Job（有进度事件、可取消、有超时），安装结果缓存到 `.oaw/skill-deps/`。
- 安装 Job 必须复用现有 `.oaw/jobs` 后台机制，但先修 N-02（返回合法 tool result + jobId + 进度事件），确保模型/用户都能看到状态。
- 默认镜像策略：不硬编码；检测到上次 PyPI SSL 失败时，在**用户确认后**再建议镜像，且记录到诊断事件。

**优先复用产品已有能力（默认路径）：**
- PPT/文档 → `editorial_pipeline` / officecli / 内置 OOXML；
- 图表 → 内置 ECharts 能力 / `baoyu-echarts`（无依赖）；
- 地图 → `map_*`；
- 检索 → `kb_search/kb_read`；
- 浏览器 → `browser_*`。
- 技能定位为“流程与质量规范”，不是“运行时安装器”；依赖重的技能默认标 `degraded`，不阻塞主任务。

### 6.4 与写作闸门的能力分流（N-01 的解法）

建议三选一（推荐 A+B 组合）：
- **A. 正则收窄**：`DOCX_GENERATION` 不再把任意 `python *.py`/`node *.mjs` 视为 Office 生成；只在以下条件拦截：命令输出目标含 `.docx/.pptx`、或命令文本包含 `python-docx/pptxgenjs/Packer/writeFileSync` + Office 扩展、或重定向到 Office 文件。避免误伤数据分析/CAD/格式转换脚本。
- **B. 技能白名单通道**：技能 frontmatter 声明 `provides: [pptx]` 或 `exec: [python]`，且本轮为显式技能调用（T1）时，闸门放行该技能目录下的脚本；放行仍要求产物落工作区、结束前走 `validate`。放行事件记 `skill_exec_allowed`（含 name/script/route）。
- **C. 管线内调用**：把技能脚本作为 `editorial_pipeline` 的可选后端（pipeline 调用 skill → 产物仍由流水线验收），闸门只挡“绕开流水线的裸脚本”。
- 不论哪种，`read` 路由下技能脚本可执行、`template/generate` 下需走 A/B/C 之一——否则“做 PPT”这个技能永远和写作闸门冲突。

### 6.5 可观测性：事件与字段

| 事件 | 触发 | 字段（建议） |
|---|---|---|
| `skill_catalog_injected` | 每轮目录注入 | `count, included, truncated, bytes, hash, policy, durationMs` |
| `skill_search` | 每次检索（模型或服务端） | `query, hits, topNames[], empty, durationMs, source: model/server` |
| `skill_selected` | 服务端选定候选 | `name, rank, score, reason, sourceScope, productCapableSkip` |
| `skill_preflight` | 读取/调用前 | `name, status(ready/degraded/blocked), missing[], probeDurationMs` |
| `skill_read` | `skills_read` | `name, bytes, fullBytes, truncated, hash, fromSkill`（即使 flag 关也记录！） |
| `skill_injected` | 注入正文（flag 开） | 现有字段（`事件注册表.mjs:225`） |
| `skill_exec_allowed/blocked` | 闸门判定 | `name, script, route, code, reason` |
| `skill_dependency_install` | 用户确认后安装 | `name, kind, command, jobId, status, durationMs, exitCode` |

- 当前 `事件注册表.mjs` 只有 `skill_injected/skill_draft_created/skill_installed`；上述事件需要登记并加 schema。
- 失败可诊断性：PPT 技能失败时最终答复必须落到具体一环：`未检索到/未读取/读取被截断/缺 Python 3.10/缺 N 包/闸门拦截/用户未确认安装`，不能只说“技能调用失败”。

### 6.6 验收口径（可测断言）

| # | 场景 | 可测断言 |
|---|---|---|
| A1 | 用户输入“用 PPT master 做一个 10 页汇报 PPT” | 1 次 `skills_search`（或服务端直接命中）→ `skill_selected=ultimate-ppt-master` → `skills_read` 返回全文（`truncated=false` 或按 20KB 预算且**不截断 Step 2–6**）→ `skill_preflight=ready` 或给替代方案 |
| A2 | 同上，但环境 blocked（无 Python 3.10） | 不执行 pip/npm；10s 内返回可解释失败 + 替代方案（editorial_pipeline）；Run 事件含 `skill_preflight.blocked` |
| A3 | `template/generate` 路由 + 技能脚本 | 技能白名单通道生效：`skill_exec_allowed` 事件出现；或正则收窄后脚本不再被误判；产物可 validate |
| A4 | 中文搜索 | `PPT 演示`、`生成PPT`、`制作演示文稿`、`幻灯片`、`汇报PPT` 至少各 1 个合理 top3 候选（含 `ultimate-ppt-master`/`pptx` 之一），带 `hitReason` |
| A5 | frontmatter 解析 | `/api/skills` 与目录注入中 10 个 block scalar 技能 description 完整（不再是 `>`/`|`），并有单测 |
| A6 | 目录预算 | 66 个技能中，**所有**技能的 name 至少出现一次（name-only 兜底），`powerpoint/pptx` 不被整条丢弃；`truncated` 只影响描述 |
| A7 | 空搜索 | 连续 2 次空结果后返回 `stopAutoSearch=true`；同一 Run 的 `skill_search` ≤2 次 |
| A8 | 显式点名不存在技能 | 返回可解释错误 + pnear 候选；不静默回退、不虚构 |
| A9 | 120s 长命令 | 后台化返回合法 tool result（含 `jobId`），`tool_backgrounded` 事件出现；模型可 `job_status`；无 ArrayBuffer 错误 |
| A10 | 依赖安装 | 未获用户确认时，Run 内 `pip/npm install` 次数 = 0；获得确认后安装 Job 有进度事件、超时、可取消 |
| A11 | 事件审计 | 任意一次技能使用可在 Run 事件中还原 `search→selected→preflight→read→exec` 全链 |
| A12 | 回归 | 新增 `test:skill-discovery`（搜索中文/block scalar/触发矩阵/无命中不阻塞）+ `test:skill-deps`（预检只读/禁止自动装/120s 后台化 payload 合法） |

---

## 7. 风险与未验证项

- **未验证**：以上规则均为静态建议；未在真实 Run 验证修复后行为（只读约束），也未执行 pip/npm 实验。
- **未确认**：`.claude/skills` 下 20 个无扩展名占位文件的预期用途（可能是外部安装器的链接约定）；`../.agents/skills` 在其它机器上是否存在。
- **口径差异**：`ask_user` 历史上出现过“5 分钟内回答”文案，当前代码默认 30 分钟（`agent.mjs:667-668`）；需产品确认期望值（30 分钟对长任务太久了）。
- **改名风险**：`ultimate-ppt-master-skill`（目录）与 `ultimate-ppt-master`（frontmatter）并存；若统一名字，历史 `skill-usage.json` 计数会分裂，需要迁移。
- **git 状态**：`.claude/skills` 已不跟踪（`.gitignore:155`，0 tracked / 13090 files）；判断“本地技能是否存在”必须以磁盘扫描为准，不能以 git tracked 为准。
- **未验证的假设**：`run_dea3fb50` 导出的 1 页测试 PPTX 是否可用于正式汇报（看起来只是模板验证）；用户真正的 PPT 产物仍由 editorial_pipeline 产出。

---

## 8. 附录：复现命令与证据索引

### 8.1 只读复现命令

```bash
# 1) 目录与描述（66 个；10 个描述为 > / | / >-）
curl -s http://127.0.0.1:3002/api/skills

# 2) 项目技能策略（7/7 skills=[]、skillsPolicy=auto）
curl -s http://127.0.0.1:3002/api/projects

# 3) 运行开关（skillInjection=false、contextSections=false）
curl -s http://127.0.0.1:3002/api/status

# 4) 目录注入复刻（只读导入产品模块）
node --input-type=module -e '
import { listSkillCatalog } from "./server/技能目录.mjs";
import { buildSkillCatalog } from "./server/Skill注入.mjs";
const skills = listSkillCatalog({ projectDir: process.cwd(), userProfile: process.env.USERPROFILE, workspace: "D:/<用户工作区>" });
const built = buildSkillCatalog({ skills });
console.log(built.count, built.included, built.truncated, built.bytes);
console.log(built.text.split("\n").find(l => l.includes("ultimate-ppt-master")));
'

# 5) 写作闸门复刻
node --input-type=module -e '
import { classifyToolCall } from "./server/office规范/执行闸门.mjs";
const r = classifyToolCall({ tool: "bash", input: { command: "python tools/analyze_data.py" }, context: { route: "generate", officeFormat: true, mode: "agent" } });
console.log(r.blocked, r.code);
'
```

### 8.2 关键 Run / 文件索引

- PPT master 尝试：`run_cd23bb40-3f4a-461a-bc49-a5bddb763ac3`、`run_56a4d971-ff7d-41f3-9c15-ba5b60873078`、`run_dea3fb50-f76f-42c8-90d6-aaa46b01f863`
- Python 环境缺失：`run_6eaf6f3c-bf9f-486e-9f3c-36957f95000b`
- 后台化/长任务：`run_554831ce-dea7-4438-81c5-3af1cd714670`（静默 64 分钟）、`run_7cb68351-cdfe-468d-acf4-31d927fbc699`
- 技能计数：`%APPDATA%\规聚\集成\skill-usage.json`（ultimate-ppt-master-skill:2、release-skills:1、officecli:1、ultimate-ppt-master:1）
- ask_user：`.oaw/pending-asks.json`（93 条，16 expired）
- 技能包：`.claude/skills/ultimate-ppt-master-skill/SKILL.md`（26007B/25213 chars/440 行，:77-83 运行时规则）、`INSTALL.md:19-25/93-100`、`requirements.txt`（15 项）
- 代码：`server/agent.mjs:460,478-484,522-530,1383-1390,1428,1502-1513,1906,1924,2856-2906,5884-5896`；`server/Skill注入.mjs:8,32-37,47-95`；`server/技能目录.mjs:20-35,37-60,69-114`；`server/资源发现.mjs:19-56`；`server/任务复杂度.mjs:37-45`；`server/task.mjs:22,347-351,447-449,477-478`；`server/index.mjs:2760-2820,4880-4939`；`server/运行开关.mjs:72,223-225,261-271`；`server/后台任务.mjs:19-22`；`server/office规范/执行闸门.mjs:9-10,157-169,206-212,274-285`；`server/context.mjs:90-93,204`；`server/事件注册表.mjs:225-227`；`client/src/components/ChatPanel.jsx:1247-1264,1802,3960-3980`；`client/src/components/SettingsPanel.jsx:248-262`；`scripts/Skill注入契约测试.mjs`
- 文档：`REQUIREMENTS.md:168-186`（R6）、`DESIGN.md:310`、`.gitignore:155`、`变更日志.md:16`

### 8.3 临时脚本

本次统计脚本均位于 `%TEMP%\dsh-dNWY2v\`（`scan-skills.mjs`、`scan-installs.mjs`、`scan-ppt.mjs`、`scan-jobs.mjs`、`scan-catalog.mjs`、`final-stats.mjs`、`gate-test.mjs`），未写入仓库。
