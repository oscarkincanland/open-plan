/**
 * CAD 预览查看器（CAD 方案 AC1：2D SVG 渲染 + 图层显隐 + 缩放平移）。
 *
 * 数据来源：/api/doc open 响应（kind:"cad"，服务端 CAD解析.mjs 解析产出），
 * 无额外请求、随 open 一次返回；DWG 由服务端转换后同构返回。
 *
 * 三态约定（交互规范）：
 *   加载 —— doc 未就绪（防御态，正常时数据随 open 同步到达）；
 *   空   —— 无可显示实体（空图纸/全部为不支持实体）；
 *   错误 —— 几何构建异常兜底 + 服务端截断提示（truncated）。
 *
 * 渲染约定：
 *   - CAD 坐标系 Y 向上，SVG Y 向下：外层 g scale(1,-1) 全局翻转，文本单独再翻回；
 *   - 图层显隐按实体自身 layer 过滤（块内实体同样生效）；
 *   - INSERT 按块定义展开（translate/rotate/scale + 基点回退），深度限 3 防环；
 *   - 零依赖：SVG DOM 渲染；描边/文字颜色走 CSS 变量，暗/亮主题自动跟随。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";

/** INSERT 展开最大深度（防块自引用死循环）。 */
const MAX_INSERT_DEPTH = 3;

