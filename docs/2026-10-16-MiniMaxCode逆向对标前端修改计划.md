# Open Plan 前端修改计划 · MiniMax Code 逆向对标

> 制定日期：2026-10-16 · 版本 v1.0 · 归属：open-plan（网页端）仓库自身迭代批次
> 依据：《2026-10-16-MiniMaxCode逆向分析.md》（openplan-desktop/docs）全部设计发现
> 与桌面端推进表关系：本计划即推进表 W2-W8 中"网页端能力线"的前端细化，批次号沿用（T-4xx/T-6xx）
> 事实基线：client/src/styles.css 单文件 5600+ 行；动画命名无 token（spin/blink/brain-pulse/breathe 等 20+ 种各自为政）；色彩仅 --accent/--warning 等语义变量、无色阶体系；存在 components/桌面端Agent原型.css 原型稿

---

## 〇、工程红线（每批次验收前置检查）

| # | 红线 | 来源 |
|---|---|---|
| R1 | styles.css **P3·统一动效闸门**标记之后只允许 `none` 与 `oaw-*` 动画；新动效一律用 oaw-* 关键帧或置于闸门标记之前 | 项目既有硬约束 |
| R2 | 新能力全部置于 `OAW_*` flag 之后（server/运行开关.mjs → /api/status runtimeFlags → client/src/运行开关.js 只读消费，快照未达=全关=基线） | 项目既有管道 |
| R3 | 新增 npm 依赖需评审（当前原则：能用现有依赖/CSS 实现就不新增） | 工程惯例 |
| R4 | 本计划全部改动落在 open-plan 仓库自身迭代；桌面端（openplan-desktop）通过 HTTP/SSE 消费，零侵入 | 解耦铁律 |

---

## P0 · 设计 Token 基座（对齐 MCODE 色阶/字体体系）

**对标来源**：MCODE 154 个 `{色名}_{13阶}` 色板变量 + 8 组明暗语义参考色 + 三层字体栈 + diff 主题 token。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F01 | 新建 `client/src/styles/tokens.less`：13 阶色板（25/50/75/100/200/300/400/500/600/700/800/900/1000），首批 5 色（blue/cyan/green/gray/gold）+ 8 组明暗语义参考色，编译产出 CSS 变量挂 `:root[data-theme]` | tokens.less（新）、styles.css 头部引入 | 变量经 Vite 编译可见于产物；现有 --accent 等**保持原值不变**（token 映射而非替换，零视觉回归） |
| T-F02 | 字体栈升级：UI 栈 `"HarmonyOS Sans", "Segoe UI", "SF Pro Display", -apple-system...`；代码栈 `"JetBrains Mono", Consolas, monospace`（JetBrains Mono 走可选本地字体探测，不强依赖） | tokens.less（--oaw-font-ui / --oaw-font-mono）、styles.css 全局替换 font-family 引用 | 对话代码块/工具输出使用等宽栈；无 FOUT 闪动 |
| T-F03 | 语义变量重挂：`--accent`/`--warning`/`--danger` 等**改由 token 派生**（如 --accent: var(--oaw-green-600)），保证现有组件零改动获得色阶能力 | styles.css 变量定义区 | 全站截图对比无色差 |
| T-F04 | diff 主题 token：`--oaw-diff-add-bg/fg`（绿 25 底 / 绿 500 字）、`--oaw-diff-attr`（蓝 500）——为产物 diff/编辑器预览备 | tokens.less | diff 预览组件可消费 |

**Flag**：无（纯基座，零行为变化）· **批次**：W2 · **依赖**：无 · **预估文件**：2 改 1 增

## P1 · 动效体系统一（闸门内 oaw-* 扩编）

**对标来源**：MCODE 动效参数表（dropdown-in .18s cubic-bezier(.08,.82,.17,1)；modal 上滑 20px+opacity；shimmer 骨架屏 var(--shimmer-duration)；spin 1s；pulse 2s@50% .5）。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F11 | 建立动效 token：`--oaw-dur-fast:.18s / --oaw-dur-base:.25s / --oaw-dur-slow:.4s`；`--oaw-ease-spring:cubic-bezier(.08,.82,.17,1)`、`--oaw-ease-out:cubic-bezier(.4,0,.2,1)` | tokens.less | 闸门区新增关键帧全部引用 token |
| T-F12 | 闸门内新增 oaw-* 关键帧（置入闸门标记前的公共区）：`oaw-dropdown-in`（scaleY .8→1）、`oaw-modal-in/out`（translateY(20px)+opacity）、`oaw-shimmer`（背景位移动画，供骨架屏）、`oaw-fade-in/out` | styles.css（闸门前） | R1 检查通过；`@keyframes` 非 oaw 命名零新增 |
| T-F13 | 骨架屏组件：`Skeleton.jsx`（shimmer 骨架，替换现有 spinner 式加载的**新增场景**；存量 spinner 不强制迁移） | Skeleton.jsx（新）、按需引入 | 新增加载场景 100% 用骨架屏 |
| T-F14 | 存量动画治理（只梳理不强制改）：输出 styles.css 现存 20+ 动画名清单与归类表（保留/映射 oaw-*/废弃），作为后续批次输入 | 文档：动效清单 | 清单完整覆盖全部 @keyframes |

