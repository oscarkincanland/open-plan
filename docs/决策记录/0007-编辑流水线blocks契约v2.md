# 0007 · 编辑流水线 blocks 契约 v2

> 状态：已采纳（随 feature/office-writing-capability 分支评审）
> 日期：2026-10-27
> 关联：[Office 排版规范](../规范/Office排版规范.md)、[整合修改计划](../plans/2026-10-27-006-Office写作能力整合修改计划.md)

## 背景

`buildDocxFromBlocks` 的 blocks 只有 `heading` / `paragraph` / `table` / `image` 四类，无法承载字号、行距、缩进、封面、目录、页眉页脚与页码。直接扩展必填字段会破坏既有调用方（`编辑流水线.mjs`、`scripts/文档引擎测试.mjs`）。

## 备选方案

| 方案 | 做法 | 问题 |
|---|---|---|
| A | 只支持 v2，旧字段改名 | 破坏既有调用方与测试 |
| B | 新增独立生成函数 | 两套生成器，长期分叉 |
| C | 字段全可选 + `styled` 标记 + 旧路径不变 | 需要维护两套渲染分支 |

## 决策

采用 **C**：

1. `buildDocxFromBlocks(target, blocks, options = {})`，`options` 全部可选。
2. 不传任何选项时走旧路径，输出与 v0.11.55 一致。
3. 传 `style` / `scene` / `cover` / `toc` / `pageNumbers` 时走 v2 样式层，返回 `{ styled: true, postProcess: [] }`。
4. 能力矩阵新增 `create:styled` 条目，不改既有 `create` 语义。
5. 目录/页码通过 `postProcessDocx` 做确定性后处理，幂等。

## 后果

- 旧 blocks 与旧测试保持通过（`test:doc-engine`）。
- 新字段需要新增测试（`test:office-generate`）。
- `styled` 是行为开关的观测点，日志与事件可据此判断是否走了规范层。
- 后续若要新增 block 类型（如 footnote、chart），必须保持"未知类型回退 paragraph"的兼容策略。