/** 由实体集合估算范围（服务端 extents 缺失时的兜底）。 */
function computeBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y, spread = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x - spread); maxX = Math.max(maxX, x + spread);
    minY = Math.min(minY, y - spread); maxY = Math.max(maxY, y + spread);
  };
  for (const e of entities) {
    if (Number.isFinite(e.x) && Number.isFinite(e.y)) eat(e.x, e.y, e.r || 0);
    if (Number.isFinite(e.x1) && Number.isFinite(e.y1)) { eat(e.x1, e.y1); eat(e.x2, e.y2); }
    if (Array.isArray(e.points)) for (const [px, py] of e.points) eat(px, py);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** ARC → SVG 路径（CAD 空间坐标：a1→a2 逆时针，全局翻转后视觉方向正确）。 */
function arcPath(e) {
  const a1 = ((e.a1 ?? 0) * Math.PI) / 180;
  const a2 = ((e.a2 ?? 360) * Math.PI) / 180;
  const sweepDeg = (((e.a2 ?? 360) - (e.a1 ?? 0)) % 360 + 360) % 360 || 360;
  const x1 = e.x + e.r * Math.cos(a1);
  const y1 = e.y + e.r * Math.sin(a1);
  const x2 = e.x + e.r * Math.cos(a2);
  const y2 = e.y + e.r * Math.sin(a2);
  return `M ${x1} ${y1} A ${e.r} ${e.r} 0 ${sweepDeg > 180 ? 1 : 0} 0 ${x2} ${y2}`;
}

/** 单实体 → SVG 元素（INSERT 递归展开受深度限制；不在此处按图层过滤，见下方 data-layer 说明）。 */
function renderEntity(e, key, blockMap, depth = 0) {
  const stroke = "var(--oaw-cad-ink)";
  switch (e.type) {
    case "LINE":
      return <line key={key} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
    case "CIRCLE":
      return <circle key={key} cx={e.x} cy={e.y} r={e.r} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
    case "ARC":
      return <path key={key} d={arcPath(e)} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
    case "LWPOLYLINE": {
      if (!e.points?.length) return null;
      const pts = e.points.map(([px, py]) => `${px},${py}`).join(" ");
      return e.closed
        ? <polygon key={key} points={pts} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        : <polyline key={key} points={pts} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
    }
    case "TEXT":
    case "MTEXT":
      if (!e.text) return null;
      return (
        <text
          key={key}
          transform={`translate(${e.x ?? 0} ${e.y ?? 0}) scale(1,-1)`}
          fontSize={Math.max(e.h || 1, 1e-6)}
          fill={stroke}
          stroke="none"
        >
          {e.text}
        </text>
      );
    case "INSERT": {
      if (depth >= MAX_INSERT_DEPTH) return null;
      const block = blockMap.get(e.block);
      if (!block) return null;
      const transform = `translate(${e.x ?? 0} ${e.y ?? 0}) rotate(${e.rot ?? 0}) scale(${e.sx ?? 1} ${e.sy ?? 1}) translate(${-block.baseX} ${-block.baseY})`;
      return (
        <g key={key} transform={transform} data-layer={e.layer}>
          {block.entities.map((child, i) => wrapByLayer(child, `${key}-${i}`, blockMap, depth + 1))}
        </g>
      );
    }
    default:
      return null;
  }
}

/**
 * 按实体自身图层包一层 `<g data-layer>`。
 *
 * 为什么这样分层：旧实现把 hiddenLayers 放进 useMemo 依赖，切一次图层就要
 * 把成千上万个实体重新建一遍 React 元素。现在几何只构建一次（依赖 entities），
 * 图层显隐改由 effect 直接切换 `[data-layer]` 的 display——大图纸切图层不再是 O(实体数)。
 */
function wrapByLayer(e, key, blockMap, depth = 0) {
  const node = renderEntity(e, key, blockMap, depth);
  if (!node) return null;
  // INSERT 已自带 data-layer（块内子实体各自再包），其余实体在这里包
  if (e.type === "INSERT") return node;
  return <g key={`${key}-l`} data-layer={e.layer}>{node}</g>;
}

export default function CadViewer({ doc }) {
  // ── 三态：加载 / 空 / 错误 ─────────────────────────────────────────────
  const [layersOpen, setLayersOpen] = useState(true);
  // 冻结图层默认隐藏（CAD 惯例）；用户开关后由 hiddenLayers 接管
  const [hiddenLayers, setHiddenLayers] = useState(() => new Set((doc?.layers || []).filter((l) => l.frozen).map((l) => l.name)));
  const [view, setView] = useState(null); // {x,y,w,h} SVG viewBox；null=待 fit
  const viewRef = useRef(null);
  viewRef.current = view;
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const blockMap = useMemo(() => new Map((doc?.blocks || []).map((b) => [b.name, b])), [doc?.blocks]);
  const bounds = useMemo(() => {
    if (doc?.extents?.min && doc?.extents?.max) {
      return { minX: doc.extents.min.x, minY: doc.extents.min.y, maxX: doc.extents.max.x, maxY: doc.extents.max.y };
    }
    return computeBounds(doc?.entities || []);
  }, [doc?.extents, doc?.entities]);

  // 图层清单 + 计数（含块内实体，供面板展示各层规模）
  const layerInfos = useMemo(() => {
    const counts = new Map();
    const tally = (e) => counts.set(e.layer, (counts.get(e.layer) || 0) + 1);
    for (const e of doc?.entities || []) {
      tally(e);
      if (e.type === "INSERT") {
        const block = blockMap.get(e.block);
        if (block) for (const child of block.entities) tally(child.layer);
      }
    }
    const declared = new Map((doc?.layers || []).map((l) => [l.name, l]));
    const names = new Set([...declared.keys(), ...counts.keys()]);
    return [...names].map((name) => ({ name, count: counts.get(name) || 0, frozen: declared.get(name)?.frozen || false }));
  }, [doc?.layers, doc?.entities, blockMap]);

  // SVG 元素构建放 useMemo：几何只依赖 entities/blocks（图层显隐不参与重建）。
  // 几何异常在此被捕获并返回结果对象——旧实现在 useMemo 里调 setState（渲染期 setState
  // 属 React 反模式，会触发额外重渲染告警），这里改为纯计算 + 渲染期读取。
  const geometry = useMemo(() => {
    try {
      return { ok: true, error: null, elements: (doc?.entities || []).map((e, i) => wrapByLayer(e, `e${i}`, blockMap)) };
    } catch (e) {
      return { ok: false, error: e?.message || "图形渲染失败", elements: null };
    }
  }, [doc?.entities, blockMap]);
  const elements = geometry.elements;
  const geometryError = geometry.ok ? null : geometry.error;

  // 图层显隐：只切换 [data-layer] 的 display，不重建 React 元素（O(变更层) 而非 O(实体数)）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    for (const node of svg.querySelectorAll("[data-layer]")) {
      const layer = node.getAttribute("data-layer");
      node.style.display = hiddenLayers.has(layer) ? "none" : "";
    }
  }, [hiddenLayers, geometry]);

  const fit = useCallback(() => {
    if (!bounds) { setView(null); return; }
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const pad = Math.max(w, h) * 0.05;
    setView({ x: bounds.minX - pad, y: -(bounds.maxY + pad), w: w + pad * 2, h: h + pad * 2 });
  }, [bounds]);

  // 切文件：重建默认隐藏层、复位视图（渲染期状态由 geometry 派生，无需在此重置）
  const docKey = doc?.id || doc?.name || "";
  useEffect(() => {
    setHiddenLayers(new Set((doc?.layers || []).filter((l) => l.frozen).map((l) => l.name)));
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, fit]);

  // 视口坐标换算（wheel 用 CTM 精确换算；平移用包围盒近似即可）
  const clientToUser = useCallback((event) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const inv = svg.getScreenCTM();
    if (!inv) return null;
    const p = pt.matrixTransform(inv.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // wheel 缩放（React 合成事件对 wheel 是 passive，需手动挂非 passive 监听才能 preventDefault）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const vb = viewRef.current;
      if (!vb) return;
      const k = event.deltaY > 0 ? 1.2 : 1 / 1.2;
      const m = clientToUser(event);
      if (!m) return;
      setView({ x: m.x - (m.x - vb.x) * k, y: m.y - (m.y - vb.y) * k, w: vb.w * k, h: vb.h * k });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [clientToUser, view !== null]);

  const onPointerDown = (e) => {
    if (!viewRef.current) return;
    dragRef.current = { px: e.clientX, py: e.clientY, vb: viewRef.current };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) return;
    const scale = drag.vb.w / Math.max(svg.getBoundingClientRect().width, 1);
    setView({
      x: drag.vb.x - (e.clientX - drag.px) * scale,
      y: drag.vb.y - (e.clientY - drag.py) * scale,
      w: drag.vb.w,
      h: drag.vb.h,
    });
  };
  const onPointerUp = (e) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const zoomBy = (k) => {
    const vb = viewRef.current;
    if (!vb) return;
    setView({ x: vb.x + vb.w * (1 - k) / 2, y: vb.y + vb.h * (1 - k) / 2, w: vb.w * k, h: vb.h * k });
  };
  const toggleLayer = (name) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // ── 三态渲染 ──────────────────────────────────────────────────────────
  if (!doc) {
    return (
      <div className="oaw-cad-wrap">
        <div className="oaw-cad-state" role="status"><Icon name="loading" size={16} /><span>正在加载 CAD 图纸…</span></div>
      </div>
    );
  }
  const visibleCount = (doc.entities || []).length;
  if (geometryError || !elements || visibleCount === 0) {
    return (
      <div className="oaw-cad-wrap">
        <div className={`oaw-cad-state ${geometryError ? "error" : ""}`} role={geometryError ? "alert" : undefined}>
          <Icon name={geometryError ? "warning" : "info"} size={16} />
          <span>
            {geometryError
              ? `CAD 渲染失败：${geometryError}`
              : "未解析到可显示的图形实体（可能是空图纸，或全部为暂不支持的实体类型）"}
          </span>
          {geometryError && <button className="btn-xs" onClick={fit}>复位视图</button>}
        </div>
      </div>
    );
  }

  const vb = view || { x: 0, y: 0, w: 1, h: 1 };
  return (
    <div className="oaw-cad-wrap">
      <div className="oaw-cad-toolbar">
        <button className="btn-xs" onClick={() => zoomBy(1 / 1.25)} title="放大"><Icon name="plus" size={12} /></button>
        <button className="btn-xs" onClick={() => zoomBy(1.25)} title="缩小"><Icon name="minus" size={12} /></button>
        <button className="btn-xs" onClick={fit} title="复位视图"><Icon name="maximize" size={12} /></button>
        <button className={`btn-xs ${layersOpen ? "active" : ""}`} onClick={() => setLayersOpen((v) => !v)} title="图层显隐">
          <Icon name="layers" size={12} /> 图层
        </button>
        <span className="oaw-cad-meta">
          {(doc.format || "dxf").toUpperCase()}
          {doc.format === "dwg" && doc.converter ? ` · 经 ${doc.converter} 转换` : ""}
          {` · ${visibleCount} 实体`}
        </span>
      </div>
      {doc.truncated && (
        <div className="oaw-cad-truncated" role="alert">
          <Icon name="warning" size={12} /> 实体数超过解析上限，仅显示前 {visibleCount} 个实体，图形不完整
        </div>
      )}
      <div className="oaw-cad-main">
        <svg
          ref={svgRef}
          className="oaw-cad-svg"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`CAD 图纸预览：${doc.name || ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* CAD Y 轴向上：全局翻转；文本实体内部已单独翻回 */}
          <g transform="scale(1,-1)">{elements}</g>
        </svg>
        {layersOpen && (
          <div className="oaw-cad-layers">
            <div className="oaw-cad-layers-head">图层（{layerInfos.length}）</div>
            {layerInfos.length === 0 && <div className="oaw-cad-layers-empty">无图层信息</div>}
            {layerInfos.map((l) => (
              <label key={l.name} className="oaw-cad-layer" title={`${l.name} · ${l.count} 实体${l.frozen ? " · 冻结" : ""}`}>
                <button
                  className="btn-xs"
                  onClick={(e) => { e.preventDefault(); toggleLayer(l.name); }}
                  aria-pressed={!hiddenLayers.has(l.name)}
                >
                  <Icon name={hiddenLayers.has(l.name) ? "eyeOff" : "eye"} size={11} />
                </button>
                <span className="oaw-cad-layer-name">{l.name}</span>
                <span className="oaw-cad-layer-count">{l.count}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
