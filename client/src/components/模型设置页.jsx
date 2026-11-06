import React, { useCallback, useEffect, useMemo, useState } from "react";
import Icon, { ProviderIcon } from "./Icon.jsx";
import { 供应商库, formatContext } from "./供应商库.jsx";
import { providerIdentity } from "../供应商标识.js";
import {
  agentAuth, agentAuthRemove, agentConfigStatus, agentImportConfig, agentImportPreview,
  agentModelConfigs, agentPlanApply, agentPlanDisconnect, agentPlanModels, agentPlans,
  agentProviderCatalog, agentProviderDetail, agentProviderImport,
  agentSetDefaultModel, deleteAgentModelConfig, fetchAgentModels, probeAgentModel,
  refreshModels, saveAgentModelConfig,
} from "../api.js";
import { askConfirm } from "./Feedback.jsx";

/**
 * 模型设置页：左侧供应商列表 + 右侧详情。
 *
 * 数据仍由既有服务端接口提供：
 * - /api/agent/model-configs        已接入供应商与模型
 * - /api/agent/provider-catalog     Pi 内置 + models.dev 合并目录
 * - /api/agent/plans                套餐预设与接入状态
 * - /api/agent/model-configs/fetch-models  从 ·接口/任意目录 URL 拉模型
 * 本组件只做布局与交互编排，不复制凭据，也不在浏览器持久化 Key。
 */

