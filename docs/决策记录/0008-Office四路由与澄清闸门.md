# 0008 · Office 四路由与澄清闸门

> 状态：已采纳（随 feature/office-writing-capability 分支评审）
> 日期：2026-10-27
> 关联：[Office 排版规范](../规范/Office排版规范.md)、[整合修改计划](../plans/2026-10-27-006-Office写作能力整合修改计划.md)、[验证与测试计划](../plans/2026-10-27-007-Office写作能力验证与测试计划.md)

## 背景

- `planTaskCapabilities` 只认 `officecli/word/docx/文档排版/修改文档` 等少量词，"帮我写个文档""写一个工可材料"在能力计划里完全静默。
- 14 个交通规划模板只在提示词层生效，没有路由，也没有覆盖率验收。
- `ask_user` 提示词要求"必须问"，但只覆盖"撰写文字"，且 `pendingAsks` 以 `clientId` 为键，并发提问会互相覆盖。
- 编辑流水线（Planner→Writer→Formatter→Evaluator）不能提问，歧义被默默补齐。

## 备选方案

| 方案 | 做法 | 问题 |
|---|---|---|
| A | 只补触发词 | 模板仍无路由，澄清仍靠自觉 |
| B | 新增模型可见工具（office_template / office_qa） | 白名单膨胀，Chat/Review 边界连锁改动 |
| C | 扩能力计划 + 内部模块 + 澄清闸门 | 契约版本升级，需要 ADR 与测试 |

## 决策

采用 **C**：

1. `routeTaskIntent()` 输出四路由：`template` / `edit` / `generate` / `read`，附 `reason`。
2. 能力计划版本升到 **3**，新增 `route`、`routeReason`、`template`、`scene`、`clarification`，`routing` 增加 `template` 与 `officeFormat`。
3. 模板命中声明 `template` 能力；模板/生成路由声明 `office_generate`；编辑路由 `officecli=preferred`。
4. 澄清闸门：`{文档类型, 篇幅, 受众, 素材来源, 风格}` 缺 **≥2** 项才问，只问最阻塞的 1 项；缺 1 项按默认值继续并标注假设；用户说"你看着办"不追问。
5. 流水线 `autoClarify=true` 时缺项返回 `needs_clarification`，不产成品；由父会话转 `ask_user`。
6. `ask_user` 单槽位：已有待回答时拒绝第二个，不覆盖第一个的 resolve。

## 后果

- `test:capability-contract` 版本断言改为 3，并允许 `template` 能力。
- 新增 `test:office-route`、`test:office-clarify`。
- 默认开关关：未打开 `OAW_OFFICE_FORMAT` 时，流水线不启用澄清闸门与 QA，行为与基线一致。
- 触发词补全可能让少量问答被识别为生成意图；已用"输出意图 + Office/模板意图"双重条件与反例测试约束。
