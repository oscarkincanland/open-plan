# 桌面端（Electron 外壳）

> 依据：[ADR 0024](../docs/决策记录/0024-桌面端采用壳优先与平台适配层.md)、[计划 023](../docs/plans/2026-11-06-023-桌面端完整修改计划（0.13.x）.md)

## 这是什么

**壳优先**：Electron 主进程 `import` 现有的 `server/index.mjs`（不重写后端），窗口加载
现有的 `client/dist`（不重写前端）。差异只发生在「外壳 + 平台适配层」。

```
GuiJu.exe (Electron main)
├─ src/main.cjs            单实例锁 / 窗口 / 生命周期 / 原生 IPC
├─ src/浏览器视图.mjs      内嵌浏览器视图（WebContentsView + webdriver debugger）
├─ src/preload.cjs         contextBridge 白名单桥（不暴露 ipcRenderer）
└─ server/服务入口.mjs     随机端口 + token → import server/index.mjs
```

## 开发与构建

```powershell
npm run build            # 1) 构建前端（桌面端加载 client/dist）
npm run desktop:dev      # 2) 启动桌面端（开发态）
npm run desktop:dist     # 3) 出 NSIS 安装包（已内置受限环境规避逻辑）
npm run desktop:zip      # 4) 出便携 ZIP（免安装，解压双击 GuiJu.exe）
npm run desktop:smoke    # 5) 冒烟：对打包目录真发 HTTP 请求（28 项）
```

产物（`desktop/dist-app/`）：

| 文件 | 说明 |
|---|---|
| `GuiJu-Setup-<version>.exe` | NSIS 安装包（per-user，可选安装目录） |
| `GuiJu-<version>-portable-x64.zip` | 便携版（解压即用） |
| `win-unpacked/GuiJu.exe` | 目录版（调试用） |

### 受限环境四个坑（已固化进 `scripts/桌面/构建安装包.mjs`）

1. **缓存目录**：`ELECTRON_BUILDER_CACHE` 指到 `desktop/.cache-builder`（默认写 `%LOCALAPPDATA%` 会被拒）；
2. **临时目录**：`TMP`/`TEMP` 指到 `desktop/.nsis-tmp`（否则 makensis 报 `!tempfile: Unable to create temporary file!`）；
3. **压缩方式**：`--config.compression=store`（solid 压缩需 ~120MB mmap，受限环境报 `error creating mmap`）；
4. **GUI/安装器本身**：受限沙箱不允许启动 GUI 进程与安装副作用 → 窗口与安装必须在真实桌面环境验证。

另外：若环境里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node（窗口起不来），构建/启动前需清除。

## 平台差异在哪

| 能力 | web 形态 | 桌面形态 | 落点 |
|---|---|---|---|
| 文件/目录选择 | `<input type=file>` / 服务端 | 原生对话框 | `client/src/平台/文件对话框.js` |
| 系统打开/定位 | `/api/native/*` | `shell.openPath` | `client/src/平台/外部打开.js` |
| 内置浏览器 | 系统 Edge + CDP 帧流 | 内嵌视图（无帧流） | `server/平台/浏览器驱动.mjs` |
| officecli / LibreDWG | 仓库 `bin/` 或 PATH | `resources/bin` | `server/平台/外部二进制.mjs` |
| 启动/退出 | 独立进程 + 监督脚本 | 主进程生命周期 | `server/平台/生命周期.mjs` |

**业务代码只问能力、不问形态**：`if (平台能力.原生文件对话框) …`，而不是 `if (isDesktop) …`。

> 桌面形态的内置浏览器由 `WebContentsView` 原生绘制，DOM 层的 Agent 虚拟鼠标/动作气泡会被原生视图遮挡；
> Agent 访问了哪些网站以“会话流 · 浏览器任务卡”和“浏览器面板 · 操作记录”为准（两者都是普通前端渲染）。

## 边界与门禁

`npm run test:platform-boundary`（已并入 `npm run verify`）会拦下：

1. `client/`、`server/` 出现 `electron` 依赖（平台层除外）；
2. 前端直接使用 `window.require` / `ipcRenderer` / `process.versions.electron`；
3. `desktop/` 出现壳文件白名单以外的文件（疑似复制业务实现）；
4. `server/` 写死本机项目路径或当前用户目录；
5. 平台层反向依赖业务模块。

## 回退

- 桌面端异常 → 直接 `npm start`（web 形态完全不变）；
- 内嵌浏览器异常 → `OAW_BROWSER_DRIVER=system` 回到系统 Edge + 帧流；
- 打包体积超标 → 调整 `electron-builder.yml` 的 extraResources 过滤。

## 随包二进制

`bin/` 被 `.gitignore` 忽略，只有 `bin/清单.json` 入库（文件名 + 版本 + sha256 + 来源）。

```powershell
npm run desktop:prepare            # 按清单准备并校验（缺失且无 url 则失败）
node scripts/桌面/准备随包二进制.mjs --write   # 用现有 bin/ 文件回写 sha256
```

**能力边界**（LibreDWG 随包、ODA 不随包）：

| 能力 | 随包 LibreDWG | 需要 ODA（未随包） |
|---|---|---|
| DWG 预览 / Agent 读取 | ✅ | — |
| DWG 原格式写回 | ❌ 另存 `-修改.dxf` | ✅ |

## 已知限制

- 本仓库开发环境（沙箱）**无法启动 GUI**：`electron --version` 无输出，
  因此桌面窗口与内嵌浏览器视图的**运行时行为未在本环境实测**。
  已验证的是：服务入口真实可起（随机端口 + token + SPA 200 + 未授权 401）、
  外壳接线与打包配置的契约测试（`npm run test:desktop`，9 项）。
- 需要 `ELECTRON_RUN_AS_NODE` 未设置（否则 Electron 会退化成纯 Node）。
- 若 Electron 二进制下载失败（GitHub 不通），用镜像：
  `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`。
- 打包已用 `electronDist: node_modules/electron/dist` 复用本地 Electron，避免重复下载。


## 冒烟验证

`npm run desktop:smoke` 不启动 GUI，而是对**打包目录内的服务**真实发请求，覆盖：

- 产物结构（8 项）：`GuiJu.exe`、`app.asar`、`server/index.mjs`、`服务器入口`、`client/dist/index.html`、`scripts/lib/tiler.mjs`、`node_modules/express`、`bin/清单.json`
- 服务（2 项）：随机端口、API token
- SPA（5 项）：`GET /` 200 + HTML + `#root` + 资源引用 + 资源可加载
- API（5 项）：status / sessions / workspaces / models / browser/state 全 200
- 鉴权（1 项）：无 token → 401
- 运行开关（3 项）：`cadPreview=true`、`cadAgent=false`、status 可解析
- 外部二进制（2 项）：解析到 `resources/bin`
- 浏览器驱动（2 项）：未注入宿主时回落 `system`