// 国内厂商（展示归组用）：只影响左栏分组，不复制供应商数据。
const DOMESTIC_PROVIDER_IDS = new Set([
  "deepseek", "zai", "zai-coding-cn",
  "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual",
  "moonshotai", "moonshotai-cn", "kimi-coding",
  "minimax", "minimax-cn",
  "xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

// 国际厂商（展示归组用）。
const INTERNATIONAL_PROVIDER_IDS = new Set([
  "openai", "openai-codex", "anthropic", "google", "google-vertex", "xai", "mistral",
  "groq", "cerebras", "together", "nvidia", "openrouter", "fireworks", "baseten",
  "huggingface", "github-copilot", "vercel-ai-gateway", "cloudflare-ai-gateway",
  "cloudflare-workers-ai", "amazon-bedrock", "azure", "radius", "meta", "ant-ling",
]);

const GROUP_LIMIT = 6;
const MODEL_API_OPTIONS = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["anthropic-messages", "Anthropic Messages"],
  ["openai-codex-responses", "OpenAI Responses"],
];

function providerGroup(id) {
  if (DOMESTIC_PROVIDER_IDS.has(id)) return "domestic";
  if (INTERNATIONAL_PROVIDER_IDS.has(id)) return "international";
  return "other";
}

function normalizeModel(model) {
  return {
    id: String(model?.id || "").trim(),
    name: String(model?.name || "").trim(),
    contextWindow: model?.contextWindow === 0 ? "0" : String(model?.contextWindow || ""),
    reasoning: model?.reasoning !== false,
    vision: model?.vision === true,
    enabled: model?.enabled !== false,
  };
}

function configDraft(config) {
  return {
    provider: String(config?.provider || ""),
    name: String(config?.name || config?.provider || ""),
    api: String(config?.api || "openai-completions"),
    baseUrl: String(config?.baseUrl || ""),
    key: "",
    enabled: config?.enabled !== false,
    models: (Array.isArray(config?.models) ? config.models : []).map(normalizeModel),
  };
}

function providerDescription(provider) {
  const caps = provider?.capabilities || {};
  const parts = [];
  if (provider?.modelCount) parts.push(`${provider.modelCount} 个模型`);
  if (caps.maxContext) parts.push(`最大上下文 ${formatContext(caps.maxContext)}`);
  if (caps.visionCount) parts.push(`${caps.visionCount} 个支持图片`);
  return parts.join(" · ") || "目录供应商";
}

function modelCountText(models = []) {
  const enabled = models.filter((model) => model.enabled !== false).length;
  return `${enabled}/${models.length} 个模型启用`;
}

export default function 模型设置页({
  models = [],
  defaultModel = "",
  activeModel = "",
  onModelChange,
  onModelsRefresh,
  integration = null,
}) {
  const [configs, setConfigs] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [plans, setPlans] = useState([]);
  const [auth, setAuth] = useState({});
  const [authErrors, setAuthErrors] = useState({});
  const [modelList, setModelList] = useState(Array.isArray(models) ? models : []);
  const [selection, setSelection] = useState({ type: "", id: "" });
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(null);
  const [modelQuery, setModelQuery] = useState("");
  const [newModel, setNewModel] = useState({ id: "", name: "", contextWindow: "" });
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [probeMsg, setProbeMsg] = useState("");
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchUrl, setFetchUrl] = useState("");
  const [fetchKey, setFetchKey] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchPreview, setFetchPreview] = useState([]);
  const [fetchPicked, setFetchPicked] = useState({});
  const [catalogKey, setCatalogKey] = useState("");
  const [catalogSetDefault, setCatalogSetDefault] = useState(false);
  const [planDraft, setPlanDraft] = useState({ planId: "", key: "", models: [], picked: {}, loading: false });
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [piConfig, setPiConfig] = useState(null);
  const [piImport, setPiImport] = useState(null);
  const [piImporting, setPiImporting] = useState(false);
  const [piImportSessions, setPiImportSessions] = useState(false);
  const [maintenanceMsg, setMaintenanceMsg] = useState("");

  useEffect(() => {
    if (Array.isArray(models)) setModelList(models);
  }, [models]);

  const loadCore = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    const [configsResult, catalogResult, plansResult, authResult] = await Promise.allSettled([
      agentModelConfigs(),
      agentProviderCatalog(),
      agentPlans(),
      agentAuth(),
    ]);
    if (configsResult.status === "fulfilled") {
      setConfigs(Array.isArray(configsResult.value?.configs) ? configsResult.value.configs : []);
    }
    if (catalogResult.status === "fulfilled") {
      setCatalog(catalogResult.value || { providers: [] });
    } else {
      setCatalog({ providers: [], error: catalogResult.reason?.message || "供应商目录读取失败" });
    }
    if (plansResult.status === "fulfilled") {
      setPlans(Array.isArray(plansResult.value?.plans) ? plansResult.value.plans : []);
    }
    if (authResult.status === "fulfilled") {
      setAuth(authResult.value?.providers || {});
      setAuthErrors(authResult.value?.authErrors || {});
    }
    setLoading(false);
  }, []);

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      await agentProviderCatalogRefresh();
    } catch (error) {
      setMessage(`目录刷新失败 · ${error.message}`);
    } finally {
      setCatalogLoading(false);
      await loadCore({ quiet: true });
    }
  }, [loadCore]);

  const refreshModelCatalog = useCallback(async () => {
    try {
      const result = onModelsRefresh ? await onModelsRefresh() : await refreshModels();
      const next = Array.isArray(result?.models) ? result.models : [];
      if (next.length) setModelList(next);
      return next;
    } catch (error) {
      setMessage(`模型目录刷新失败 · ${error.message}`);
      return [];
    }
  }, [onModelsRefresh]);

  useEffect(() => {
    loadCore().catch((error) => {
      setLoading(false);
      setMessage(`读取模型配置失败 · ${error.message}`);
    });
  }, [loadCore]);

  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(""), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  // 首次进入：优先选中默认模型所属供应商，其次第一个已接入项，最后第一个套餐。
  useEffect(() => {
    if (selection.type) return;
    const defaultProvider = String(defaultModel || activeModel || "").split("/")[0];
    const planProviderIds = new Set(plans.map((plan) => plan.providerId));
    const normalConfigs = configs.filter((config) => !planProviderIds.has(config.provider));
    const config = normalConfigs.find((item) => item.provider === defaultProvider) || normalConfigs[0];
    if (config) {
      setSelection({ type: "config", id: config.provider });
      return;
    }
    const plan = plans.find((item) => item.connected) || plans[0];
    if (plan) setSelection({ type: "plan", id: plan.planId });
  }, [configs, plans, defaultModel, activeModel, selection.type]);

  // 已接入供应商的编辑草稿；保存/删除后由 configs 更新触发重置。
  useEffect(() => {
    if (selection.type !== "config") return;
    const config = configs.find((item) => item.provider === selection.id);
    if (!config) return;
    setDraft(configDraft(config));
    setModelQuery("");
    setProbeMsg("");
  }, [selection.type, selection.id, configs]);

  // 套餐详情：进入时拉取远程模型目录（仅 modelsSource=remote 的套餐）。
  useEffect(() => {
    if (selection.type !== "plan") return;
    const plan = plans.find((item) => item.planId === selection.id);
    if (!plan) return;
    setPlanDraft({ planId: plan.planId, key: "", models: [], picked: {}, loading: plan.modelsSource === "remote" });
    if (plan.modelsSource !== "remote") return;
    let cancelled = false;
    agentPlanModels(plan.planId)
      .then((result) => {
        if (cancelled) return;
        const list = Array.isArray(result?.models) ? result.models : [];
        setPlanDraft({ planId: plan.planId, key: "", models: list, picked: Object.fromEntries(list.map((item) => [item.id, true])), loading: false });
      })
      .catch((error) => {
        if (cancelled) return;
        setPlanDraft((value) => ({ ...value, loading: false }));
        setMessage(`套餐模型目录拉取失败 · ${error.message}`);
      });
    return () => { cancelled = true; };
  }, [selection.type, selection.id, plans]);

  const catalogById = useMemo(() => {
    const map = new Map();
    for (const provider of catalog?.providers || []) map.set(provider.id, provider);
    return map;
  }, [catalog]);

  const planProviderIds = useMemo(() => new Set(plans.map((plan) => plan.providerId)), [plans]);
  const normalConfigs = useMemo(() => configs.filter((config) => !planProviderIds.has(config.provider)), [configs, planProviderIds]);
  const configuredIds = useMemo(() => new Set(configs.map((config) => config.provider)), [configs]);

  const groups = useMemo(() => {
    const configured = [];
    const custom = [];
    for (const config of normalConfigs) {
      if (catalogById.has(config.provider)) configured.push(config);
      else custom.push(config);
    }
    const catalogProviders = catalog?.providers || [];
    const available = catalogProviders.filter((provider) => !configuredIds.has(provider.id));
    return {
      connected: configured,
      custom,
      domestic: available.filter((provider) => providerGroup(provider.id) === "domestic"),
      international: available.filter((provider) => providerGroup(provider.id) === "international"),
      other: available.filter((provider) => providerGroup(provider.id) === "other"),
    };
  }, [normalConfigs, catalogById, catalog, configuredIds]);

  const searchResults = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return null;
    const rows = [];
    for (const plan of plans) {
      if (`${plan.name} ${plan.vendor} ${plan.planId}`.toLowerCase().includes(text)) rows.push({ type: "plan", id: plan.planId, label: plan.name });
    }
    for (const config of normalConfigs) {
      if (`${config.name} ${config.provider}`.toLowerCase().includes(text)) rows.push({ type: "config", id: config.provider, label: config.name || config.provider });
    }
    for (const provider of catalog?.providers || []) {
      if (configuredIds.has(provider.id)) continue;
      if (`${provider.name} ${provider.id} ${provider.apiLabel || ""}`.toLowerCase().includes(text)) rows.push({ type: "catalog", id: provider.id, label: provider.name || provider.id });
    }
    return rows.slice(0, 40);
  }, [query, plans, normalConfigs, catalog, configuredIds]);

  const currentSpec = String(activeModel || defaultModel || "").trim();
  const selectedModelInfo = modelList.find((item) => item.id === currentSpec) || null;
  const availableModels = modelList.filter((item) => item.available !== false || item.authError);

  const select = (type, id) => {
    setSelection({ type, id });
    setCatalogKey("");
    setCatalogSetDefault(false);
    setProbeMsg("");
  };

  const saveConfig = async () => {
    if (!draft || busy) return;
    if (!draft.provider.trim()) { setMessage("请先填写供应商 ID"); return; }
    if (!/^https?:\/\//i.test(draft.baseUrl.trim())) { setMessage("接口地址必须以 http:// 或 https:// 开头"); return; }
    if (!draft.models.length) { setMessage("至少保留一个模型"); return; }
    setBusy("save");
    try {
      const payload = {
        provider: draft.provider.trim(),
        name: draft.name.trim() || draft.provider.trim(),
        api: draft.api,
        baseUrl: draft.baseUrl.trim(),
        enabled: draft.enabled !== false,
        apiKey: draft.key.trim(),
        models: draft.models.map((model) => ({
          ...model,
          id: String(model.id || "").trim(),
          name: String(model.name || "").trim(),
          contextWindow: model.contextWindow === "" ? "" : Number(model.contextWindow),
        })),
      };
      const result = await saveAgentModelConfig(payload);
      setDraft(configDraft(result?.config || payload));
      setSelection({ type: "config", id: payload.provider });
      setMessage(`已保存 ${result?.config?.name || payload.name}`);
      await loadCore({ quiet: true });
      await refreshModelCatalog();
    } catch (error) {
      setMessage(`保存失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const removeConfig = async (provider) => {
    const config = configs.find((item) => item.provider === provider);
    if (!config) return;
    if (!(await askConfirm(`删除供应商“${config.name || provider}”及其凭据？`))) return;
    setBusy(`delete:${provider}`);
    try {
      await deleteAgentModelConfig(provider);
      setMessage(`已删除 ${config.name || provider}`);
      setSelection({ type: "", id: "" });
      await loadCore({ quiet: true });
      await refreshModelCatalog();
    } catch (error) {
      setMessage(`删除失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const probe = async (provider, modelId) => {
    const target = `${provider}/${modelId}`;
    setBusy("probe");
    setProbeMsg("正在测试真实模型链路…");
    try {
      const result = await probeAgentModel(target, 15000);
      if (result.ok) setProbeMsg(`连接成功 · ${result.latencyMs} ms${result.response?.preview ? ` · ${result.response.preview}` : ""}`);
      else setProbeMsg(`连接失败 · ${result.diagnostic?.category || "unknown"} · ${result.diagnostic?.message || "未返回错误"}`);
    } catch (error) {
      setProbeMsg(`连接测试请求失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const setAsDefault = async (provider, modelId) => {
    if (!provider || !modelId) return;
    setBusy("default");
    try {
      const result = await agentSetDefaultModel(provider, modelId);
      setMessage(`默认模型已设为 ${result?.defaultModel || `${provider}/${modelId}`}`);
      await loadCore({ quiet: true });
    } catch (error) {
      setMessage(`设为默认失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const addCatalogProvider = async (provider) => {
    if (!provider || busy) return;
    setBusy(`add:${provider.id}`);
    try {
      const result = await agentProviderImport({
        provider: provider.id,
        apiKey: catalogKey.trim(),
        setDefault: catalogSetDefault,
      });
      setMessage(`已添加 ${result?.name || provider.name || provider.id} · ${result?.total || 0} 个模型`);
      setCatalogKey("");
      setCatalogSetDefault(false);
      await loadCore({ quiet: true });
      await refreshModelCatalog();
      select("config", provider.id);
    } catch (error) {
      setMessage(`添加失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const startManualFromCatalog = async (provider) => {
    if (!provider || busy) return;
    setBusy(`detail:${provider.id}`);
    try {
      const detail = await agentProviderDetail(provider.id);
      const models = (Array.isArray(detail?.provider?.models) ? detail.provider.models : []).map(normalizeModel);
      setDraft({
        provider: provider.id,
        name: provider.name || provider.id,
        api: provider.api || "openai-completions",
        baseUrl: provider.baseUrl || "",
        key: "",
        enabled: true,
        models: models.length ? models : [{ id: "", name: "", contextWindow: "", reasoning: true, vision: false, enabled: true }],
      });
      setSelection({ type: "new", id: provider.id });
    } catch (error) {
      setMessage(`读取供应商详情失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const applyPlan = async (plan) => {
    if (!plan || busy) return;
    const modelIds = Object.entries(planDraft.picked).filter(([, on]) => on).map(([id]) => id);
    if (!planDraft.key.trim()) { setMessage("请先粘贴套餐 API Key"); return; }
    setBusy(`plan:${plan.planId}`);
    try {
      const result = await agentPlanApply({ planId: plan.planId, apiKey: planDraft.key.trim(), modelIds });
      if (!result?.ok) throw new Error(result?.error || "接入失败");
      setMessage(`接入成功 · 已启用 ${result.modelCount} 个模型`);
      await loadCore({ quiet: true });
      await refreshModelCatalog();
      select("config", plan.providerId);
    } catch (error) {
      setMessage(`接入失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const disconnectPlan = async (plan) => {
    if (!plan) return;
    if (!(await askConfirm(`断开 ${plan.name}？将移除其模型与凭据（不影响其他供应商）。`))) return;
    setBusy(`plan:${plan.planId}`);
    try {
      await agentPlanDisconnect(plan.planId);
      setMessage(`已断开 ${plan.name}`);
      setSelection({ type: "plan", id: plan.planId });
      await loadCore({ quiet: true });
      await refreshModelCatalog();
    } catch (error) {
      setMessage(`断开失败 · ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const openFetchDialog = () => {
    if (!draft) return;
    const base = String(draft.baseUrl || "").trim().replace(/\/+$/, "");
    // 常见网关把模型目录放在 /v1/models；已经带版本段的地址只补 /models。
    setFetchUrl(base ? (/\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`) : "");
    setFetchKey("");
    setFetchPreview([]);
    setFetchPicked({});
    setFetchOpen(true);
  };

  const runFetch = async () => {
    if (!fetchUrl.trim()) { setMessage("请先填写目录 URL"); return; }
    setFetching(true);
    setFetchPreview([]);
    setFetchPicked({});
    try {
      const result = await fetchAgentModels({ url: fetchUrl.trim(), apiKey: fetchKey.trim() });
      const list = (Array.isArray(result?.models) ? result.models : [])
        .map((item) => (typeof item === "string" ? { id: item } : item))
        .filter((item) => item?.id);
      if (!list.length) { setMessage("接口没有返回任何模型"); return; }
      setFetchPreview(list);
      setFetchPicked(Object.fromEntries(list.map((item) => [item.id, true])));
      setMessage(`已拉取 ${list.length} 个模型，勾选后合并`);
    } catch (error) {
      setMessage(`拉取失败 · ${error.message}`);
    } finally {
      setFetching(false);
    }
  };

  const mergeFetched = () => {
    const picked = fetchPreview.filter((item) => fetchPicked[item.id]);
    if (!picked.length) { setMessage("请至少勾选一个模型"); return; }
    setDraft((value) => {
      if (!value) return value;
      const existing = new Set(value.models.map((model) => String(model.id || "").trim()).filter(Boolean));
      const added = picked
        .filter((item) => !existing.has(String(item.id).trim()))
        .map((item) => ({
          id: String(item.id),
          name: item.name && item.name !== item.id ? String(item.name) : "",
          contextWindow: item.contextWindow ? String(item.contextWindow) : "",
          reasoning: item.reasoning !== false,
          vision: item.vision === true,
          enabled: true,
        }));
      setMessage(added.length ? `已合并 ${added.length} 个模型，保存后生效` : "勾选的模型都已存在");
      return { ...value, models: [...value.models, ...added] };
    });
    setFetchOpen(false);
  };

  const openMaintenance = async () => {
    setMaintenanceOpen(true);
    setMaintenanceMsg("");
    if (!piConfig) agentConfigStatus().then(setPiConfig).catch(() => {});
    if (!piImport) agentImportPreview().then(setPiImport).catch(() => {});
  };

  const importLocalPi = async () => {
    if (piImporting) return;
    if (!piImport?.available) { setMaintenanceMsg("没有检测到可导入的本地 Pi 配置"); return; }
    const providerCount = Number(piImport.credentialCount ?? piImport.providers?.length ?? 0);
    const sessionCount = Number(piImport.sessionCount ?? piImport.sessions?.count ?? 0);
    if (!(await askConfirm(`将本地 Pi 的模型配置和 ${providerCount} 个供应商凭据复制为规聚独立快照${piImportSessions ? `，并导入最多 ${sessionCount} 个历史会话` : "；历史会话暂不导入"}。源配置不会被修改。`))) return;
    setPiImporting(true);
    setMaintenanceMsg("正在复制配置快照…");
    try {
      const result = await agentImportConfig({ includeModels: true, includeSettings: true, includeCredentials: true, includeSessions: piImportSessions });
      setMaintenanceMsg(`导入完成 · ${result.imported?.length || 0} 项配置${piImportSessions ? ` · ${result.sessions?.imported || 0} 个会话` : ""}`);
      await loadCore({ quiet: true });
      await refreshModelCatalog();
    } catch (error) {
      setMaintenanceMsg(`导入失败 · ${error.message}`);
    } finally {
      setPiImporting(false);
    }
  };

  const removeCredential = async (provider) => {
    if (!(await askConfirm(`删除 ${providerIdentity(provider).label || provider} 的 API Key？`))) return;
    try {
      await agentAuthRemove(provider);
      await loadCore({ quiet: true });
      setMaintenanceMsg(`已删除 ${provider} 的凭据`);
    } catch (error) {
      setMaintenanceMsg(`删除凭据失败 · ${error.message}`);
    }
  };

  const updateDraftModel = (index, patch) => {
    setDraft((value) => value ? { ...value, models: value.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model) } : value);
  };

  const addDraftModel = () => {
    if (!newModel.id.trim()) { setMessage("请填写模型 ID"); return; }
    setDraft((value) => value ? {
      ...value,
      models: [...value.models, { id: newModel.id.trim(), name: newModel.name.trim(), contextWindow: newModel.contextWindow.trim(), reasoning: true, vision: false, enabled: true }],
    } : value);
    setNewModel({ id: "", name: "", contextWindow: "" });
    setAddModelOpen(false);
  };

  const renderNavItem = (type, id, label, sublabel, state = {}) => {
    const identity = providerIdentity(id);
    const isActive = selection.type === type && selection.id === id;
    const { connected = false, configured = false, error = false, plan = false } = state;
    return (
      <button
        key={`${type}:${id}`}
        type="button"
        className={`model-nav-item${isActive ? " active" : ""}`}
        onClick={() => select(type, id)}
        title={label}
      >
        <span className="prov-mark"><ProviderIcon provider={identity.icon} size={15} /></span>
        <span className="model-nav-main">
          <strong>{label}</strong>
          {sublabel && <small>{sublabel}</small>}
        </span>
        {error
          ? <span className="model-nav-dot warn" title="凭据失效" />
          : connected ? <span className="model-nav-dot" title="已接入" />
            : configured ? <span className="model-nav-dot muted" title="已保存凭据" />
              : plan ? <span className="model-nav-dot plan" title="套餐" /> : null}
      </button>
    );
  };

  const renderGroup = (key, title, rows) => {
    if (!rows.length) return null;
    const isExpanded = expanded[key] === true;
    const visible = isExpanded ? rows : rows.slice(0, GROUP_LIMIT);
    return (
      <div className="model-nav-group" key={key}>
        <div className="model-nav-title">{title}<span>{rows.length}</span></div>
        {visible}
        {rows.length > GROUP_LIMIT && (
          <button type="button" className="model-nav-more" onClick={() => setExpanded((value) => ({ ...value, [key]: !isExpanded }))}>
            {isExpanded ? "收起" : `展开全部 ${rows.length} 个`}
          </button>
        )}
      </div>
    );
  };

  const renderDetail = () => {
    if (selection.type === "library") {
      return (
        <div className="model-detail">
          <div className="model-detail-head">
            <div className="model-detail-title"><h4>全部供应商</h4><p>Pi 内置目录 + models.dev 合并结果；添加时自动带出协议、地址与模型能力。</p></div>
            <button type="button" className="btn-sm" onClick={() => select("", "")}>返回精选</button>
          </div>
          <供应商库
            catalog={catalog}
            refreshing={catalogLoading}
            onCatalogRefreshed={() => loadCore({ quiet: true })}
            onImported={async (result) => {
              await loadCore({ quiet: true });
              await refreshModelCatalog();
              if (result?.provider) select("config", result.provider);
            }}
            onEditExisting={(providerId) => select("config", providerId)}
          />
        </div>
      );
    }

    if (selection.type === "plan") {
      const plan = plans.find((item) => item.planId === selection.id);
      if (!plan) return <div className="model-detail-empty">套餐不存在或已下线</div>;
      const selectedCount = Object.values(planDraft.picked).filter(Boolean).length;
      return (
        <div className="model-detail">
          <div className="model-detail-head">
            <span className="model-detail-mark"><Icon name="cloud" size={18} /></span>
            <div className="model-detail-title">
              <h4>{plan.name}</h4>
              <p>{plan.description}</p>
              <div className="model-detail-badges">
                <span className={`sp-badge ${plan.connected ? "ok" : "warn"}`}>{plan.connected ? "已接入" : plan.hasKey ? "未启用模型" : "未接入"}</span>
                <span className="sp-badge">{plan.vendor}</span>
                {plan.connected && <span className="sp-badge ok">{plan.modelCount}/{plan.totalModels} 个模型启用</span>}
              </div>
            </div>
            <div className="model-detail-actions">
              {plan.connected && <button type="button" className="btn-sm" onClick={() => select("config", plan.providerId)}>管理模型</button>}
              <a className="btn-sm" href={plan.keyUrl} target="_blank" rel="noreferrer">套餐页</a>
              {plan.connected && <button type="button" className="btn-sm danger" onClick={() => disconnectPlan(plan)} disabled={Boolean(busy)}>断开</button>}
            </div>
          </div>
          {!plan.connected && (
            <>
              <section className="model-detail-card">
                <div className="model-detail-card-head"><strong>接入套餐</strong><span>账号域：{plan.vendor}</span></div>
                <label className="model-field">
                  <span>API Key</span>
                  <input className="sp-input" type="password" value={planDraft.key} onChange={(event) => setPlanDraft((value) => ({ ...value, key: event.target.value }))} placeholder="粘贴套餐 API Key（仅保存到服务端）" autoComplete="off" />
                </label>
              </section>
              <section className="model-detail-card">
                <div className="model-detail-card-head"><strong>模型目录</strong><span>{planDraft.loading ? "拉取中…" : `${planDraft.models.length} 个模型，已选 ${selectedCount}`}</span></div>
                {planDraft.loading && <div className="model-detail-hint">正在从套餐接口拉取模型目录…</div>}
                {!planDraft.loading && !planDraft.models.length && <div className="model-detail-hint">该套餐没有可拉取的模型目录，接入后可在供应商详情里手动添加。</div>}
                <div className="model-check-list">
                  {planDraft.models.map((item) => (
                    <label key={item.id} className="model-check-row">
                      <input type="checkbox" checked={planDraft.picked[item.id] !== false} onChange={() => setPlanDraft((value) => ({ ...value, picked: { ...value.picked, [item.id]: value.picked[item.id] === false } }))} />
                      <span className="model-check-name">{item.name || item.id}</span>
                      <code>{item.id}</code>
                    </label>
                  ))}
                </div>
                <div className="model-detail-footer">
                  <button type="button" className="btn-sm primary" onClick={() => applyPlan(plan)} disabled={Boolean(busy) || !planDraft.key.trim()}>
                    {busy === `plan:${plan.planId}` ? "接入中…" : "保存并接入"}
                  </button>
                </div>
              </section>
            </>
          )}
          {plan.connected && (
            <section className="model-detail-card">
              <div className="model-detail-card-head"><strong>已接入</strong><span>{plan.modelCount}/{plan.totalModels} 个模型启用</span></div>
              <div className="model-detail-hint">套餐模型与普通供应商共用同一套模型配置；点「管理模型」可调整启停、上下文与默认模型。</div>
            </section>
          )}
        </div>
      );
    }

    if (selection.type === "catalog") {
      const provider = catalogById.get(selection.id);
      if (!provider) return <div className="model-detail-empty">供应商不存在或目录未加载</div>;
      const identity = providerIdentity(provider.id);
      const hasCredential = Boolean(auth[provider.id]);
      const oauth = provider.loginMethods?.includes("oauth");
      return (
        <div className="model-detail">
          <div className="model-detail-head">
            <span className="model-detail-mark"><ProviderIcon provider={identity.icon} size={18} /></span>
            <div className="model-detail-title">
              <h4>{provider.name || provider.id}</h4>
              <p>{provider.apiLabel || provider.api} · {provider.baseUrl}</p>
              <div className="model-detail-badges">
                <span className="sp-badge">{provider.description || providerDescription(provider)}</span>
                {hasCredential && <span className="sp-badge ok">Key 已配置</span>}
                {provider.configured && <span className="sp-badge ok">已接入</span>}
                {oauth && <span className="sp-badge ok"><Icon name="lock" size={11} /> 账号登录</span>}
                {authErrors[provider.id] && <span className="sp-badge warn" title={authErrors[provider.id].message}>凭据失效</span>}
              </div>
            </div>
          </div>
          <section className="model-detail-card">
            <div className="model-detail-card-head"><strong>接入供应商</strong><span>{providerDescription(provider)}</span></div>
            {oauth && (
              <div className="model-detail-hint">
                账号登录（订阅制）：在终端执行 <code>pi auth login {provider.id}</code> 后回到这里刷新目录即可。
                <button type="button" className="btn-xs" onClick={() => navigator.clipboard?.writeText(`pi auth login ${provider.id}`).catch(() => {})}>复制命令</button>
              </div>
            )}
            <label className="model-field">
              <span>API Key</span>
              <input className="sp-input" type="password" value={catalogKey} onChange={(event) => setCatalogKey(event.target.value)} placeholder={oauth ? "账号登录可留空；也可直接填 API Key" : "粘贴 API Key（仅保存到服务端）"} autoComplete="off" />
            </label>
            <label className="model-check-row">
              <input type="checkbox" checked={catalogSetDefault} onChange={(event) => setCatalogSetDefault(event.target.checked)} />
              <span className="model-check-name">添加后设为默认模型供应商</span>
            </label>
            {provider.importable === false && <div className="model-detail-hint warn">无法一键导入：{provider.importBlockReason || "该供应商需要云凭证或专用登录方式"}</div>}
            <div className="model-detail-footer">
              <button type="button" className="btn-sm primary" onClick={() => addCatalogProvider(provider)} disabled={Boolean(busy) || provider.importable === false}>
                {busy === `add:${provider.id}` ? "添加中…" : "添加供应商"}
              </button>
              <button type="button" className="btn-sm" onClick={() => startManualFromCatalog(provider)} disabled={Boolean(busy)}>
                {busy === `detail:${provider.id}` ? "读取中…" : "手动配置"}
              </button>
            </div>
          </section>
          <section className="model-detail-card">
            <div className="model-detail-card-head"><strong>目录里的模型</strong><span>{provider.modelCount || 0} 个</span></div>
            <div className="model-chip-list">
              {(provider.sampleModels || []).map((model) => <span key={model.id} className="model-chip"><code>{model.id}</code>{model.contextWindow ? <small>{formatContext(model.contextWindow)}</small> : null}</span>)}
              {!provider.sampleModels?.length && <div className="model-detail-hint">目录未提供示例模型；添加后可手动填写或从接口拉取。</div>}
            </div>
          </section>
        </div>
      );
    }

    if (selection.type === "config" || selection.type === "new") {
      if (!draft) return <div className="model-detail-empty">正在读取供应商配置…</div>;
      const isNew = selection.type === "new" || !configs.some((item) => item.provider === draft.provider);
      const identity = providerIdentity(draft.provider);
      const enabledModels = draft.models.filter((model) => model.enabled !== false && String(model.id || "").trim());
      const firstModel = enabledModels[0]?.id || "";
      const masked = auth[draft.provider]?.masked;
      const filteredModels = draft.models
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => {
          const text = modelQuery.trim().toLowerCase();
          if (!text) return true;
          return `${model.id} ${model.name}`.toLowerCase().includes(text);
        });
      return (
        <div className="model-detail">
          <div className="model-detail-head">
            <span className="model-detail-mark"><ProviderIcon provider={identity.icon} size={18} /></span>
            <div className="model-detail-title">
              <h4>{draft.name || draft.provider}</h4>
              <p><code>{draft.provider}</code> · {MODEL_API_OPTIONS.find(([id]) => id === draft.api)?.[1] || draft.api}</p>
              <div className="model-detail-badges">
                <span className={`sp-badge ${draft.enabled ? "ok" : "warn"}`}>{draft.enabled ? "启用" : "停用"}</span>
                <span className={`sp-badge ${masked ? "ok" : "warn"}`}>{masked ? "Key 已配置" : "缺少 Key"}</span>
                {authErrors[draft.provider] && <span className="sp-badge warn" title={authErrors[draft.provider].message}>凭据失效</span>}
                {String(defaultModel || "").startsWith(`${draft.provider}/`) && <span className="sp-badge ok">默认</span>}
              </div>
            </div>
            <div className="model-detail-actions">
              <button type="button" className="btn-sm" onClick={() => probe(draft.provider, firstModel)} disabled={!firstModel || busy === "probe"}>
                <Icon name="flow" size={12} /> {busy === "probe" ? "测试中…" : "测试连接"}
              </button>
              <button type="button" className="btn-sm" onClick={() => setAsDefault(draft.provider, firstModel)} disabled={!firstModel || busy === "default"}>
                {busy === "default" ? "设置中…" : "设为默认"}
              </button>
              {!isNew && <button type="button" className="btn-sm danger" onClick={() => removeConfig(draft.provider)} disabled={Boolean(busy)}>删除</button>}
            </div>
          </div>
          {probeMsg && <div className={`model-detail-banner${probeMsg.startsWith("连接成功") ? " ok" : " warn"}`}>{probeMsg}</div>}
          <section className="model-detail-card">
            <div className="model-detail-card-head"><strong>连接配置</strong><span>Key 只保存到服务端凭据文件</span></div>
            <div className="model-form-grid">
              <label className="model-field"><span>供应商 ID</span><input className="sp-input" value={draft.provider} onChange={(event) => setDraft((value) => ({ ...value, provider: event.target.value }))} placeholder="例如 my-gateway" disabled={!isNew} /></label>
              <label className="model-field"><span>显示名称</span><input className="sp-input" value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="我的模型网关" /></label>
              <label className="model-field model-field-wide"><span>Base URL</span><input className="sp-input" value={draft.baseUrl} onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
              <label className="model-field"><span>接口协议</span><select className="sp-select" value={draft.api} onChange={(event) => setDraft((value) => ({ ...value, api: event.target.value }))}>{MODEL_API_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
              <label className="model-field"><span>API Key</span><input className="sp-input" type="password" value={draft.key} onChange={(event) => setDraft((value) => ({ ...value, key: event.target.value }))} placeholder={masked ? `已保存（${masked}）；留空保持不变` : "粘贴 API Key（不会回显）"} autoComplete="off" /></label>
              <label className="model-check-row model-check-row-inline"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))} /><span className="model-check-name">启用供应商</span></label>
            </div>
            <div className="model-detail-footer">
              <button type="button" className="btn-sm primary" onClick={saveConfig} disabled={Boolean(busy)}>{busy === "save" ? "保存中…" : "保存配置"}</button>
            </div>
          </section>
          <section className="model-detail-card">
            <div className="model-detail-card-head">
              <strong>模型</strong>
              <span>{modelCountText(draft.models)}</span>
            </div>
            <div className="model-model-toolbar">
              <input className="sp-input" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型 ID / 名称" aria-label="搜索模型" />
              <button type="button" className="btn-sm" onClick={openFetchDialog}><Icon name="download" size={12} /> 从 URL 拉取</button>
              <button type="button" className="btn-sm" onClick={() => setAddModelOpen((value) => !value)}><Icon name="plus" size={12} /> 添加模型</button>
            </div>
            {addModelOpen && (
              <div className="model-model-add">
                <input className="sp-input" value={newModel.id} onChange={(event) => setNewModel((value) => ({ ...value, id: event.target.value }))} placeholder="模型 ID" aria-label="模型 ID" />
                <input className="sp-input" value={newModel.name} onChange={(event) => setNewModel((value) => ({ ...value, name: event.target.value }))} placeholder="显示名称（可选）" aria-label="模型显示名称" />
                <input className="sp-input" type="number" min="1" value={newModel.contextWindow} onChange={(event) => setNewModel((value) => ({ ...value, contextWindow: event.target.value }))} placeholder="上下文 tokens" aria-label="上下文 tokens" />
                <button type="button" className="btn-sm primary" onClick={addDraftModel}>添加</button>
              </div>
            )}
            <div className="model-check-list">
              {filteredModels.map(({ model, index }) => (
                <div key={`${model.id}:${index}`} className="model-check-row">
                  <input type="checkbox" checked={model.enabled !== false} onChange={(event) => updateDraftModel(index, { enabled: event.target.checked })} aria-label={`启用 ${model.id || "模型"}`} />
                  <span className="model-check-name">{model.name || model.id || "未命名模型"}</span>
                  <code>{model.id || "—"}</code>
                  {model.contextWindow ? <small>{formatContext(model.contextWindow)}</small> : null}
                  {model.vision && <span className="sp-badge">图片</span>}
                  {model.reasoning !== false && <span className="sp-badge">思考</span>}
                  <button type="button" className="btn-xs danger" onClick={() => setDraft((value) => value ? { ...value, models: value.models.filter((_, modelIndex) => modelIndex !== index) } : value)} disabled={draft.models.length <= 1}>移除</button>
                </div>
              ))}
              {!filteredModels.length && <div className="model-detail-hint">{draft.models.length ? "没有匹配的模型" : "还没有模型：可以从 URL 拉取，或手动添加。"}</div>}
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="model-detail-empty">
        <Icon name="robot" size={22} />
        <strong>选择或添加一个供应商</strong>
        <span>左栏按「已接入 / 套餐 / 国内 / 国际 / 自定义」分组；也可以浏览全部供应商。</span>
      </div>
    );
  };

  const navBody = (
    <>
      <label className="model-search">
        <Icon name="search" size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索供应商 / 模型 / 套餐" aria-label="搜索供应商" />
      </label>
      {searchResults ? (
        <div className="model-nav-group">
          <div className="model-nav-title">搜索结果<span>{searchResults.length}</span></div>
          {searchResults.map((row) => renderNavItem(row.type, row.id, row.label, row.type === "plan" ? "套餐" : row.type === "catalog" ? "未接入" : "已接入", {
            connected: row.type === "config",
            plan: row.type === "plan",
            error: Boolean(authErrors[row.id]),
          }))}
          {!searchResults.length && <div className="model-detail-hint">没有匹配项</div>}
        </div>
      ) : (
        <>
          {loading && <div className="model-detail-hint">正在读取供应商…</div>}
          {renderGroup("plans", "套餐", plans.map((plan) => renderNavItem("plan", plan.planId, plan.name, plan.connected ? `${plan.modelCount} 个模型` : "未接入", { connected: plan.connected, plan: true })))}
          {renderGroup("connected", "已接入", groups.connected.map((config) => renderNavItem("config", config.provider, config.name || config.provider, `${config.models?.length || 0} 个模型`, { connected: true, error: Boolean(config.authError) })))}
          {renderGroup("domestic", "国内", groups.domestic.map((provider) => renderNavItem("catalog", provider.id, provider.name || provider.id, providerDescription(provider), { configured: Boolean(auth[provider.id]) })))}
          {renderGroup("international", "国际", groups.international.map((provider) => renderNavItem("catalog", provider.id, provider.name || provider.id, providerDescription(provider), { configured: Boolean(auth[provider.id]) })))}
          {renderGroup("custom", "自定义", groups.custom.map((config) => renderNavItem("config", config.provider, config.name || config.provider, `${config.models?.length || 0} 个模型`, { connected: true, error: Boolean(config.authError) })))}
          {renderGroup("other", "其他", groups.other.map((provider) => renderNavItem("catalog", provider.id, provider.name || provider.id, providerDescription(provider), { configured: Boolean(auth[provider.id]) })))}
        </>
      )}
      <div className="model-nav-footer">
        <button type="button" className="btn-sm" onClick={() => select("library", "all")}><Icon name="grid" size={12} /> 全部供应商 {catalog?.providers?.length ? `(${catalog.providers.length})` : ""}</button>
        <button type="button" className="btn-sm" onClick={openMaintenance}><Icon name="download" size={12} /> 导入与凭据</button>
      </div>
    </>
  );

  return (
    <div className="model-page" id="settings-providers">
      <div className="model-page-head">
        <div>
          <h3>模型</h3>
          <p>供应商、凭据与模型目录；切换模型只影响当前会话，不会改动历史会话。</p>
        </div>
        <div className="model-page-current">
          <span className="model-page-current-label">当前 Agent 模型</span>
          <select className="sp-select" value={activeModel || ""} onChange={(event) => onModelChange?.(event.target.value)} aria-label="当前 Agent 模型">
            <option value="">跟随系统默认 · {defaultModel || "未设置"}</option>
            {availableModels.map((item) => (
              <option key={`${item.provider || "model"}/${item.id}`} value={item.id} disabled={item.available === false}>
                {item.provider ? `${providerIdentity(item.provider).label} / ` : ""}{item.name || item.id}{item.authError ? "（凭据失效）" : item.available === false ? "（不可用）" : ""}
              </option>
            ))}
          </select>
          <span className={`sp-badge ${selectedModelInfo?.authError ? "warn" : selectedModelInfo?.available === false ? "warn" : selectedModelInfo ? "ok" : "warn"}`}>
            {selectedModelInfo?.authError ? "凭据失效" : selectedModelInfo?.available === false ? "不可用" : selectedModelInfo ? "目录可用" : "待配置"}
          </span>
          <button type="button" className="btn-sm" onClick={refreshModelCatalog}><Icon name="refresh" size={12} /> 刷新目录</button>
        </div>
      </div>
      {message && <div className="model-page-message" role="status">{message}</div>}
      <div className="model-page-body">
        <aside className="model-page-nav" aria-label="模型供应商">
          {navBody}
        </aside>
        <section className="model-page-detail">{renderDetail()}</section>
      </div>

      {fetchOpen && (
        <div className="model-modal-backdrop" role="dialog" aria-modal="true" aria-label="从 URL 拉取模型">
          <div className="model-modal">
            <div className="model-modal-head">
              <div><strong>从 URL 拉取模型</strong><p>支持任意 http(s) 目录地址；响应可为 data[]、models[] 或数组。</p></div>
              <button type="button" className="btn-xs" onClick={() => setFetchOpen(false)} aria-label="关闭">关闭</button>
            </div>
            <label className="model-field"><span>目录 URL</span><input className="sp-input" value={fetchUrl} onChange={(event) => setFetchUrl(event.target.value)} placeholder="https://api.example.com/v1/models" /></label>
            <label className="model-field"><span>API Key（可选）</span><input className="sp-input" type="password" value={fetchKey} onChange={(event) => setFetchKey(event.target.value)} placeholder="公开目录可留空；临时 Key 不落盘" autoComplete="off" /></label>
            <div className="model-modal-actions">
              <button type="button" className="btn-sm primary" onClick={runFetch} disabled={fetching}>{fetching ? "拉取中…" : "拉取"}</button>
            </div>
            {fetchPreview.length > 0 && (
              <>
                <div className="model-modal-result">共 {fetchPreview.length} 个模型，勾选要合并的项</div>
                <div className="model-check-list model-modal-list">
                  {fetchPreview.map((item) => (
                    <label key={item.id} className="model-check-row">
                      <input type="checkbox" checked={fetchPicked[item.id] !== false} onChange={() => setFetchPicked((value) => ({ ...value, [item.id]: value[item.id] === false }))} />
                      <span className="model-check-name">{item.name || item.id}</span>
                      <code>{item.id}</code>
                      {item.contextWindow ? <small>{formatContext(item.contextWindow)}</small> : null}
                    </label>
                  ))}
                </div>
                <div className="model-modal-actions">
                  <button type="button" className="btn-sm primary" onClick={mergeFetched}>合并 {Object.values(fetchPicked).filter(Boolean).length} 个模型</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {maintenanceOpen && (
        <div className="model-modal-backdrop" role="dialog" aria-modal="true" aria-label="配置导入与凭据">
          <div className="model-modal">
            <div className="model-modal-head">
              <div><strong>配置导入与凭据</strong><p>凭据只保存在服务端；这里只显示掩码。</p></div>
              <button type="button" className="btn-xs" onClick={() => setMaintenanceOpen(false)} aria-label="关闭">关闭</button>
            </div>
            <section className="model-modal-section">
              <strong>从本地 Pi 导入配置</strong>
              <p>{piImport?.available ? `检测到本地 Pi · ${piImport.credentialCount ?? piImport.providers?.length ?? 0} 个供应商 · ${piImport.sessionCount ?? piImport.sessions?.count ?? 0} 个会话` : piImport ? "未检测到本地 Pi 配置" : "正在检测本地 Pi…"}</p>
              <label className="model-check-row">
                <input type="checkbox" checked={piImportSessions} onChange={(event) => setPiImportSessions(event.target.checked)} />
                <span className="model-check-name">同时导入历史会话</span>
              </label>
              <button type="button" className="btn-sm" onClick={importLocalPi} disabled={!piImport?.available || piImporting}>{piImporting ? "导入中…" : "从本地 Pi 导入配置"}</button>
              {maintenanceMsg && <div className="model-detail-hint">{maintenanceMsg}</div>}
            </section>
            <section className="model-modal-section">
              <strong>已保存凭据</strong>
              {Object.keys(auth).length === 0 && <div className="model-detail-hint">还没有保存任何供应商凭据。</div>}
              {Object.entries(auth).map(([provider, value]) => (
                <div key={provider} className="model-credential-row">
                  <span className="prov-mark"><ProviderIcon provider={providerIdentity(provider).icon} size={14} /></span>
                  <span className="model-credential-main"><strong>{providerIdentity(provider).label}</strong><small>{value?.masked || "已保存"}</small></span>
                  {authErrors[provider] && <span className="sp-badge warn">凭据失效</span>}
                  <button type="button" className="btn-xs" onClick={() => removeCredential(provider)}>删除</button>
                </div>
              ))}
            </section>
            {piConfig?.dataDir && <div className="model-detail-hint"><code>{piConfig.dataDir}</code></div>}
            <div className="model-detail-hint">Pi SDK {integration?.piPackageVersion || "已加载"} · 配置由规聚独立管理。</div>
          </div>
        </div>
      )}
    </div>
  );
}
