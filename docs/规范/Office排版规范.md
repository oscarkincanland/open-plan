# Office 排版规范

> 状态：草案（随 feature/office-writing-capability 分支评审）
> 基线：v0.11.55
> 更新：2026-10-27
> 关联：AGENTS.md / [PRD](../../REQUIREMENTS.md) R1·R7·R11·R13 / 架构规范（主工作线） / 功能验证测试规范（主工作线） / [整合修改计划](../plans/2026-10-27-006-Office写作能力整合修改计划.md)
> 适用范围：`server/office规范/` 下的版式参数、模板路由、规则闸门，以及 `server/文档引擎.mjs` 的 blocks v2 样式层。

---

## 1. 目的

把"文档应该长什么样"从模型自由发挥变成可查表、可测试、可回滚的参数：

- 模板负责**内容骨架**（章节、必备图表、领域禁忌）；
- 版式令牌负责**排版数值**（字号、行距、缩进、页边距、配色）；
- 规则闸门负责**确定性验收**（9 项检查 + 模板覆盖率）。

三者互不替代。模板正文只存在于 `templates/traffic-material/`，本规范不复制模板内容。

---

## 2. 四路由（唯一判定入口）

| 路由 | 触发条件 | 执行方式 |
|---|---|---|
| `template` | 显式 `@模板[...]` / 结构化模板引用；或文体关键词命中 14 个模板 | 读模板 → 按章节写 → 覆盖率验收 |
| `edit` | 既有 Office 文件 + 编辑意图 | `view` → `get` → `set/add/batch`，保留原格式 |
| `generate` | 有写作意图但无模板/既有文件 | 场景参数 + 原生 OOXML 直写 |
| `read` | 其余情况（含 Chat/Review） | 只读检索 |

判定函数：`server/task.mjs` 的 `routeTaskIntent()`。能力计划同时下发 `route`、`routeReason`、`template`、`scene`、`clarification`。

---

## 3. 模板化写作

### 3.1 资产

- 目录：`templates/traffic-material/`，共 14 个 Markdown 模板。
- 检索：`server/tpl.mjs`（`/api/templates`）、`@模板[...]`（`server/context.mjs`）。
- 匹配：`server/office规范/模板匹配.mjs`，显式引用优先，其次文体关键词。
- 结构抽取：`server/office规范/模板结构.mjs`，解析 ✅ 必备章节、🔧 可选章节、必备图件/表格清单、格式规则、常见错误。
- 覆盖率：`assertCoverage(structure, producedText)`，必备章节/图表缺失逐条定位。

### 3.2 硬规则

1. 不新建 `templates/office/` 或第二套模板体系。
2. 不改写模板正文；匹配与抽取只读。
3. 模板路由不因"模型觉得不合适"而跳过覆盖率验收。
4. 模板结构解析失败时降级为"仅提示"，不阻断生成。

---

## 4. 版式令牌

来源：`server/office规范/设计令牌.mjs`。

| 项 | 取值 |
|---|---|
| 中文字号 | 初号 42 / 小初 36 / 一号 26 / 小一 24 / 二号 22 / 小二 18 / 三号 16 / 小三 15 / 四号 14 / 小四 12 / 五号 10.5 / 小五 9 / 六号 7.5（pt） |
| 行距 | 1.15 倍（276）/ 1.3 倍（312）/ 1.5 倍（360）/ 固定 28pt（560，`exact`） |
| 中文首行缩进 | SimSun 480 twips / Microsoft YaHei 420 twips |
| 页边距 | 常规 1440/1440/1800/1800；公文 2098/1984/1588/1474；窄 1134 四边（twips） |
| 纸型 | A4 11906 × 16838 twips |
| 配色 | 12 套（morandi / gov-blue / forest / slate / warm-sand / ink / ocean / plum / traffic / eco / academic / warm-red） |

约束：字号必须来自 13 档；固定行距必须 `exact`；配色必须是 6 位十六进制。

---

## 5. 封面配方 R1–R7

来源：`server/office规范/封面配方.mjs`。

| 配方 | 适用 | 特征 |
|---|---|---|
| R1 | 公文/通知 | 红头、上方细线、居中 |
| R2 | 规划/研究报告 | 左侧色带、左对齐 |
| R3 | 学术论文 | 纯白、居中、无装饰 |
| R4 | 合同协议 | 上下双细线、纯黑 |
| R5 | 简历 | 顶部窄色条、左对齐 |
| R6 | 试卷 | 极简、无装饰 |
| R7 | 文案口播 | 大标题 + 底部色块 |

**三不变量（不可协商）**：`margin=0`、外层行高 `16838 twips` 且 `rule=exact`、外层表格无边框。
封面标题必须经 `calcTitleLayout()` 计算，禁止硬编码 >40pt；不得出现单字孤行。

---

## 6. 场景参数

来源：`server/office规范/场景参数.json`，共 7 套：`academic`、`report`、`contract`、`official-doc`、`resume`、`exam`、`copywriting`。

