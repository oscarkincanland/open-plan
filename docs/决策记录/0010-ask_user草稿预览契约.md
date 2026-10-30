# 0010 · ask_user 草稿预览契约

> 状态：已采纳（2026-10-27，feature/office-writing-capability）
> 关联：[计划 008](../plans/2026-10-27-008-Office执行层收口修改计划.md)、[Office 排版规范](../规范/Office排版规范.md) §10

## 背景

用户在写作流程中希望"先看内容再确认"：模型已经生成 Markdown 草稿时，`ask_user` 追问应自动打开这份草稿，让用户确认后再继续写入 docx/pptx。此前 `ask_user` 只有问题和选项，草稿只能靠用户自己去产物面板找。

## 决策

1. `ask_user` 工具新增可选参数 `previewFile`（工作区相对路径）。
2. 事件 `ask_user` 载荷新增可选字段 `previewFile`；未提供时不出现，向后兼容。
3. `editorial_pipeline` 在 `needs_clarification` 时，如果已有 `sourceMarkdown`，写一份 `<fileBase>.draft.md` 到交付目录，并在 `clarification.previewPath` 返回。
4. `editorial_pipeline` 工具把 `previewPath` 记到 `entry.clarificationPreview`；`ask_user` 未显式传 `previewFile` 时自动使用它，并在使用后清空。
5. 前端 `ChatPanel` 收到带 `previewFile` 的 `ask_user` 事件时，调用 `onOpenFile(previewFile)` 自动打开预览；失败静默，不阻塞提问卡。
6. 提示词增加一条："已有 Markdown 草稿时，调用 ask_user 用 previewFile 指向它。"

## 后果

- 用户回答前可以先看草稿；回答流程不变，仍可只点选项。
- 草稿是工作区普通文件，不是正式产物，不进入 Run 的 artifact 验收。
- 前端在无 `onOpenFile` 的嵌入式场景下自动降级为只打开提问卡。
- 需要回归：`test:office-clarify` 增加 pipeline previewPath 用例；前端做源码接线断言（`data.previewFile` / `onOpenFile?.(data.previewFile)`）。
