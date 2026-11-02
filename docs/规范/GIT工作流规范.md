# GIT 工作流规范

> 状态：生效　版本：1.1　基线：v0.13.14　更新：2026-11-02
> **权威范围**：分支、提交、评审、合并、打标、发布、冲突处理、仓库权限。本文是 GIT 操作的**唯一事实源**。
> **上位文件**：`AGENTS.md`（项目宪法）。冲突时以宪法为准；宪法未覆盖处，以本文为准。
> **相邻文档**：[架构规范](架构规范.md) · [代码规范](代码规范.md) §13 变更纪律 · [功能验证测试规范](功能验证测试规范.md) · [当前开发进度](../进度/当前开发进度.md) · [决策记录索引](../决策记录/决策记录索引.md)。
> **当前仓库事实**（2026-11-02）：远程 `origin` = `github.com/oscarkincanland/open-plan`；常驻分支 `main` + 工作分支；`develop` 未启用（单主线开发）；当前集成分支 `integrate/v0.13.14`。

---

## 1. 三条铁律

| 编号 | 铁律 | 违反判定 |
|---|---|---|
| G-01 | **一次提交 = 一条工作流**，逐文件 pathspec 提交 | 提交中含其他工作流文件即违规，必须撤销重提 |
| G-02 | **红灯不提交、不合并、不发布**：L1–L4 + 改动面回归必须绿 | 任一必过项红仍提交/合并，视为阻断级违规 |
| G-03 | **禁止改写已推送历史**：`push --force`、对已推送提交 `commit --amend`、`rebase` 公共分支 | 出现即事故，按第 13 节处理 |

---

## 2. 分支层级与命名

### 2.1 分支层级

| 层级 | 分支 | 创建来源 | 合入目标 | 生命周期 | 使用场景 | 保护规则 |
|---|---|---|---|---|---|---|
| L0 发布 | `main` | — | — | 永久 | 随时可构建、可部署的验收基线 | 保护分支；禁止直推；只接受评审通过的合并 |
| L1 集成（可选） | `develop` | `main` | `main` | 长期 | 仅在 ≥2 人并行、多个工作流需先在集成分支汇合时启用 | 保护；禁止直推 |
| L2 工作 | `feature/<语义>` | `main` 或 `develop` | 同名集成分支 | 合并后立即删除 | 新功能、新能力、跨模块改造 | 单人独占；每日同步上游 |
| L2 工作 | `fix/<语义>` | `main` | `main`（或 `develop`） | 合并后删除 | 缺陷修复 | 同上 |
| L2 工作 | `chore/<语义>` | `main` | `main` | 合并后删除 | 构建、依赖、仓库卫生、CI | 同上 |
| L2 工作 | `docs/<语义>` | `main` | `main` | 合并后删除 | 纯文档变更 | 同上 |
| L3 紧急 | `hotfix/<语义>` | `main` | `main` | 发布后删除 | 线上/验收基线阻断缺陷 | 必须产品负责人批准；合并后立即打补丁 tag |

**不设分支的情况**：单文件文案、注释、错别字，可直接在当前工作分支修改并提交；**不得直推 `main`**。

### 2.2 命名规范

```
<类型>/<语义>[-<编号>]
类型 ∈ feature | fix | chore | docs | hotfix
语义：小写英文短横线，≤4 词，能看懂做什么
```

| 正例 | 反例 | 说明 |
|---|---|---|
| `feature/v0.11.56-execution-handle` | `feature/new` | 语义为空 |
| `fix/excel-zero-based` | `fix/bug` | 无法判断范围 |
| `chore/repo-cleanup` | `temp` | 无类型前缀 |
| `hotfix/docx-lock-crash` | `hotfix-1` | 无层级 |

- 分支名**一经推送不再改名**；改名等价于新建分支并删除旧分支（需批准）。
- 禁止：`master`、`test`、`tmp`、个人姓名、中文、日期裸串。

### 2.3 分支操作基线

```powershell
git switch main
git pull --ff-only origin main          # 只允许快进
git switch -c feature/v0.11.56-execution-handle
# …开发与提交…
git fetch origin; git rebase origin/main   # 工作分支每日同步，冲突处理见第 9 节
git push -u origin feature/v0.11.56-execution-handle
```