每套必须包含：`label`、`keywords`、`page.margins`、`font`（正文/标题字体与四级字号）、`spacing`（行距/缩进）、`cover.recipe`、`structure`（章节骨架）、`forbidden`（领域禁忌）。

默认场景为 `report`；无命中时在产物元信息标注"按默认场景"。

---

## 7. 规则闸门

来源：`server/office规范/验收规则.mjs`，`runDocxQa(file, { structure })`。

| # | 规则 | 判定 |
|---|---|---|
| 1 | `blank_page` | 连续 ≥3 空段，或相邻分页符 |
| 2 | `cover_overflow` | 前 8 段字号 >40pt，或封面空段 >12 |
| 3 | `line_spacing` | 正文行距取值 >2 种（告警） |
| 4 | `table_margins` | 表格缺 `tblCellMar` |
| 5 | `image_ratio` | 外框与图像宽高比偏差 >2% |
| 6 | `cjk_indent` | 正文段落缺 `firstLine ≥ 420`（告警） |
| 7 | `heading_hierarchy` | 标题跳级（H1→H3） |
| 8 | `placeholder` | 含 `{{`、`TODO`、`【待补】` |
| 9 | `font_floor` | 字号 <10.5pt |
| 10 | `template_coverage` | 模板必备章节/图表缺失 |

返回 `{ passed, issues[], checks[], text }`。`passed=false` 的产物不得在产物面板标记"验收通过"。

---

## 8. 目录与页码后处理

来源：`server/office规范/后处理.mjs`。

- 目录：确保 `settings.xml` 含 `<w:updateFields w:val="true"/>`，否则 Word 打开后目录为空。
- 页码：页眉/页脚中的 `PAGE \* decimal` 一律改为 `PAGE \* arabic`；清理空 `<w:pgNumType/>`，正文节写入 `w:start="1"`。
- 全部操作幂等，可重复执行。

---

## 9. 开关与回退

- 开关：`OAW_OFFICE_FORMAT`（`server/运行开关.mjs` 的 `officeFormat`），**默认关**。
- 关闭时：路由、生成、流水线行为与 v0.11.55 基线一致；不启用澄清闸门、封面、目录、页码与 QA。
- 打开时：启用模板/场景/版式/QA；仍可单独关闭某一项（流水线参数 `autoClarify`、`qa`、`toc`、`pageNumbers`）。

---

## 10. 执行闸门与澄清前置

来源：`server/office规范/执行闸门.mjs`，在 `server/agent.mjs` 的 bash / officecli / write / edit 工具入口执行。

- **生效条件**：`OAW_OFFICE_FORMAT=1`、Work 模式、`route=template|generate|edit`。
- **写作路由（template/generate）**：
  - bash 生成或转换 docx/pptx（node `.mjs/.cjs/.js` 脚本、python `.py`、`node -e` 生成库、`python -c` 生成库、pandoc、重定向、通过 bash 调 officecli）→ `OFFICE_PIPELINE_REQUIRED`；
  - officecli 在管线产出前的 `create/add/set/batch/import/remove/move/swap/delete` → 拒绝；
  - `add --type markdown` 始终拒绝（改用 `sourceMarkdown`）；
  - write/edit 写 `.docx` / `.pptx`，或写生成脚本 `.mjs/.cjs/.js/.py` → 拒绝；
  - 只读命令（`view/get/query`、`ls/grep/unzip -p`、只读 `node -e`）放行。
- **澄清前置**：`clarification.shouldAsk=true` 时，回答前拒绝一切写操作（含 `editorial_pipeline`），只允许信息收集工具与 `ask_user`。
- **逃逸阀**：命令带 `--allow-manual`，或用户需求里明确写"脚本/代码/手工生成/自己生成"时放行。
- **回退**：关闭 `OAW_OFFICE_FORMAT` 即完全放行，行为与 v0.11.55 基线一致。
- **Markdown 直通**：`editorial_pipeline` 的 `sourceMarkdown` 跳过 Planner/Writer，`markdownToBlocks` 解析标题/段落/表格后统一排版与验收。

## 11. 验证入口

```bash
npm run test:office-route      # 四路由与触发词
npm run test:office-clarify    # 澄清闸门与单槽位
npm run test:office-format     # 令牌、封面、场景
npm run test:office-template   # 模板匹配、结构、覆盖率
npm run test:office-qa         # 9 项规则
npm run test:office-generate   # blocks v2 与端到端
npm run test:doc-engine        # 旧 blocks 兼容
npm run test:editorial-pipeline
npm run verify
```

---

## 12. 不做

- 不引入 LibreOffice / pandoc / poppler 运行时依赖。
- 不做多模态视觉判定；渲染抽检只进人工 L4。
- 不自动重排用户既有文档。
- 不在 `.claude/skills/` 内放第二份版式参数。
- 不把 `office` 当作可新建模式。
