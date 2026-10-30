import React, { useEffect, useMemo, useState } from "react";
import Icon, { ProviderIcon } from "./Icon.jsx";
import { providerIdentity } from "../供应商标识.js";
import { formatContext } from "./供应商库.jsx";
import { agentProviderDetail, agentProviderImport, fetchAgentModels, saveAgentModelConfig } from "../api.js";

/**
 * 供应商配置弹层（zcode/proma 式单一配置入口）。
 *
 * 两种模式：
 *   - 预设（catalogEntry != null）：Base URL / 协议 / 模型清单来自 Pi 内置目录，可改 URL、
 *     填 Key、「拉取模型列表」（按协议调 fetch-models，服务端自动补能力），勾选后保存走
 *     provider-catalog/import（合并式写入，不覆盖用户已改字段）。
 *   - 自定义网关（catalogEntry == null）：协议 / URL / Key / 模型行全部手填，也可拉取，
 *     保存走 /api/agent/model-configs（整份写入）。
 *
 * 安全：API Key 只提交到服务端凭据文件，永不回显；已保存时仅显示「已保存」徽章。
 */

const PROTOCOL_OPTIONS = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["anthropic-messages", "Anthropic Messages"],
  ["openai-responses", "OpenAI Responses"],
  ["openai-codex-responses", "OpenAI Codex Responses"],
  ["google-generative-ai", "Google Gemini 协议"],
];

// 与服务端 MODELS_FETCH_PROTOCOLS 对齐：这些协议支持「从接口拉取」；其余协议只能用内置/手填清单。
const FETCHABLE_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai"]);

// 清单展示上限：超过后用搜索过滤 + 展开按钮，避免一次渲染 250+ 行。
const LIST_PAGE_SIZE = 50;

function normalizeModelRow(item) {
  if (typeof item === "string") return { id: item.trim(), name: "", contextWindow: "", vision: false, reasoning: true };
  return {
    id: String(item?.id || "").trim(),
    name: String(item?.name || "").trim(),
    contextWindow: item?.contextWindow ? String(item.contextWindow) : "",
    vision: item?.vision === true,
    reasoning: item?.reasoning !== false,
  };
}

