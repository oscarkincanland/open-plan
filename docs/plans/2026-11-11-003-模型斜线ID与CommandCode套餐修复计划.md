# 模型斜线 ID 与 Command Code 套餐修复计划

> 文档类型：缺陷修复 + 套餐补充实施计划（**已实施，2026-11-11**；实施记录见 [2026-11-11-003-实施记录](2026-11-11-003-实施记录.md)）
> 日期：2026-11-11　计划号：2026-11-11-003
> 基线：v0.13.25（`develop @ f433b852`）
> 关联：`REQUIREMENTS.md` **R15 模型供应商与配置**、`DESIGN.md` §7.1 模型页、[2026-11-11-002 模型供应商自主添加与自定义模型管理修改计划](2026-11-11-002-模型供应商自主添加与自定义模型管理修改计划.md)
> 用户输入：① 模型配置里加 Command Code 套餐；② Command Code 的模型名带 `/` 被拒是 bug；③ 测一下已添加的 zjic 模型并尝试修复。
> 实施口径：确认弹窗未收到用户选择，按推荐项（斜线校验 + Command Code 套餐 + 按模型协议路由）继续；zjic 只出诊断结论，不改配置。

---

## 0. 结论先行

| # | 结论 | 证据 |
|---|---|---|
| 1 | **`/` 被拒是后端校验过严，不是 Pi 限制**。`validateModelConfigInput` 用 `^[^/\\\s]{1,160}$` 直接拒绝斜线，接口返回 400。 | `server/index.mjs:1801`；本轮接口复现 |
| 2 | **Pi 运行时支持模型 ID 含斜线**，按第一个 `/` 切 provider，剩余部分整体作为模型 ID。 | `server/agent.mjs:7701-7715`；模型目录按 `provider + "/" + id` 组装，见 `server/agent.mjs:7836-7875` |
| 3 | **Command Code 目录里 97 个模型有 73 个 ID 带 `/`**，且 Claude 与 GPT 走不同协议；单一 provider 级 `api` 会让 Claude 模型失败。 | 本轮实测 `/provider/v1/models`；`supported_endpoints` 统计 |
| 4 | **Command Code 尚未登记为套餐**，`PLAN_PRESETS` 目前只有 OpenCode Zen Go。 | `server/套餐目录.mjs:10-24` |
| 5 | **zjic 模型不是配置错误，是目标地址当前不可达**：`172.17.114.48` ping 100% 丢包，80/443/8000/8080/11434/30000 全部连不上；应用内探测为 `Connect Timeout Error (attempted address: 172.17.114.48:80)`。 | 本轮实测；配置与凭据均在 |

---

## 1. 取证

### 1.1 斜线模型 ID 被拒（已复现）

```text
POST /api/agent/model-configs
{"provider":"zz-probe-test","api":"openai-completions","baseUrl":"https://example.com/v1",
 "models":[{"id":"deepseek/deepseek-v4-flash","name":"DeepSeek V4 Flash"}]}

→ HTTP 400
{"ok":false,"error":"模型 ID 不能为空，且不能包含斜线或空格","code":"MODEL_CONFIG_INVALID"}
```

同类限制还有一处 legacy 接口：

- `server/index.mjs:1801`：`validateModelConfigInput`，服务 `/api/agent/model-configs`。
- `server/index.mjs:2218`：`POST /api/agent/custom-provider`，legacy 单模型接口（前端已不调用，但外部脚本可能用）。

运行时的实际约定（不是“不能有斜线”）：

```js
// server/agent.mjs:7701
// 模型 id 本身可能含斜线（如 command-code 的 deepseek/deepseek-v4-flash）：
// 只能按第一个斜线切分 provider，否则 id 会被截断成 deepseek 并报 model not found。
const specSeparator = specText.indexOf("/");
const provider = specText.slice(0, specSeparator);
const id = specText.slice(specSeparator + 1);
```

`_buildModelCatalog` 也用 `m.provider + "/" + m.id` 生成目录 ID，`/api/models` 的能力补全按第一个 `/` 截取模型 ID。斜线在运行链路是通的，只有保存校验挡住。

### 1.2 Command Code 目录与协议差异

本轮直接请求公开目录 `https://api.commandcode.ai/provider/v1/models`：