---

## 3. 提交信息规范

### 3.1 格式

```
<类型>(<范围>): <中文描述>

<正文：为什么改 + 改了什么，可省略>

<脚注：Refs / BREAKING CHANGE，可省略>
```

- 首行 ≤ 72 字符；句末不加句号；**描述写"为什么 + 做了什么"，不写"update/修改/提交"**。
- 类型：`feat` 新功能｜`fix` 缺陷｜`refactor` 重构（不改行为）｜`perf` 性能｜`test` 测试｜`docs` 文档｜`chore` 构建/依赖/仓库｜`ci` 流水线。
- 范围：`server`｜`client`｜`gis`｜`pi`｜`docs`｜`ci`｜`deps`｜`repo`；跨范围可省略。
- 脚注：`Refs: D-018, T-29` 关联决策与验收项；破坏性变更必须写 `BREAKING CHANGE:`。

### 3.2 示例

| 正例 | 反例 |
|---|---|
| `fix(server): 修正 Excel 行列键 1-based 导致首行首列为空` | `fix bug` |
| `feat(gis): 新增图层只读能力，默认关（OAW_MAP_READONLY）` | `update` |
| `docs: 新增 07-GIT工作流，收敛提交与发布规则` | `提交代码` |
| `chore(repo): 清理根目录一次性脚本与日志` | `111` |

### 3.3 提交前检查（缺一不可）

```powershell
git status --short                 # 逐项确认归属
git diff --stat                    # 确认改动面
npm run verify                     # L4 门禁
git diff --check                   # 空白/冲突标记
```

---

## 4. 提交粒度与 pathspec

### 4.1 规则

1. 一次提交只包含**一条工作流**的文件；同一文件混有多条工作流改动时，先拆分再提交。
2. 必须使用 pathspec：`git commit -m "…" -- <文件1> <文件2>`。
3. **禁止** `git add -A`、`git add .`、`git commit -a`。
4. 共享文件（`client/src/styles.css`、`client/src/components/ChatPanel.jsx`、`client/src/App.jsx`、`server/index.mjs`、`.gitignore`、`package.json`）提交前必须查看 `git diff` 确认每一块 hunk 都属于本工作流。
5. 混合文件的拆分方式：换出（暂存本工作流 hunk）→ 重放（切换工作流验证仍可运行）→ 换回；不允许"先整体提交回头再改"。

### 4.2 提交后自检

```powershell
git show --stat HEAD        # 文件清单是否只含本工作流
git show HEAD --name-only   # 是否误带 zz_*、*.log、临时-*、.oaw/
```

**判定**：出现非本工作流文件 → `git reset --soft HEAD~1` 后重新按 pathspec 提交（未推送时）。

---

## 5. 代码评审

### 5.1 准入条件（不满足不得发起评审）

- [ ] 分支已同步上游，`git rebase origin/main` 无冲突
- [ ] `npm run verify` 绿；改动面定向回归绿
- [ ] 变更说明含：目标 / 改动面 / 验证证据（命令或截图）/ 风险与回退方式
- [ ] 关联[功能验证测试规范](功能验证测试规范.md)的验收项与 [决策进度](../决策记录/决策进度.md) 的 D-xxx（如有决策变更）
- [ ] 新能力默认关，且验证过"关=基线一致"
- [ ] 文档已同步（进度、生效规范、ADR、变更日志）

### 5.2 评审分工

| 角色 | 关注点 | 产出 |
|---|---|---|
| 主控智能体 Leader | 需求一致性、范围蔓延、文档同步 | 自检清单 |
| 代码审计 code-auditor | 正确性、安全、性能、规范、测试有效性 | 阻断/建议/提示三级问题 |
| 独立核验 verifier | 结论与证据是否成立（对抗式） | `判定：pass/revise/fail` |
| 产品负责人 | 目标是否达成、体验是否可接受 | 通过/驳回 + 验收签字 |

### 5.3 通过标准

