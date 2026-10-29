# 0006 · Office 规范层参数化，而非复制提示词

> 状态：已采纳（随 feature/office-writing-capability 分支评审）
> 日期：2026-10-27
> 关联：[Office 排版规范](../规范/Office排版规范.md)、[整合修改计划](../plans/2026-10-27-006-Office写作能力整合修改计划.md)

## 背景

ZCode 的 Word 能力核心资产是 80KB `design-system.md` + 7 个场景包 + 3 个后处理脚本，只存在于 ZCode 安装目录，不在本仓库。本项目已有 OfficeCLI 命令面、原生 OOXML 生成器和 14 个交通规划模板，但缺少"版式应该长什么样"的可执行规范。

## 备选方案

| 方案 | 做法 | 问题 |
|---|---|---|
| A | 把 ZCode `documents/0.1.8` 整包复制进 `.claude/skills/` | 依赖 LibreOffice/pandoc/poppler/defusedxml；115 个文件挤占技能目录；与 OfficeCLI 能力重叠；双事实来源 |
| B | 只把 `design-system.md` 当提示词 | 仍是模型自觉；参数无法被代码复用；无法单测 |
| C | 参数模块化 + 文档索引 + 规则闸门 | 需要一次移植与维护成本 |

## 决策

采用 **C**：

1. 版式数值进 `server/office规范/设计令牌.mjs`（可 import、可单测）。
2. 场景与封面配方进 `场景参数.json` / `封面配方.mjs`。
3. 规范说明进 `docs/规范/Office排版规范.md`，只做索引，不复制模板正文。
4. 验收进 `验收规则.mjs`，可 CI。
5. 全部受 `OAW_OFFICE_FORMAT` 开关控制，默认关。

## 后果

- 新增 `server/office规范/` 目录与 6 个新测试脚本。
- 模板正文保持只读；`templates/traffic-material/` 不新增、不改写。
- 参数需要随设计评审维护；变更必须同步规范文档与测试。
- 关闭开关即可回到 v0.11.55 行为。