export default function ProviderConfigDialog({ catalogEntry = null, existing = null, onClose, onSaved }) {
  const isPreset = Boolean(catalogEntry);
  const providerId = catalogEntry?.id || existing?.provider || "";
  const identity = providerIdentity(providerId || "custom");

  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [draft, setDraft] = useState(() => ({
    provider: catalogEntry?.id || existing?.provider || "",
    name: catalogEntry?.name || existing?.name || (isPreset ? "" : "我的网关"),
    api: catalogEntry?.api || existing?.api || "openai-completions",
    baseUrl: existing?.baseUrl || catalogEntry?.baseUrl || "",
    apiKey: "",
    clearApiKey: false,
    enabled: existing ? existing.enabled !== false : true,
  }));
  // 模型清单：existing 的模型先入列（选中），内置目录补齐（未选中）；拉取结果再合并（选中）。
  const [models, setModels] = useState(() => (Array.isArray(existing?.models) ? existing.models : []));
  const [setDefault, setSetDefault] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [listExpanded, setListExpanded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // 预设模式：读内置静态模型清单（弹层打开后一次性）。
  useEffect(() => {
    if (!isPreset || !providerId) return;
    let alive = true;
    setDetail(null);
    setDetailError("");
    agentProviderDetail(providerId)
      .then((result) => {
        if (!alive) return;
        setDetail(result);
        setModels((current) => {
          const seen = new Set(current.map((model) => model.id));
          const additions = (result?.provider?.models || [])
            .filter((model) => model.id && !seen.has(model.id))
            .map((model) => ({ ...model, selected: false, source: "catalog" }));
          return [...current, ...additions];
        });
      })
      .catch((err) => { if (alive) setDetailError(err.message || "读取失败"); });
    return () => { alive = false; };
  }, [isPreset, providerId]);

  // existing（编辑模式）：已有模型默认全选。
  useEffect(() => {
    if (!existing) return;
    setModels((current) => {
      if (current.length) return current.map((model) => ({ ...model, selected: true, existing: true }));
      return (Array.isArray(existing.models) ? existing.models : []).map((model) => ({ ...normalizeModelRow(model), selected: true, existing: true }));
    });
  }, [existing]);

  const canFetch = FETCHABLE_APIS.has(draft.api);
  const existingIds = useMemo(() => new Set((existing?.models || []).map((model) => model.id)), [existing]);
  const selectedIds = useMemo(() => models.filter((model) => model.selected).map((model) => model.id), [models]);

  const filteredModels = useMemo(() => {
    const text = filterText.trim().toLowerCase();
    if (!text) return models;
    return models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(text));
  }, [models, filterText]);
  const visibleModels = listExpanded ? filteredModels : filteredModels.slice(0, LIST_PAGE_SIZE);

  const updateModel = (id, patch) => {
    setModels((current) => current.map((model) => (model.id === id ? { ...model, ...patch } : model)));
  };

  // 自定义网关的模型行允许空 ID（手填中），按行号更新避免空 ID 互相覆盖。
  const updateModelAt = (index, patch) => {
    setModels((current) => current.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)));
  };

  const runFetch = async () => {
    if (fetching) return;
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) { setMessage("请先填写接口地址再拉取模型"); return; }
    if (!canFetch) { setMessage(`协议 ${draft.api} 不支持远程拉取，请使用内置模型清单或手填`); return; }
    setFetching(true);
    setMessage("正在从接口拉取模型列表…");
    try {
      const payload = { baseUrl, apiKey: draft.apiKey.trim(), api: draft.api };
      if (!payload.apiKey && existing?.keyConfigured) payload.provider = draft.provider;
      const result = await fetchAgentModels(payload);
      const fetched = (Array.isArray(result.models) ? result.models : []).map(normalizeModelRow).filter((model) => model.id);
      if (!fetched.length) { setMessage("接口没有返回任何模型"); return; }
      setModels((current) => {
        const byId = new Map(current.map((model) => [model.id, model]));
        for (const model of fetched) {
          const hit = byId.get(model.id);
          if (hit) {
            byId.set(model.id, {
              ...hit,
              name: hit.name || model.name,
              contextWindow: hit.contextWindow || model.contextWindow || "",
              selected: true,
              fetched: true,
            });
          } else {
            byId.set(model.id, { ...model, selected: true, source: "fetched", fetched: true });
          }
        }
        return [...byId.values()];
      });
      const matched = Number(result.matched) || 0;
      setMessage(`已拉取 ${fetched.length} 个模型并勾选${matched ? `（${matched} 个自动带出上下文与能力）` : ""}；可按需取消勾选后保存`);
    } catch (error) {
      setMessage(`拉取失败 · ${error.message}`);
    } finally {
      setFetching(false);
    }
  };

  const runSave = async () => {
    if (saving) return;
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) { setMessage("请填写接口地址"); return; }
    setSaving(true);
    setMessage(isPreset ? "正在保存供应商配置…" : "正在保存自定义网关…");
    try {
      if (isPreset) {
        if (!selectedIds.length) { setMessage("至少勾选一个模型"); setSaving(false); return; }
        const result = await agentProviderImport({
          provider: draft.provider,
          name: draft.name.trim() || undefined,
          baseUrl,
          apiKey: draft.apiKey.trim() || undefined,
          clearApiKey: draft.clearApiKey || undefined,
          modelIds: selectedIds,
          enabled: draft.enabled,
          setDefault,
          defaultModel: selectedIds[0],
        });
        setMessage(`已保存 ${result.name || draft.provider} · 共 ${result.total} 个模型${result.defaultModel ? ` · 默认 ${result.defaultModel}` : ""}`);
        onSaved?.(result);
      } else {
        const provider = draft.provider.trim();
        if (!provider) { setMessage("请填写供应商 ID"); setSaving(false); return; }
        const rows = models
          .filter((model) => model.id)
          .map((model) => ({
            id: model.id,
            name: model.name || model.id,
            contextWindow: model.contextWindow === "" ? "" : Number(model.contextWindow),
            reasoning: model.reasoning !== false,
            vision: model.vision === true,
            enabled: model.selected !== false,
          }));
        if (!rows.length) { setMessage("至少需要一个模型（拉取或手填）"); setSaving(false); return; }
        const result = await saveAgentModelConfig({
          provider,
          name: draft.name.trim() || provider,
          api: draft.api,
          baseUrl,
          apiKey: draft.apiKey.trim(),
          clearApiKey: draft.clearApiKey,
          enabled: draft.enabled,
          models: rows,
        });
        setMessage(`已保存 ${result.config?.name || provider} · ${rows.length} 个模型`);
        onSaved?.(result.config ? { ...result, provider, defaultModel: null } : { provider, defaultModel: null });
      }
    } catch (error) {
      setMessage(`保存失败 · ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const keyConfigured = Boolean(existing?.keyConfigured);

  return (
    <div className="prov-dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="prov-dialog prov-config-dialog" role="dialog" aria-modal="true" aria-label={isPreset ? `配置 ${draft.name || providerId}` : "配置自定义网关"}>
        <div className="prov-dialog-head">
          <div className="prov-dialog-title">
            <span className="prov-mark"><ProviderIcon provider={identity.icon} size={20} /></span>
            <div>
              <strong>{isPreset ? (draft.name || providerId) : "自定义网关"}</strong>
              <span className="prov-dialog-sub">
                {isPreset ? <code>{providerId}</code> : null}
                {isPreset ? ` · ${catalogEntry.apiLabel || draft.api}` : "任意 OpenAI / Anthropic / Gemini 兼容端点"}
              </span>
            </div>
          </div>
          <button type="button" className="btn-xs" onClick={onClose}>关闭</button>
        </div>

        {detailError && <div className="model-feedback">内置模型清单读取失败 · {detailError}（仍可拉取或手填）</div>}

        <div className="prov-config-form">
          {!isPreset && (
            <div className="prov-config-row">
              <label><span>供应商 ID</span><input className="sp-input" value={draft.provider} onChange={(event) => setDraft((value) => ({ ...value, provider: event.target.value }))} placeholder="例如 my-gateway" /></label>
              <label><span>接口协议</span>
                <select className="sp-select" value={draft.api} onChange={(event) => setDraft((value) => ({ ...value, api: event.target.value }))}>
                  {PROTOCOL_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label><span>显示名称</span><input className="sp-input" value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="我的模型网关" /></label>
            </div>
          )}
          <div className="prov-config-row">
            <label className="prov-config-url"><span>Base URL {isPreset ? "（来自内置目录，可改）" : ""}</span>
              <input className="sp-input" value={draft.baseUrl} onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" />
            </label>
            <label><span>API Key{keyConfigured ? "（已保存，留空保持不变）" : ""}</span>
              <input className="sp-input" type="password" value={draft.apiKey} onChange={(event) => setDraft((value) => ({ ...value, apiKey: event.target.value, clearApiKey: false }))} placeholder={keyConfigured ? "不会回显" : "粘贴 API Key（只保存到服务端）"} />
            </label>
          </div>
          <div className="prov-dialog-checks">
            {keyConfigured && <label><input type="checkbox" checked={draft.clearApiKey} onChange={(event) => setDraft((value) => ({ ...value, clearApiKey: event.target.checked, apiKey: "" }))} /> 清除已保存 Key</label>}
            <label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))} /> 启用该供应商</label>
            <label><input type="checkbox" checked={setDefault} onChange={(event) => setSetDefault(event.target.checked)} /> 设为默认模型供应商</label>
          </div>
        </div>

        <div className="prov-dialog-models">
          <div className="prov-config-models-head">
            <strong>模型（已选 {selectedIds.length} / {models.length}）</strong>
            <div className="prov-config-models-actions">
              {canFetch && (
                <button type="button" className="btn-xs" onClick={runFetch} disabled={fetching} title={`调用 ${draft.api} 的模型列表接口`}>
                  <Icon name="download" size={12} /> {fetching ? "拉取中…" : "拉取模型列表"}
                </button>
              )}
              {!isPreset && (
                <button type="button" className="btn-xs" onClick={() => setModels((current) => [...current, { id: "", name: "", contextWindow: "", vision: false, reasoning: true, selected: true, source: "manual" }])}>
                  <Icon name="plus" size={12} /> 手填模型
                </button>
              )}
            </div>
          </div>
          {!canFetch && (
            <div className="sp-note">协议 {draft.api} 不支持远程拉取{isPreset ? "，下方为内置模型清单，可直接勾选保存" : "，请手填模型"}。</div>
          )}
          {models.length > 12 && (
            <input className="sp-input prov-config-filter" value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder="按模型 ID / 名称过滤…" />
          )}
          {!isPreset ? (
            <div className="prov-config-model-list">
              {visibleModels.map((model, index) => (
                <div className="prov-config-model" key={`${model.id}-${index}`}>
                  {model.source !== "manual" && <input type="checkbox" checked={model.selected !== false} onChange={(event) => updateModelAt(index, { selected: event.target.checked })} />}
                  <input className="sp-input" value={model.id} onChange={(event) => updateModelAt(index, { id: event.target.value })} placeholder="模型 ID" />
                  <input className="sp-input" value={model.name} onChange={(event) => updateModelAt(index, { name: event.target.value })} placeholder="显示名称" />
                  <input className="sp-input prov-config-ctx" value={model.contextWindow} onChange={(event) => updateModelAt(index, { contextWindow: event.target.value })} placeholder="上下文" />
                  <label className="model-provider-check"><input type="checkbox" checked={model.vision === true} onChange={(event) => updateModelAt(index, { vision: event.target.checked })} /> 图片</label>
                  <button type="button" className="btn-xs danger" onClick={() => setModels((current) => current.filter((_, modelIndex) => modelIndex !== index))}>移除</button>
                </div>
              ))}
              {!models.length && <div className="sp-note">还没有模型：点「拉取模型列表」或「手填模型」。</div>}
            </div>
          ) : (
            <div className="prov-dialog-model-list">
              {visibleModels.map((model) => (
                <label className={`prov-dialog-model${existingIds.has(model.id) ? " existing" : ""}`} key={model.id}>
                  <input type="checkbox" checked={model.selected !== false} onChange={() => updateModel(model.id, { selected: !(model.selected !== false) })} />
                  <span className="prov-dialog-model-id">{model.name || model.id}<code>{model.id}</code></span>
                  <span className="prov-dialog-model-caps">
                    {model.contextWindow ? `${formatContext(model.contextWindow)} 上下文` : "上下文未知"}
                    {model.vision ? " · 图片" : ""}
                    {model.reasoning ? " · 思考" : ""}
                    {existingIds.has(model.id) ? " · 已配置" : ""}
                    {model.fetched ? " · 已拉取" : ""}
                  </span>
                </label>
              ))}
              {!visibleModels.length && <div className="sp-note">没有匹配的模型。</div>}
            </div>
          )}
          {filteredModels.length > LIST_PAGE_SIZE && (
            <button type="button" className="btn-xs prov-dialog-more" onClick={() => setListExpanded((value) => !value)}>
              {listExpanded ? "收起" : `显示全部 ${filteredModels.length} 个模型（当前 ${LIST_PAGE_SIZE} 个）`}
            </button>
          )}
        </div>

        <div className="prov-dialog-actions">
          <button type="button" className="btn-sm" onClick={onClose}>取消</button>
          <button type="button" className="btn-sm primary" onClick={runSave} disabled={saving}>
            {saving ? "保存中…" : isPreset ? `保存（${selectedIds.length} 个模型）` : "保存网关配置"}
          </button>
          {message && <span className="sp-auth-msg prov-config-msg">{message}</span>}
        </div>
      </div>
    </div>
  );
}
