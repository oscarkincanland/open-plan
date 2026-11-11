import { readModelsConfig, writeModelsConfig, readCredentials, writeCredentials, ensureConfigDirectory } from "./Pi配置管理.mjs";
import { normalizeModelId } from "./模型标识.mjs";

/**
 * 内置套餐预设：订阅制/套餐制模型供应商的一键接入目录。
 * 新增套餐只需在此登记；接入后写入标准 providers + 凭据，Pi 运行时无感知。
 * planMeta 标记预设来源，便于前端区分「套餐接入」与「手填网关」。
 *
 * 2026-11-11-003：同一供应商可能按模型支持不同协议（Command Code 的 Claude 只支持
 * /messages，其余模型支持 /chat/completions）。模型声明 supported_endpoints 时，
 * fetchPlanModels 会为每个模型带出 api/baseUrl，applyPlan 原样写入模型级配置；
 * Pi 的模型级 api/baseUrl 优先于 provider 级配置。
 */
export const PLAN_PRESETS = [
  {
    planId: "opencode-zen-go",
    name: "OpenCode Zen Go",
    vendor: "opencode.ai",
    description: "OpenCode 官方模型网关：按请求计费（$20 起充、零加价），模型经编码代理场景实测调优，支持设置月度上限。",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authType: "api_key",
    keyUrl: "https://opencode.ai/zen",
    modelsSource: "remote",
  },
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
    // 模型级协议覆盖：Anthropic SDK 会在 baseUrl 后追加 /v1/messages，
    // OpenAI SDK 追加 /chat/completions 或 /responses。
    endpointBaseUrls: {
      "/messages": "https://api.commandcode.ai/provider",
      "/chat/completions": "https://api.commandcode.ai/provider/v1",
      "/responses": "https://api.commandcode.ai/provider/v1",
    },
  },
];

// 一个模型声明多个端点时，优先选择兼容性最好的协议。
const ENDPOINT_PRIORITY = [
  ["/chat/completions", "openai-completions"],
  ["/responses", "openai-responses"],
  ["/messages", "anthropic-messages"],
];

function planProviderId(planId) {
  return `PLAN_${String(planId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function presetOf(planId) {
  return PLAN_PRESETS.find((p) => p.planId === planId) || null;
}

/** 按模型声明的端点选择 api 与 baseUrl；未声明时回退到套餐默认值。 */
function routeForModel(preset, model) {
  const endpoints = Array.isArray(model?.supported_endpoints)
    ? model.supported_endpoints.map(String)
    : [];
  for (const [endpoint, api] of ENDPOINT_PRIORITY) {
    if (!endpoints.includes(endpoint)) continue;
    return {
      api,
      baseUrl: preset.endpointBaseUrls?.[endpoint] || preset.baseUrl,
    };
  }
  return { api: preset.api, baseUrl: preset.baseUrl };
}

function catalogModel(preset, raw) {
  const id = String(raw?.id || "").trim();
  if (!id) return null;
  const route = routeForModel(preset, raw);
  const contextWindow = Number(raw?.context_length ?? raw?.contextWindow ?? raw?.context ?? 0);
  return {
    id,
    name: String(raw?.name || id),
    api: route.api,
    baseUrl: route.baseUrl,
    ...(contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
  };
}

/** 套餐目录 + 当前接入状态（不含凭据明文）。 */
export function listPlans() {
  const config = readModelsConfig() || {};
  const credentials = readCredentials() || {};
  return PLAN_PRESETS.map((preset) => {
    const providerId = planProviderId(preset.planId);
    const provider = config.providers?.[providerId];
    const cred = credentials[providerId];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    return {
      ...preset,
      providerId,
      hasKey: Boolean(cred?.key),
      connected: Boolean(provider?.enabled && cred?.key && models.length),
      modelCount: models.filter((m) => m.enabled !== false).length,
      totalModels: models.length,
    };
  });
}

/**
 * 拉取套餐的远程模型目录（OpenAI 兼容 /models）。
 * 公开目录无需鉴权；传入 apiKey 时一并携带，兼容需要鉴权的套餐。
 */
export async function fetchPlanModels(planId, { apiKey = "" } = {}) {
  const preset = presetOf(planId);
  if (!preset) throw new Error("未知套餐");
  const url = `${String(preset.baseUrl).replace(/\/+$/, "")}/models`;
  const key = String(apiKey || "").trim();
  const res = await fetch(url, {
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`模型目录请求失败 HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.map((model) => catalogModel(preset, model)).filter(Boolean);
}

/** 套餐接入：写标准 provider + 凭据（模型可指定，缺省拉全量目录）。 */
export async function applyPlan({ planId, apiKey, modelIds } = {}) {
  const preset = presetOf(planId);
  if (!preset) return { ok: false, error: "未知套餐" };
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, error: "缺少 API Key" };

  const requested = [];
  for (const raw of Array.isArray(modelIds) ? modelIds : []) {
    const id = normalizeModelId(raw);
    if (!id) return { ok: false, error: `模型 ID 不合法：${String(raw).slice(0, 80)}` };
    requested.push(id);
  }

  // 无论是否显式勾选，都尽量拉一次目录：需要 name / api / baseUrl / contextWindow。
  let catalog = [];
  try {
    catalog = await fetchPlanModels(planId, { apiKey: key });
  } catch { /* 目录拉取失败：显式勾选的模型仍可用套餐默认协议接入 */ }
  const metaById = new Map(catalog.map((model) => [model.id, model]));

  let ids = [...new Set(requested)];
  if (!ids.length) ids = catalog.map((model) => model.id);
  if (!ids.length) return { ok: false, error: "未获得模型目录，请先获取模型列表并勾选" };

  const models = ids.map((id) => {
    const meta = metaById.get(id) || {};
    const contextWindow = Number(meta.contextWindow) > 0 ? Math.floor(Number(meta.contextWindow)) : 128000;
    return {
      id,
      name: String(meta.name || id),
      api: meta.api || preset.api,
      baseUrl: meta.baseUrl || preset.baseUrl,
      contextWindow,
      reasoning: true,
      input: ["text"],
      enabled: true,
    };
  });
  const config = readModelsConfig() || {};
  const providerId = planProviderId(planId);
  const providers = {
    ...(config.providers || {}),
    [providerId]: {
      name: preset.name,
      api: preset.api,
      baseUrl: preset.baseUrl,
      enabled: true,
      planMeta: { planId: preset.planId, preset: true, authType: preset.authType },
      models,
    },
  };
  writeModelsConfig({ ...config, providers });
  const credentials = readCredentials() || {};
  credentials[providerId] = { type: "api_key", key };
  ensureConfigDirectory();
  writeCredentials(credentials);
  return { ok: true, providerId, planId: preset.planId, modelCount: models.length };
}

/** 断开套餐：移除 provider 与凭据（保留其他供应商不动）。 */
export function disconnectPlan({ planId } = {}) {
  const preset = presetOf(planId);
  if (!preset) return { ok: false, error: "未知套餐" };
  const providerId = planProviderId(planId);
  const config = readModelsConfig() || {};
  if (config.providers?.[providerId]) {
    const providers = { ...config.providers };
    delete providers[providerId];
    writeModelsConfig({ ...config, providers });
  }
  const credentials = readCredentials() || {};
  if (credentials[providerId]) {
    delete credentials[providerId];
    writeCredentials(credentials);
  }
  return { ok: true, providerId };
}