1. **阻断级问题 = 0**；建议级问题已逐条答复（接受/拒绝 + 理由）。
2. 验收项 T-xx 全部通过并标记日期。
3. 测试未被删除、跳过或弱化；新增分支有对应用例或可复现手测步骤。
4. 无新增硬编码色值、无 emoji 图标、无越层依赖、无新增 npm 依赖（除非 D-004 例外已批准）。
5. CI 全绿（`.github/workflows/ci.yml` 16 步）。

### 5.4 轮次与超时

- 评审最多 **2 轮**；第 2 轮仍有阻断项 → 退回重做，不得"带条件通过"。
- 评审意见 24 小时内响应；超时升级给产品负责人。
- 评审结论必须落文字（PR 评论或 `05` 记录），**口头通过无效**。

### 5.5 评审清单（逐条勾）

- [ ] 边界：空值/超长/并发/断电/权限拒绝有处理
- [ ] 安全：无密钥、无命令注入、路径校验、仅 `127.0.0.1`
- [ ] 测试：主路径 + 1 个反例；断言有实际约束力
- [ ] 样式：未触碰 Chat/Work/Review 冻结区（D-016）
- [ ] 事件：新增行为已登记事件类型
- [ ] 工具：`customTools` / `tools` / `setActiveTools` 三处对齐
- [ ] 回退：开关关闭即回到基线

---

## 6. 合并校验

### 6.1 合并前置

```powershell
git switch feature/v0.11.56-execution-handle
git fetch origin && git rebase origin/main
npm run verify
git push --force-with-lease        # 仅限本人工作分支，且 rebase 后
```

- `--force-with-lease` 只允许用于**本人未合并的工作分支**；`main` 永远禁止。
- 合并前确认目标分支 CI 绿、评审通过、无未解决评论。

### 6.2 合并方式

| 场景 | 方式 | 命令 |
|---|---|---|
| 工作分支 → `main` | `--no-ff` 合并，保留工作流边界 | `git switch main && git merge --no-ff feature/xxx` |
| 工作分支 → `develop` | 同上 | `git merge --no-ff feature/xxx` |
| 已合并分支清理 | 删除本地与远程 | `git branch -d feature/xxx`；`git push origin --delete feature/xxx` |

- 禁止 fast-forward 直推 `main`；禁止在 `main` 上直接 `commit`。
- 合并提交信息：`merge: <工作流一句话> (#<PR号>)`。

### 6.3 合并后动作

1. 再跑一次 `npm run verify`（合并态验证）。
2. 更新 [当前开发进度](../进度/当前开发进度.md)（完成项、下一步）。
3. 更新 `变更日志.md`（用户可感知的变更）。
4. 删除已合并分支；确认 `git branch -a` 无残留。
5. 推送 `main`（网络可用时）；失败按第 9 节处理，不反复重试掩盖。

---

## 7. 版本号与打标

### 7.1 版本规则

- 语义化版本 `v0.<小版本>.<补丁>`；当前基线 `v0.11.55`。
- 补丁位：仅缺陷修复、文档、内部整理；小版本位：新功能、能力变更。
- 版本号三处必须一致：`package.json` 的 `version`、`变更日志.md` 最新标题、git tag。
- `REQUIREMENTS.md` 与 `README.md` 的版本矩阵随之更新。

### 7.2 打标

```powershell
git switch main
git pull --ff-only origin main
git tag -a v0.11.56 -m "验收基线：<一句话>；T-01~T-30 通过；CI 16 步全绿"
git push origin v0.11.56
```

- **必须用附注 tag**（`-a`）；禁止轻量 tag。
- tag 一旦推送不可移动、不可删除重打；需要修正时递增补丁版本。
- 未推送的 tag 发现错误可删除重打：`git tag -d v0.11.56`。

---

## 8. 正式发布流程

| 步骤 | 动作 | 通过判定 |
|---|---|---|
| 1 | 冻结：`main` 停止合并非发布改动 | 无待合并工作分支 |
| 2 | 全量门禁：`npm run verify` + CI 16 步 | 全绿 |
| 3 | 版本三处同步（`package.json`/`变更日志.md`/README） | 文本一致 |
| 4 | 变更日志写"用户可感知变化 + 已知限制" | 非空、无内部黑话 |
| 5 | 打附注 tag 并推送 | `git tag -n` 可见说明 |
| 6 | 构建：`npm --prefix client run build` + `npm run setup` | 产出可启动 |
| 7 | 冒烟：`npm run dev` → `http://127.0.0.1:3002/api/status` | 返回 ok |
| 8 | 归档：05 记录版本与验收签字；通知使用方 | 记录可追溯 |