- HTTP 200，97 个模型；73 个 ID 含 `/`（如 `deepseek/deepseek-v4-flash`、`Qwen/Qwen3.8-27B`）。
- 12 个模型只声明 `/messages`（Claude 系列）；85 个声明 `/chat/completions`；无“只支持 `/responses`”的模型。
- 三个路径均存在且未带 Key 返回 401：
  - `POST /provider/v1/messages` → 401
  - `POST /provider/v1/chat/completions` → 401
  - `POST /provider/v1/responses` → 401
  - `POST /provider/v1/v1/messages` → 404（证明 Anthropic 协议会在 baseUrl 后追加 `/v1/messages`）

因此同一个供应商下：

| 模型 | api | 需要的 model.baseUrl |
|---|---|---|
| Claude 系列 | `anthropic-messages` | `https://api.commandcode.ai/provider`（SDK 再追加 `/v1/messages`） |
| GPT / DeepSeek / Qwen / GLM 等 | `openai-completions` | `https://api.commandcode.ai/provider/v1`（SDK 再追加 `/chat/completions`） |

Pi 支持 model 级 `api` 与 `baseUrl` 覆盖（`node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md:120`：模型级 baseUrl 优先于 provider 端点；内置目录里 42 个 provider 已有 model 级 api 覆盖）。

### 1.3 zjic 模型测试

当前生效配置（`.oaw/规聚/模型配置.json`）：

```text
zjicapi | name=zjic | api=openai-completions | baseUrl=http://172.17.114.48/v1
models=DeepSeek-V4.1-Flash-1017, Qwen3.8-27B
凭据：zjicapi 存在 api_key（未输出明文）
```

运行态：

- `GET /api/models` 能看到 `zjicapi/DeepSeek-V4.1-Flash-1017` 与 `zjicapi/Qwen3.8-27B`，`available:true`，上下文 128000。
- `POST /api/agent/model/probe` 返回：
  `Connect Timeout Error (attempted address: 172.17.114.48:80, timeout: 10000ms)`。
- 直连 `http://172.17.114.48/v1/models` 超时；`ping` 100% 丢包；`tracert` 仅到 `172.19.30.1 → 100.1.1.249 → 192.168.5.1` 后无后续。
- 本机地址 `172.19.30.250/24`，目标 `172.17.114.48` 不在同网段；80/443/8000/8080/11434/30000 全部不可达。

**结论**：配置字段、模型 ID（不含斜线）、凭据保存链路都正常；失败发生在 TCP 连接阶段，属于网络/VPN/目标服务不可达，不是本仓库代码可修复的缺陷。需要用户确认该内网地址在当前网络是否可达（或提供正确地址/端口）。

---

## 2. 范围

### 2.1 本次要做

- **D1 模型 ID 允许 `/`**：新增/编辑自定义供应商、legacy 单模型接口、套餐接入统一使用同一套模型 ID 规则；仍拒绝空白、反斜线、首尾 `/`、`//`、`.`/`..` 路径段。
- **D2 新增 Command Code 套餐**：在 `PLAN_PRESETS` 登记；远程拉取模型目录时按 `supported_endpoints` 为每个模型写入 `api`、`baseUrl`、`contextWindow`；接入后 Claude 与 OpenAI 兼容模型分别走正确协议。
- **D3 zjic 只出测试结论**：不修改配置、不猜地址；给出复测步骤。若用户提供可达地址，再单独改配置。

### 2.2 非目标

- 不新增供应商协议插件，不改 Pi SDK / `node_modules`。
- 不改套餐购买、价格、权益文案（不虚构价格）。
- 不自动探测内网、不扫描用户网络、不改用户已有 zjic 凭据。
- 不改变模型切换、默认模型、会话隔离语义。

---

## 3. 设计

### 3.1 D1：模型 ID 校验规则

新增 `server/模型标识.mjs`（纯函数，无副作用）：

```js
export function normalizeModelId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 160) return null;
  if (/[\s\\\u0000-\u001f]/.test(id)) return null;   // 空白/反斜线/控制字符
  if (id.startsWith("/") || id.endsWith("/")) return null;
  if (id.includes("//")) return null;
  if (id.split("/").some((part) => part === "." || part === "..")) return null;
  return id;
}
```