**Flag**：OAW_SKELETON（骨架屏开关）· **批次**：W2-W3 · **依赖**：T-F01 · **预估文件**：3 改 2 增

## P1.5 · 外观/主题状态机（MCODE desktop-appearance 模式移植）

**对标来源**：不可变快照 + normalize + 按字段 patch + structuredClone 克隆广播；typography 独立模块。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F21 | `appearance.js` 状态机：DEFAULT_APPEARANCE_STATE + normalize + mergePatch（按字段合并，单控件提交不重置兄弟偏好）+ 订阅广播（listener 异常吞掉） | client/src/外观状态.js（新） | 单测：patch 合并/拒绝非法值/广播克隆 |
| T-F22 | 设置面板接入：主题（亮/暗/跟随系统）、字号缩放（--oaw-font-scale 挂 html data 属性）、密度三控件走状态机提交 | SettingsPanel.jsx | 切换即时生效、刷新持久化（localStorage） |
| T-F23 | 暗色主题第一批：tokens.less 补 `[data-theme="dark"]` 色板映射（gray 阶反转 + 语义色明暗双值） | tokens.less | 全核心页面暗色走查无对比度缺陷 |

**Flag**：OAW_THEME_V2 · **批次**：W3-W4 · **依赖**：T-F01/F02 · **预估文件**：2 改 2 增

## P2 · 会话体验增强

**对标来源**：archon-mini-chat 迷你窗、RUNTIME_CHECK_READY 挂载就绪轮询、语音 ASR（rnnoise 降噪）、会话内配置通道（applied:false 拒绝语义）。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F31 | 会话列表虚拟化与搜索：SessionSidebar 长列表虚拟渲染 + 会话内全量消息搜索（对齐 MCODE"搜索索引完整覆盖当前会话"） | SessionSidebar.jsx、ChatPanel.jsx | 500+ 会话滚动 60fps；搜索 <100ms（千条消息） |
| T-F32 | 迷你对话浮窗（mini-chat）：从任意 Tab 呼出悬浮小窗继续当前会话（桌面端形态下由托盘唤起） | 新 MiniChatPanel.jsx + App.jsx 挂载点 | 浮窗内完整对话能力；与主窗口状态同步 |
| T-F33 | 语音输入：Web Speech API 优先 + 服务端 ASR 通道预留（依赖服务端批次，前端先做 UI 与降级链） | ChatPanel 输入区 | 按住说话→文本入框；不支持环境自动隐藏入口 |
| T-F34 | 启动就绪轮询：应用挂载即轮询 runtime 就绪态（对齐 RUNTIME_CHECK_READY），未就绪显示骨架屏（T-F13）而非空白 | App.jsx | 冷启动无白屏期；就绪即渲染 |

**Flag**：OAW_MINI_CHAT / OAW_VOICE_INPUT · **批次**：W4-W5 · **依赖**：P1 骨架屏 · **预估文件**：3 改 3 增

## P3 · 产物预览升级

**对标来源**：MCODE doc/docx/pdf/office 独立预览路由 + artifact 协议（artifact-key/path/authority）+ 代码 diff 主题。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F41 | HTML Artifacts 预览（既有 M2 计划 T-402/503 的前端细化）：产物面板新增 html Tab；`iframe srcdoc` 沙箱 + 重定向守卫（15 跳/4s）+ 焦点守卫 + 资产归一化——守卫清单照逆向文档 §4.2 | 工作产物面板.jsx、新 HtmlPreview.jsx | 守卫单测过；恶意页面不逃逸不冻结 |
| T-F42 | 预览路由化：docx/pptx/xlsx/pdf/html 五类产物统一走 `#/preview/:artifactId` 路由页（可独立窗口/分享），Viewer 组件复用 | App.jsx 路由、各 Viewer | 五类产物路由直达渲染一致 |
| T-F43 | diff 渲染主题化：代码 diff 消费 T-F04 的 diff token（增行绿 25 底/绿 500 字、属性蓝 500） | diff 相关组件 | 明暗两主题下 diff 可读 |