### 8.1 回滚预案

- 代码回滚：`git revert <合并提交>`（**不用** `reset --hard` 改写已发布历史）。
- 版本回滚：切到上一个附注 tag 重新构建，并登记 `05` 阻塞项。
- 回滚后必须补一条 `fix:` 提交说明根因，禁止静默回滚。

### 8.2 发布检查表

- [ ] 版本号/变更日志/tag 一致
- [ ] T-01~T-30 中标记"必过"的项全绿
- [ ] 无 `临时-` 文件、无 `*.log`、无 `zz_*`、无 `.oaw/`、无视频
- [ ] 密钥与 `.env` 未入库
- [ ] 服务仅监听 `127.0.0.1`
- [ ] 回滚方案已写明并演练过命令
- [ ] 05/06 已更新

---

## 9. 冲突处理

### 9.1 预防

- 工作分支**每天**同步：`git fetch origin && git rebase origin/main`。
- 小步提交，单次改动 ≤5 个文件；共享文件改动提前在 `05` 声明。
- 不在同一分支混做两条工作流。

### 9.2 标准步骤

```powershell
git status                          # 确认冲突文件
git diff --name-only --diff-filter=U
# 逐文件打开，理解双方意图后再改；禁止整块选 ours/theirs 了事
git add <已解决文件>
git rebase --continue               # 或 git merge --continue
npm run verify                      # 冲突解决后必须全量验证
```

### 9.3 共享文件冲突专项

| 文件 | 处理要点 |
|---|---|
| `client/src/styles.css` | 按选择器块合并；不得改动冻结区样式（D-016） |
| `client/src/components/ChatPanel.jsx` | 按功能块合并；引用徽章/发送清空逻辑不可丢 |
| `client/src/App.jsx` | 保留双方页签与画布挂载，CSS 显隐不卸载 |
| `server/index.mjs` | 路由按路径合并；文档路由必须保持正则写法 |
| `.gitignore` | 取并集，不删除他人规则 |
| `package.json` | 依赖取并集；**新增任何依赖先按 D-004 评审** |

### 9.4 失败处置

- 冲突解决超过 30 分钟无进展：`git rebase --abort`，保留现场，找对方确认意图。
- 解决后测试红：回到冲突前状态（`git rebase --abort`），改用"先合并上游再重做本工作流"策略。

---

## 10. 角色与仓库权限

| 操作 | 产品负责人 | Leader | worker（子代理） | code-auditor / verifier | Ops |
|---|---|---|---|---|---|
| `status/diff/log/show` | ✅ | ✅ | ✅ | ✅ | ✅ |
| 建/切工作分支 | ✅ | 需明确要求 | ❌ | ❌ | ❌ |
| `add/commit` | ✅ | 须用户确认 | ❌ | ❌ | ❌ |
| `rebase` 工作分支 | ✅ | 须用户确认 | ❌ | ❌ | ❌ |
| 合并到 `main` | ✅ | 须用户确认 | ❌ | ❌ | ❌ |
| 打 tag / 发布 | ✅ | 须用户确认 | ❌ | ❌ | ❌ |
| `push` | ✅ | 须用户确认 | ❌ | ❌ | ❌ |
| `push --force` / 改历史 | 仅未推送工作分支 | **禁止** | 禁止 | 禁止 | 禁止 |
| 删除分支/tag | ✅ | 须用户确认 | ❌ | ❌ | ❌ |
| 服务启停/健康检查 | ✅ | ✅ | ❌ | ❌ | ✅ |

- 凭证：`gh`/`git` 使用本人凭证；**禁止共享 token、禁止把凭证写入仓库或日志**。
- 保护分支（GitHub 侧建议）：`main` 要求 PR + 1 名评审 + CI 绿，禁止强推与删除。
- 子代理不得直接操作 Git；所有 Git 动作由 Leader 汇总后执行并留痕。

