# 0009 · Office 写入锁按目标文件粒度

> 状态：已采纳（2026-10-27，feature/office-writing-capability）
> 关联：[架构规范](../规范/架构规范.md) §7（写入与锁）、[Office 排版规范](../规范/Office排版规范.md) §10、[计划 008](../plans/2026-10-27-008-Office执行层收口修改计划.md)

## 背景

`server/写入协调.mjs` 的锁以 `targetPath` 为键，且 `overlapping()` 把父目录与子路径视为冲突。此前：

- `officecli` 的写命令锁整个工作区（`targetPath: ctx.workspace`），即使已经知道目标文件 `parsed.file`；
- `editorial_pipeline` 锁整个工作区；
- `bash` 无论读写都锁整个工作区，`ls`/`grep` 也会占锁。

结果是同一个工作区里 Word 与 PPT 两个任务不能并行，甚至一个只读 `ls` 也会挡住另一个任务的写入。实测出现过"写入范围被另一个 PPT 任务占用"。

## 备选方案

| 方案 | 做法 | 问题 |
|---|---|---|
| A | 保持工作区级锁，任务串行排队 | Word/PPT 无法并行，违背用户预期 |
| B | 所有工具都改成文件级锁 | `bash` 目标未知，无法可靠推断 |
| C | Office 写按目标文件、只读 bash 不占锁、写 bash 保持工作区级 | 需要区分读写命令；已具备 `isReadonlyBash` |

## 决策

采用 **C**：

1. `officecli` 写命令：`targetPath = parsed.path || workspace`。
2. `editorial_pipeline`：`targetPath = 交付文件绝对路径`（`outputPath` 或 `${safePipelineName(goal)}.${format}`）。
3. `bash`：只读命令（`isReadonlyBash`）不取锁、不发写事件；写命令仍取工作区级锁。
4. `write/edit`：保持已有的按文件锁。
5. 锁重叠语义不变：工作区级锁仍会挡住该工作区内所有文件锁；不同文件之间不冲突。

## 后果

- 同一工作区的 Word 与 PPT 写不同文件可以并行；写同一文件仍按 `WRITE_CONFLICT` 串行。
- 只读 `ls/grep/unzip -p` 不再造成跨任务阻塞。
- `bash` 的写命令仍可能短暂占用工作区锁；这是目标未知时的保守兜底。
- 需要回归：`test:write-lock`（新增不同文件并行、工作区锁仍挡文件锁两例）。