调用点：

| 文件 | 改动 |
|---|---|
| `server/index.mjs` `validateModelConfigInput` | 用 `normalizeModelId` 替换 `^[^/\\\s]{1,160}$`；错误文案改为“模型 ID 不能为空，且不能包含空格、反斜线或路径穿越” |
| `server/index.mjs` `/api/agent/custom-provider`（legacy） | 同上，保持两条保存路径规则一致 |
| `server/套餐目录.mjs` `applyPlan` | 对显式传入的 `modelIds` 逐个校验；非法 ID 返回 `{ok:false,error}`，不写配置 |
| `server/index.mjs` POST 上下文自动补全 | 先按完整模型 ID 精确匹配内置目录，再回退“最后一段匹配”，避免斜线 ID 误配 |

前端无需改：`模型设置页.jsx` 的“添加模型”只校验非空；展示名（`name`）本来就允许任意文本。

### 3.2 D2：Command Code 套餐

在 `server/套餐目录.mjs` 的 `PLAN_PRESETS` 增加：

```js
{
  planId: "command-code",
  name: "Command Code",
  vendor: "commandcode.ai",
  description: "Command Code 订阅计划：一个 API Key 访问 Claude、GPT、DeepSeek、Qwen、GLM 等模型；模型目录公开可拉取。",
  api: "openai-completions",
  baseUrl: "https://api.commandcode.ai/provider/v1",
  authType: "api_key",
  keyUrl: "https://commandcode.ai/",
  modelsSource: "remote",
  // 模型级协议覆盖：按 supported_endpoints 选择 api 与 baseUrl
  endpointBaseUrls: {
    "/messages": "https://api.commandcode.ai/provider",
    "/chat/completions": "https://api.commandcode.ai/provider/v1",
    "/responses": "https://api.commandcode.ai/provider/v1",
  },
}
```

`fetchPlanModels` 扩展（保持旧套餐行为不变）：

- 仍请求 `${baseUrl}/models`，仍兼容 `data[]`。
- 每个模型额外返回：
  - `name`：优先 `m.name`，否则 `m.id`；
  - `contextWindow`：`m.context_length` / `m.contextWindow`（正整数才带）；
  - `api` / `baseUrl`：仅当模型声明 `supported_endpoints` 时，按优先级 `/chat/completions` → `/responses` → `/messages` 选择；未声明的套餐继续用 preset 的 `api`/`baseUrl`。
- 映射表：

```js
const ENDPOINT_API = {
  "/chat/completions": "openai-completions",
  "/responses": "openai-responses",
  "/messages": "anthropic-messages",
};
```

`applyPlan` 扩展：

- 若 `modelIds` 为空，照旧拉全量目录。
- 拉一次目录得到 `metaById`；勾选模型按 `id` 合并 `name/api/baseUrl/contextWindow`。
- 目录拉取失败时回退 preset 的 `api/baseUrl` 与 `contextWindow: 128000`（现有行为），不阻断接入。
- 每个模型写入 `{ id, name, api, baseUrl, contextWindow, enabled, reasoning, input }`；保留现有 `planMeta`。
- 校验每个 `id`（`normalizeModelId`），非法时返回明确错误。

前端无需新增接口：模型勾选列表已经展示 `name` 与 `id`；接入后 `模型设置页` 的“管理模型”可看到每条记录。

### 3.3 D3：zjic

不改代码。交付时给出：

1. 复测命令（应用内“测试连接”或 `POST /api/agent/model/probe`）。
2. 判定标准：若仍 `Connect Timeout`，检查 VPN/内网路由/目标服务；若返回 401/404，再按协议或路径修正配置。
3. 若用户提供可达地址，再更新 `zjicapi.baseUrl`（属运行时配置，不进仓库）。

---