**Flag**：OAW_HTML_PREVIEW / OAW_PREVIEW_ROUTE · **批次**：W4-W6（对齐 T-402/T-503/T-603）· **依赖**：P0 token · **预估文件**：4 改 3 增

## P4 · 开发者体验（依赖服务端批次的前端侧）

**对标来源**：LocalServerRegistry（终端输出→dev server 自动发现）、node-pty 终端、miniApp 合成器。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F44 | 终端面板：工作区内嵌终端 Tab（服务端 node-pty 批次 T-604 前端侧；xterm.js 引入需评审 R3，备选：只读输出流） | 新 TerminalPanel.jsx | 终端可交互/只读双模式 |
| T-F45 | dev server 发现入口：消费服务端 LocalServerRegistry 事件（对齐逆向 §3.3），终端内检测到的本地服务显示为可点击预览 Chip（在线优先排序） | TerminalPanel.jsx、工作产物面板 | URL 跨 chunk 不误报；离线置灰 |
| T-F46 | miniApp 合成器预留：浏览器面板内嵌 mini 应用 surface 的 UI 容器（对齐 miniapp-surface/composer） | 内置浏览器面板 | 容器协议就绪 |

**Flag**：OAW_TERMINAL / OAW_DEV_SERVER_DISCOVERY · **批次**：W6（对齐 T-604）· **依赖**：服务端批次 · **预估文件**：2 改 3 增

## P5 · 健壮性与可观测

**对标来源**：crash-evidence-session.json（会话级崩溃关联）、RUNTIME 失败带 deviceInfo、桌面端 stability.ts 对应的前端侧。

| ID | 任务 | 改动文件 | 验收标准 |
|---|---|---|---|
| T-F51 | 全局错误边界：App/ChatPanel/产物面板三处 ErrorBoundary + 兜底 UI（复用 Feedback 基座），捕获渲染异常不白屏 | App.jsx、新 ErrorBoundary.jsx | 注入型异常页面可恢复 |
| T-F52 | console 治理：接入桌面端 stability 的 console 捕获后（source:line），清理 styles/组件层遗留告警；**missing } after argument list 待运行期捕获定位后专项修复** | 按定位结果 | 控制台 error 级归零 |
| T-F53 | 用户操作会话关联：前端埋点带 session 标识（对齐 crash-evidence 的 app_instance_id 模式），崩溃日志可回溯操作路径 | 运行开关.js、埋点工具 | 崩溃日志含 session id |

**Flag**：OAW_ERROR_BOUNDARY · **批次**：W5-W7 · **依赖**：无 · **预估文件**：3 改 2 增

---

## 批次排期总表（对齐桌面端推进表网页端能力线）

| 周次 | 批次 | 任务 | 对应推进表 |
|---|---|---|---|
| W2 | P0 基座 | T-F01~04（token/字体/语义重挂/diff 主题） | T-201 同期 |
| W2-W3 | P1 动效 | T-F11~14（token/关键帧/骨架屏/存量清单） | 新增 |
| W3-W4 | P1.5 主题 | T-F21~23（状态机/设置/暗色） | 新增 |
| W4-W5 | P2 会话 | T-F31~34（虚拟化搜索/迷你窗/语音/就绪轮询） | T-401 同期 |
| W4-W6 | P3 预览 | T-F41~43（HTML 沙箱/路由化/diff 主题化） | T-402/T-503 |
| W6 | P4 开发者体验 | T-F44~46（终端/发现/miniApp 容器） | T-604 同期 |
| W5-W7 | P5 健壮性 | T-F51~53（边界/治理/会话关联） | 新增 |

**依赖链**：P0 → P1 → P1.5 →（P2/P3/P4 并行）→ P5 横切。全部批次走 R2 flag 管道，独立发版独立回滚。

## 验收口径汇总

1. 每批次：`npm run build` 通过 + 手工走查清单 + flag 关闭态与基线像素级一致
2. P0/P1：动效闸门 R1 检查脚本化（grep 断言：闸门后无非 oaw 动画）
3. P1.5：明暗双主题全页走查截图留档
4. P2：500 会话/千条消息性能实测达标
5. P3：五类产物路由渲染一致性 + 守卫单测
6. 全程：`missing }` 经捕获定位后归零

## 风险

| 风险 | 对策 |
|---|---|
| styles.css 单文件膨胀失控 | P0 起新增样式一律进 tokens/独立组件样式文件；styles.css 只减不增 |
| xterm.js 等新依赖引入 | 走 R3 评审，备选只读方案 |
| `missing }` 来源不明 | 桌面端 console 捕获已就绪，运行期定位后进 T-F52 专项 |
| 暗色主题工作量大 | 只做第一批核心页（对话/产物/设置），其余渐进 |
