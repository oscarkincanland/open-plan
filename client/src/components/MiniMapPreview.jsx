import React, { lazy, Suspense, useEffect, useState } from "react";
import Icon from "./Icon.jsx";
import { mapProject } from "../api.js";

const MapViewer = lazy(() => import("./MapViewer.jsx"));

/**
 * 初始页会话地图预览（画布“地图预览”标签）的只读小地图。
 *
 * 数据：/api/map/project?name= 返回的 config（center/zoom/可见图层），
 * 样式由 MapViewer 自身请求 /api/map/data/{project}/style.json。
 * 只读：不显示导入入口、不弹属性窗、不触发下钻；点击“继续编辑地图”进入地图模块。
 */
export default function MiniMapPreview({ project, view = null, height = 168, onOpen }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!project) return undefined;
    let cancelled = false;
    setConfig(null);
    setError("");
    mapProject(project)
      .then((result) => { if (!cancelled) setConfig(result?.config || null); })
      .catch((err) => { if (!cancelled) setError(err?.message || "地图项目加载失败"); });
    return () => { cancelled = true; };
  }, [project]);

  const visibleCount = (config?.layers || []).filter((layer) => layer.visible !== false).length;
  const initialView = view?.center ? { center: view.center, zoom: view.zoom || config?.zoom || 7 } : null;

  return (
    <div className="mini-map">
      <div className="mini-map-head">
        <Icon name="map" size={12} />
        <strong>{config?.name || project}</strong>
        {config && <span className="mini-map-count">{visibleCount} 个可见图层</span>}
      </div>
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