## 4. 文件级改动清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `server/模型标识.mjs` | 新增 | `normalizeModelId` 纯函数与规则常量 |
| `server/index.mjs` | 修改 | 两处模型 ID 校验改用 `normalizeModelId`；上下文补全精确匹配优先 |
| `server/套餐目录.mjs` | 修改 | 新增 Command Code 预设；`fetchPlanModels` 带出 per-model api/baseUrl/contextWindow；`applyPlan` 合并元数据并校验 ID |
| `scripts/模型斜线ID与套餐路由测试.mjs` | 新增 | 纯函数边界 + 套餐路由映射 + 源码契约（不联网、不写凭据） |
| `package.json` | 修改 | 新增 `test:model-slash-plan` |
| `REQUIREMENTS.md` | 修改（待确认） | R15 验收补一句：模型 ID 允许包含 `/`；内置套餐含 Command Code |
| `DESIGN.md` §7.1 | 修改（待确认） | 套餐接入说明补“按模型协议路由”一句 |
| `变更日志.md` | 修改 | 记录本次修复与套餐补充 |

---

## 5. 验证

### 5.1 自动化

```bash
npm run test:model-slash-plan     # 新增：normalizeModelId 边界 + Command Code 路由映射
npm run test:model-custom         # 既有：自定义供应商入口/能力字段契约
npm run test:settings-model
npm run test:provider-catalog
npm run verify
```

新增测试至少覆盖：

- `deepseek/deepseek-v4-flash`、`Qwen/Qwen3.8-27B` 通过；
- 空串、含空格、含反斜线、`/leading`、`trailing/`、`a//b`、`../x` 被拒；
- Command Code 目录样本：Claude 模型 → `anthropic-messages` + `/provider`；DeepSeek/Qwen → `openai-completions` + `/provider/v1`；
- `applyPlan` 写入的模型带 per-model `api/baseUrl/contextWindow`；
- 旧套餐（无 `supported_endpoints`）仍用 preset 级 `api/baseUrl`。

### 5.2 手工验收

1. 模型页 → 自定义供应商，Base URL 填 `https://api.commandcode.ai/provider/v1`，从 URL 拉取模型，勾选 `deepseek/deepseek-v4-flash`，保存成功（不再 400）。
2. 模型页 → 套餐 → Command Code，粘贴 Key，拉取到 97 个模型；勾选一个 Claude + 一个 DeepSeek，接入。
3. 检查 `模型配置.json`：Claude 模型 `api=anthropic-messages`、`baseUrl=.../provider`；DeepSeek 模型 `api=openai-completions`、`baseUrl=.../provider/v1`。
4. 测试连接两个模型（需真实 Key，可能产生少量费用）。
5. zjic：保持现有配置，复测探测接口，确认仍为网络超时并记录。

---

## 6. 风险与回退

| 风险 | 影响 | 缓解 | 回退 |
|---|---|---|---|
| 允许 `/` 后 spec 解析歧义 | 模型选错 | 全链路统一“第一个 `/` 切 provider”，已有实现 | 回退校验规则 |
| 远程目录缺少 `supported_endpoints` | 协议回退到 preset | 用 preset 默认；不影响旧套餐 | 手动改模型 `api` |
| Command Code 实际计费/权限与目录不符 | 个别模型 401/403 | 先测连接；错误可见 | 停用该模型 |
| 套餐模型过多（97） | 列表长 | 现有搜索/勾选；默认全选 | 只勾选所需 |
| 与并行会话冲突 | 合并冲突 | 只改上述文件；提交前审 `git diff` | 最小重放 |

---

## 7. 待确认决策（确认后我才改代码）

1. **D1 规则**：允许模型 ID 含 `/`，同时拒绝空白、反斜线、首尾 `/`、`//`、`.`/`..` 段；legacy 接口同步。是否同意？
2. **D2 协议路由**：Command Code 按 `supported_endpoints` 为每个模型写 `api` + `baseUrl`（Claude 走 `anthropic-messages`，其余走 `openai-completions`），而不是全供应商单一协议。是否同意？
3. **D2 套餐信息**：`planId=command-code`、显示名 “Command Code”、Key 页面 `https://commandcode.ai/`、描述不写价格。是否同意？
4. **D3 zjic**：当前结论是“目标地址不可达，非代码缺陷”，本次不改配置、不改代码；是否需要我把 401/404 以外的诊断信息再细化（例如提示“内网地址不可达”）？
5. **文档同步**：允许按 §4 更新 PRD R15 与 DESIGN §7.1 吗（验收口径变更需你确认）？
6. **真实连接测试**：是否允许用本机已保存的 Command Code Key 跑一次最小真实请求（会产生少量费用）？不授权则只验证目录与配置写入。