---

## 11. 仓库卫生

### 11.1 必不入库

`.oaw/`、`office-workspace/` 用户文档、运行日志 `*.log`、构建产物 `dist/`、`node_modules/`、`临时-*`、`zz_*`、`_t.txt`、`*.bak`、`.env`、密钥、视频/音频大文件、一次性脚本产物、`.playwright-cli/`、`.agent-context*.md`。

### 11.2 大文件与 LFS

- 单文件 >5 MB 入库需评审；>50 MB 一律 LFS 或外链。
- 现有 LFS：`*.webm`、`*.zip`、`*.pptx`、`*.docx`；新增二进制类型先更新 `.gitattributes` 并说明。
- 生成物（瓦片、缓存、报告中间件）不入库，用脚本重建。

### 11.3 卫生巡检

```powershell
git ls-files | Measure-Object -Line                 # 跟踪文件总数趋势
git status --short                                  # 未跟踪垃圾
git ls-files -z | ForEach-Object { ... }            # 按需筛查大文件
```

发现新增垃圾 → 同轮清理，不留到下一轮。

---

## 12. 标准操作手册（可直接复制）

### 12.1 新功能

```powershell
git switch main; git pull --ff-only origin main
git switch -c feature/v0.11.56-<语义>
# 开发 → npm run verify → 定向回归
git commit -m "feat(<范围>): <描述>" -- <文件列表>
git push -u origin feature/v0.11.56-<语义>
# 评审通过 → 合并 --no-ff → 再验证 → 更新 05/变更日志 → 删除分支
```

### 12.2 缺陷修复

```powershell
git switch -c fix/<语义>
# 写失败测试 → 修 → 测试变绿 → npm run verify
git commit -m "fix(<范围>): <根因与修复>" -- <文件列表>
```

### 12.3 紧急修复

```powershell
git switch main; git switch -c hotfix/<语义>
# 修复 + 最小验证
git commit -m "fix(<范围>): <描述>" -- <文件列表>
# 合并 main → 打补丁 tag → 回合工作分支
```

### 12.4 回滚一次合并

```powershell
git switch main
git revert -m 1 <merge-commit>
npm run verify
git commit --amend --no-edit        # 仅在未推送时允许
git push origin main
```

---

## 13. 违规处理

| 级别 | 情形 | 处理 |
|---|---|---|
| 阻断 | 直推 `main`、强推已推送分支、提交密钥、跳过门禁 | 立即停止、回滚、登记 `05` 阻塞项、产品负责人裁决 |
| 严重 | 提交混入多工作流、删除/弱化测试、未评审合并 | 撤销提交重做，补评审记录 |
| 一般 | 提交信息不合规、分支命名不规范、垃圾文件入库 | 同轮修正，不重复犯 |

连续两次同类严重违规：暂停该角色提交权限，直到重新走查第 5 节清单。

---

## 14. 附录

### 14.1 提交信息模板

```
<类型>(<范围>): <为什么 + 做了什么>

- 改动点：
- 验证：
- 风险/回退：

Refs: T-xx, D-xxx
```

### 14.2 PR / 合并请求模板

```markdown
## 目标
<!-- 一句话 -->

## 改动面
- [ ] server / client / docs / ci

## 验证证据
<!-- 命令输出、截图、runId -->

## 验收项
- T-xx 通过 / 未通过

## 风险与回退
<!-- 开关名、回滚命令 -->

## 合规自检
- [ ] 默认关且基线一致
- [ ] 未触碰样式冻结区
- [ ] 无新增依赖
- [ ] 文档已同步（05/02/04/06）
```

### 14.3 常用命令速查

| 目的 | 命令 |
|---|---|
| 同步上游 | `git fetch origin && git rebase origin/main` |
| 查看待提交 | `git status --short`、`git diff --stat` |
| 精确提交 | `git commit -m "…" -- <文件…>` |
| 撤销未推送提交 | `git reset --soft HEAD~1` |
| 查看 tag 说明 | `git tag -n` |
| 删除已合并分支 | `git branch -d <分支>`；`git push origin --delete <分支>` |
