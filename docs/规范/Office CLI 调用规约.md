# Office CLI 调用规约

> 状态：生效　版本：1.0　基线：v0.13.3（develop @ f9f40866）　更新：2026-11-05
> 关联：[AGENTS.md](../../AGENTS.md) §5 / [REQUIREMENTS.md](../../REQUIREMENTS.md) R1 / [DESIGN.md](../../DESIGN.md) / [017 计划](../plans/2026-11-05-017-对话终稿任务中断与OfficeCLI调用规约收敛计划.md) / `server/office规范/OfficeCLI调用规约.mjs`
> 唯一判定源：`officeCliPolicy({ mode, route, command, args, pipelineProduced, clarificationPending, manualAllowed })`。本规范与实现冲突时，以该函数与测试为准并同步修正本文件。

## 1. 基本原则

1. 所有 Office 文档操作必须通过 `officecli` 工具，不允许 `bash officecli`。
2. `officecli` 只负责既有文档的读取与精确编辑；新建/套模板优先 `editorial_pipeline`/原生生成，生成后再用 CLI 精修。
3. 只读查看不得写；写操作必须有明确的编辑意图和目标文件。
4. 未知子命令按写处理；默认拒绝，不默认放行。
5. 结构性编辑按 `@paraId` 定位，不按段落序号批量删改。

## 2. 模式

| 模式 | 是否暴露 `officecli` |
|---|---|
| Chat | 否；误调用返回 `OFFICE_TOOL_UNAVAILABLE` |
| Work (`agent`) | 是 |
| Review | 是；只对副本/批注副本写，原文写回需确认 |
| Office（历史兼容） | 是，按 Work 处理 |

## 3. 路由

| 路由 | 触发条件 | CLI 策略 |
|---|---|---|
| `edit` | 既有 Office 文件 + 修改/编辑/替换/删除/批注等意图 | 首选；读写都允许；不澄清；不强制流水线；预检阻塞 |
| `template` | 显式 `@模板[...]`，或没有既有文件且命中模板关键词 + 生成意图 | 只读允许；写命令必须 `pipelineProduced=true`；澄清前置；预检惰性 |
| `generate` | 有生成意图 + Office 意图，无既有文件/无模板 | 同 `template` |
| `read` | 其余 | 只读允许；写命令拒绝 `OFFICE_READONLY_ONLY` |

短句“继续/继续修改”在当前文件是 Office、上一轮是 `edit/template/generate` 时沿用上一轮路由；不得重新按文件名匹配模板。

## 4. 命令分级

| 级别 | 命令 | 说明 |
|---|---|---|
| 只读 | `view` `get` `query` `validate` `dump` `help` `watch` `unwatch` | 可随时执行（编辑路由/模板路由均允许） |
| 写 | `create` `add` `set` `batch` `import` `remove` `move` `swap` `delete` `save` `close` | 受路由/流水线/澄清约束 |
| 未知 | 任意其他 | 按写处理，默认拒绝 |

`save`/`close` 会落盘或触发 flush，按写处理。复制/移动/打包 docx 不是“生成 docx”，不触发流水线闸门；Review 用 `review_copy`。

## 5. 预检

| 路由 | 预检 |
|---|---|
| `edit` | 阻塞式 `checkOfficecli()`；不可用直接拒绝 admission |
| `template/generate` | 后台惰性预检，不阻塞生成主链 |
| `read` | 无 |

## 6. 明确禁止

- Chat 模式调用 `officecli`。
- `read` 路由写文件。
- 模板/生成路由在 `pipelineProduced=false` 时 `create/add/set/remove/save/close`。
- 用 `bash` 执行 `officecli`。
- 按段落序号批量 `remove`；必须先取 `@paraId` 并回读。
- 把 `cp/copy/mv/move` 当成“生成 docx”拦截；复制不是生成。

## 7. 测试

- `npm run test:office-cli-policy`
- `npm run test:office-exec-gate`
- `npm run test:office-route`
