import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { mapDraft, mapDrafts, mapProject } from "../api.js";

const MapViewer = lazy(() => import("./MapViewer.jsx"));

/** 预览草稿上限：小地图只做“看一眼未固化内容”，超过上限截断并提示。 */
export const MAX_PREVIEW_DRAFTS = 20;

// 稳定空数组：切换项目当帧不传草稿，避免给 MapViewer 每次渲染都换一个新引用。
const EMPTY_DRAFTS = [];

/**
 * 初始页会话地图预览（画布“地图预览”标签）的只读小地图。
 *
 * 数据：/api/map/project?name= 返回的 config（center/zoom/可见图层），
 * 样式由 MapViewer 自身请求 /api/map/data/{project}/style.json。
 * 草稿层（2026-11-09）：agent/drafts 只读回放——只取 visible !== false 的草稿、
 * 最多 MAX_PREVIEW_DRAFTS 条，逐条取 geojson 后交给 MapViewer 以虚线画；
 * 这里不提供固化/编辑入口，草稿失败也不阻塞正式层。
 * 只读：不显示导入入口、不弹属性窗、不触发下钻、不上报视口；点击“继续编辑地图”进入地图模块。
 */
export default function MiniMapPreview({ project, view = null, height = 168, onOpen, refreshToken = 0 }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  const projectRef = useRef(project);
  // 草稿状态带上“属于哪个项目”：切换项目当帧就不再把上一条会话的草稿画到新项目上。
  const [draftState, setDraftState] = useState({ project: "", items: [], total: 0, truncated: false, error: "" });
  const [draftRetryToken, setDraftRetryToken] = useState(0);

  useEffect(() => {
    if (!project) return undefined;
    let cancelled = false;
    // 只有切换项目才清空 config 并重挂 MapViewer；同项目刷新（agent 保存文件）
    // 保留旧 config，让地图实例继续存在，由 reloadToken 热更新 style。
    if (projectRef.current !== project) {
      projectRef.current = project;
      setConfig(null);
    }
    setError("");
    mapProject(project)
      .then((result) => { if (!cancelled) setConfig(result?.config || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || "地图项目加载失败"); });
    return () => { cancelled = true; };
    // refreshToken：agent/用户保存地图正式文件后重新拉 config（可见图层数/底图）；
    // style.json 由 MapViewer 的 reloadToken 热更新，避免整块小地图重挂与相机跳动。
  }, [project, refreshToken]);

  // 草稿层回放：列表接口只返回摘要，地图渲染需要几何，按 id 取详情后合并。
  // 只读约束：全部失败时降级为头部提示 + 重试，不阻塞正式层，也不触发任何写操作。
  useEffect(() => {
    if (!project) return undefined;
    let cancelled = false;
    // 同项目刷新（文件/草稿事件）保留已渲染草稿，避免地图图层闪一下全清；
    // 只有切换项目才清空，防止把上一条会话的草稿画到新项目上。
    setDraftState((prev) => (prev.project === project
      ? prev
      : { project, items: [], total: 0, truncated: false, error: "" }));
    (async () => {
      let list = [];
      try {
        const result = await mapDrafts(project);
        list = (Array.isArray(result?.drafts) ? result.drafts : []).filter((draft) => draft && draft.visible !== false);
      } catch {
        if (!cancelled) setDraftState({ project, items: [], total: 0, truncated: false, error: "草稿加载失败" });
        return;
      }
      if (cancelled) return;
      const limited = list.slice(0, MAX_PREVIEW_DRAFTS);
      const detailed = await Promise.all(limited.map(async (draft) => {
        try {
          const full = await mapDraft(project, draft.id);
          const geojson = full?.draft?.geojson || null;
          if (!geojson) return null;
          return { ...draft, geojson, style: full?.draft?.style || draft.style || {} };
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      const usable = detailed.filter(Boolean);
      setDraftState({
        project,
        items: usable,
        total: list.length,
        truncated: list.length > MAX_PREVIEW_DRAFTS,
        // 有草稿却一条也画不出来（详情全部失败）才算整体失败；部分失败保留可用草稿。
        error: list.length > 0 && usable.length === 0 ? "草稿加载失败" : "",
      });
    })();
    return () => { cancelled = true; };
    // 切换项目 / 正式文件与草稿事件递增的 refreshToken / 手动重试都重跑。
  }, [project, refreshToken, draftRetryToken]);

  const visibleCount = (config?.layers || []).filter((layer) => layer.visible !== false).length;
  const initialView = view?.center ? { center: view.center, zoom: view.zoom || config?.zoom || 7 } : null;
  const sameProject = draftState.project === project;
  const drafts = sameProject ? draftState.items : EMPTY_DRAFTS;
  const draftTotal = sameProject ? draftState.total : 0;
  const draftError = sameProject ? draftState.error : "";

  return (
    <div className="mini-map">
      <div className="mini-map-head">
        <Icon name="map" size={12} />
        <strong>{config?.name || project}</strong>
        {config && <span className="mini-map-count">{visibleCount} 个可见图层</span>}
        {draftTotal > 0 && (
          <span className="mini-map-count" style={{ marginLeft: 0 }} title="草稿只读显示，固化请到地图模块">
            草稿 {draftTotal}（未固化）
          </span>
        )}
        {sameProject && draftState.truncated && (
          <span className="mini-map-count" style={{ marginLeft: 0 }}>仅显示前 {MAX_PREVIEW_DRAFTS} 个</span>
        )}
      </div>
      {draftError && (
        <div className="mini-map-head" role="status">
          <span className="mini-map-count" style={{ marginLeft: 0 }}>{draftError}</span>
          <button
            type="button"
            className="btn-xs"
            title="重新读取该项目的未固化草稿"
            onClick={() => setDraftRetryToken((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}
      {error ? (
        <div className="mini-map-empty" style={{ height }}>{error}</div>
      ) : !config ? (
        <div className="mini-map-empty" style={{ height }}>正在加载地图…</div>
      ) : (
        <div className="mini-map-canvas" style={{ height }}>
          <Suspense fallback={<div className="mini-map-empty" style={{ height }}>正在加载地图组件…</div>}>
            <MapViewer
              key={`${project}:${view?.updatedAt || ""}`}
              project={project}
              config={config}
              initialView={initialView}
              reloadToken={refreshToken}
              drafts={drafts}
              readOnly
            />
          </Suspense>
        </div>
      )}
      <div className="mini-map-actions">
        <button className="btn-sm" type="button" onClick={() => onOpen?.()} title="进入地图模块继续编辑该项目">
          <Icon name="map" size={12} /> 继续编辑地图
        </button>
      </div>
    </div>
  );
}
