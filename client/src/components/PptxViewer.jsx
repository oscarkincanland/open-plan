import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PPTXViewJS from "pptxviewjs";
import Icon from "./Icon.jsx";
import { buildDocUrls, makeFileIdentity, identityMatches, readIdentityHeader, previewStateFromError, PREVIEW_STATE } from "../文件地址.js";

const LARGE_PPT_BYTES = 100 * 1024 * 1024;

/**
 * 预览加速（2026-11-09 验收反馈）：
 *  - 原始字节按「工作区 + 相对路径 + revision」做模块级 LRU，重开同一文件不再下载/等待网络；
 *  - 首屏渲染结果缓存为 JPEG dataURL，重新打开时先显示首屏再等 viewer 就绪；
 *  - HTTP 缓存走服务端已有的 ETag/Last-Modified（不再强制 no-store）。
 */
const 文件字节缓存 = new Map();
const 文件字节缓存预算 = 240 * 1024 * 1024;
const 首屏缓存 = new Map();
const 首屏缓存上限 = 6;

function 缓存键(identity) {
  const revision = String(identity?.revision || "");
  if (!revision) return "";
  return `${identity?.workspaceId || identity?.cwd || ""}::${identity?.relativePath || ""}::${revision}`;
}

function 取字节缓存(key) {
  if (!key) return null;
  const hit = 文件字节缓存.get(key);
  if (!hit) return null;
  文件字节缓存.delete(key);
  文件字节缓存.set(key, hit);
  return hit;
}

function 存字节缓存(key, bytes) {
  if (!key || !bytes?.byteLength) return;
  文件字节缓存.set(key, bytes);
  let 合计 = 0;
  for (const 值 of 文件字节缓存.values()) 合计 += 值.byteLength || 0;
  while (合计 > 文件字节缓存预算 && 文件字节缓存.size > 1) {
    const 首个 = 文件字节缓存.keys().next().value;
    合计 -= 文件字节缓存.get(首个)?.byteLength || 0;
    文件字节缓存.delete(首个);
  }
}

/**
 * PPT 预览（D03）：
 *  - 普通文件用 pptxviewjs Canvas 渲染；超大文件或渲染失败自动切换 OfficeCLI 高保真 HTML；
 *  - 同一 viewer 同时只执行一个 renderSlide，页码/缩放请求走 latest-wins 队列，
 *    旧页晚完成不会覆盖新页；
 *  - go/jump 只设置目标页，由统一的渲染 effect 执行（不再按钮 + effect 双重渲染）；
 *  - 卸载、切文档、切实例或切渲染器时中止请求并调用真实释放接口（已核对 pptxviewjs 暴露 destroy()），
 *    同时清空 canvas backing store，避免内存滞留；
 *  - 缩放/窗口变化只重渲染，不重新加载文件。
 * 关键点是给 pptxviewjs 传入明确的 px 尺寸；传入 100% 会被库解析为 100px，导致整页内容缩成一点。
 */
/**
 * 兼容两种 renderSlide 签名（2026-11-10）：
 * pptxviewjs 1.1.9 里公开类声明为 `renderSlide(slideIndex, canvas)`，
 * 但同包内层渲染器实际是 `renderSlide(canvas, slideIndex)`；两者混用时报
 * "Invalid render input"（实测所有 PPTX 都会掉到 OfficeCLI 高保真、首开要 3–8 秒）。
 * 这里先用文档签名，失败再按另一种顺序重试，保证浏览器内直接出图。
 */
async function renderSlideCompat(viewer, index, canvas) {
  try {
    await viewer.renderSlide(index, canvas);
    return;
  } catch (error) {
    if (!/Invalid render input/i.test(String(error?.message || ""))) throw error;
    await viewer.renderSlide(canvas, index);
  }
}

export default function PptxViewer({ name, revision = 0, identity, onPreviewState, onPreviewError }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const officeFrameRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [renderer, setRenderer] = useState("canvas");
  const [largeFile, setLargeFile] = useState(false);
  const [fallbackReason, setFallbackReason] = useState("");
  const [fitWidth, setFitWidth] = useState(960);
  const [slideRatio, setSlideRatio] = useState(16 / 9);
  // 统一文件身份 + 渲染 generation：切文件后旧请求结果不得写入。
  const fileIdentity = useMemo(
    () => identity || makeFileIdentity({ relativePath: name, revision }),
    [identity, name, revision],
  );
  const urls = useMemo(() => buildDocUrls(fileIdentity), [fileIdentity.workspaceId, fileIdentity.relativePath, fileIdentity.revision]);
  const 缓存标识 = useMemo(
    () => 缓存键(fileIdentity),
    [fileIdentity.workspaceId, fileIdentity.relativePath, fileIdentity.revision],
  );
  const [首屏图, set首屏图] = useState(() => (缓存标识 ? 首屏缓存.get(缓存标识) || "" : ""));
  const [首屏就绪, set首屏就绪] = useState(false);
  const [慢, set慢] = useState(false);
  const generationRef = useRef(0);

  // 回调经 ref 透传：加载 effect 只依赖文件身份与渲染器，缩放/窗口变化不触发重新加载。
  const callbacksRef = useRef({ onPreviewState, onPreviewError });
  useEffect(() => { callbacksRef.current = { onPreviewState, onPreviewError }; }, [onPreviewState, onPreviewError]);

  // 高保真 iframe 也会上报带身份的就绪/失败消息；onload 本身不代表内容成功。
  useEffect(() => {
    const onMessage = (event) => {
      const data = event?.data;
      if (!data || data.__oawPreview !== true) return;
      if (officeFrameRef.current && event.source && event.source !== officeFrameRef.current.contentWindow) return;
      if (data.identity && !identityMatches(fileIdentity, data.identity)) {
        setError("预览内容与当前文件身份不一致，已停止展示");
        callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED);
        callbacksRef.current.onPreviewError?.("预览内容与当前文件身份不一致");
        return;
      }
      if (data.type === "unsupported") callbacksRef.current.onPreviewState?.(PREVIEW_STATE.UNSUPPORTED);
      else if (data.type === "error") { callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED); callbacksRef.current.onPreviewError?.(data.message || "高保真预览失败"); }
      else if (data.type === "ready") callbacksRef.current.onPreviewState?.(PREVIEW_STATE.READY);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fileIdentity]);

  useEffect(() => {
    if (!loading || renderer !== "canvas") { set慢(false); return undefined; }
    const 定时 = window.setTimeout(() => set慢(true), 8000);
    return () => window.clearTimeout(定时);
  }, [loading, renderer, urls.raw]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const update = () => setFitWidth(Math.max(320, Math.min(1440, host.clientWidth - 40)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const canvasSize = useCallback(() => {
    const width = Math.max(320, Math.round(fitWidth * zoom / 100));
    return { width, height: Math.max(180, Math.round(width / slideRatio)) };
  }, [fitWidth, slideRatio, zoom]);
  const canvasSizeRef = useRef(canvasSize);
  canvasSizeRef.current = canvasSize;

  const applyCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = canvasSizeRef.current();
    // 缓冲区尺寸必须一起设：releaseViewer() 会把 canvas.width/height 归零，
    // 只改 CSS 会让库的 "Canvas must have positive dimensions" 校验失败，
    // 于是所有 PPTX 都掉到 OfficeCLI 高保真（首开 3–8 秒）。顺带让画面不再被拉伸发虚。
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }, []);

  /** 释放 viewer：优先用库的真实释放接口（pptxviewjs 暴露 destroy），再清空引用与 canvas。 */
  const releaseViewer = useCallback(() => {
    const viewer = viewerRef.current;
    viewerRef.current = null;
    try { viewer?.destroy?.(); } catch {}
    const canvas = canvasRef.current;
    if (canvas) {
      try { canvas.width = 0; canvas.height = 0; } catch {}
      const ctx = canvas.getContext?.("2d");
      ctx?.clearRect?.(0, 0, 0, 0);
    }
  }, []);

  // latest-wins 渲染队列：同一时刻只有一个 renderSlide 在跑，旧请求在轮到自己时被跳过。
  const renderSeqRef = useRef(0);
  const renderQueueRef = useRef(Promise.resolve());
  const pendingRenderRef = useRef({ token: 0, index: -1 });

  const renderPage = useCallback((index) => {
    const viewer = viewerRef.current;
    if (!viewer || !canvasRef.current || index < 0) return;
    const token = ++renderSeqRef.current;
    pendingRenderRef.current = { token, index };
    renderQueueRef.current = renderQueueRef.current
      .then(async () => {
        const pending = pendingRenderRef.current;
        if (!pending || pending.token !== token) return;      // 已有更新的页码，跳过旧渲染
        if (viewerRef.current !== viewer) return;             // 已切换实例/文档
        applyCanvasSize();
        await renderSlideCompat(viewer, index, canvasRef.current);
        if (index === 0 && 缓存标识) {
          try {
            const 图片 = canvasRef.current.toDataURL("image/jpeg", 0.72);
            if (图片 && !首屏缓存.has(缓存标识)) {
              首屏缓存.set(缓存标识, 图片);
              if (首屏缓存.size > 首屏缓存上限) 首屏缓存.delete(首屏缓存.keys().next().value);
            }
            set首屏就绪(true);
          } catch { /* toDataURL 失败不影响预览 */ }
        }
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        // 浏览器渲染失败不再死路：自动切到 OfficeCLI 高保真，并把原因写给用户。
        if (viewerRef.current === viewer) {
          setFallbackReason(String(e?.message || e));
          setRenderer("office");
          setLoading(false);
          callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL);
        }
      });
  }, [applyCanvasSize, 缓存标识]);

  useEffect(() => {
    if (renderer === "canvas" && viewerRef.current && current > 0) renderPage(current - 1);
  }, [renderer, current, fitWidth, slideRatio, zoom, renderPage]);

  useEffect(() => {
    if (renderer !== "canvas") { releaseViewer(); return undefined; }
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const live = () => generation === generationRef.current;
    setLoading(true);
    setError("");
    setFallbackReason("");
    setLargeFile(false);
    releaseViewer();
    callbacksRef.current.onPreviewState?.(PREVIEW_STATE.LOADING);
    set首屏就绪(false);
    set慢(false);
    set首屏图(缓存标识 ? 首屏缓存.get(缓存标识) || "" : "");
    const load = async () => {
      try {
        const 已存 = 缓存标识 ? 取字节缓存(缓存标识) : null;
        if (已存) {
          const viewer = new PPTXViewJS.PPTXViewer({ canvas: canvasRef.current, renderMode: "canvas", lazyLoad: true });
          await viewer.loadFile(已存);
          if (!live()) { try { viewer.destroy?.(); } catch {} return; }
          viewerRef.current = viewer;
          const dims = viewer.processor?.getSlideDimensions?.() || viewer.presentation?.slideSize;
          const ratio = dims?.cx && dims?.cy ? dims.cx / dims.cy : 16 / 9;
          setSlideRatio(ratio);
          setTotal(viewer.getSlideCount());
          setCurrent(1);
          return;
        }
        // 不再用 no-store：服务端 raw 路由已带 ETag/Last-Modified，
        // 交给浏览器条件请求，切换标签/重开文件时命中 304 而不是重传整包。
        const res = await fetch(urls.raw, { signal: controller.signal });
        if (!res.ok) {
          const fatal = new Error(`加载失败 HTTP ${res.status}`);
          fatal.previewFatal = true;
          throw fatal;
        }
        // 文件身份核对：不符则拒绝渲染，避免同名跨工作区串内容。
        const serverIdentity = readIdentityHeader(res);
        if (serverIdentity && !identityMatches(fileIdentity, serverIdentity)) {
          const fatal = new Error("预览内容与打开的文件不一致（文件身份不匹配），已停止渲染");
          fatal.previewFatal = true;
          throw fatal;
        }
        const fileSize = Number(res.headers.get("content-length") || 0);
        if (fileSize > LARGE_PPT_BYTES) {
          try { await res.body?.cancel(); } catch {}
          if (live()) {
            setLargeFile(true);
            setFallbackReason(`文件约 ${(fileSize / 1024 / 1024).toFixed(0)}MB，超过浏览器渲染预算`);
            setRenderer("office");
            setLoading(false);
            // 超大文件交给 OfficeCLI 高保真预览，等待其身份消息再判定 ready。
            callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL);
          }
          return;
        }
        const data = new Uint8Array(await res.arrayBuffer());
        if (缓存标识) 存字节缓存(缓存标识, data);
        if (!live()) return;
        const viewer = new PPTXViewJS.PPTXViewer({ canvas: canvasRef.current, renderMode: "canvas", lazyLoad: true });
        await viewer.loadFile(data);
        if (!live()) { try { viewer.destroy?.(); } catch {} return; }
        viewerRef.current = viewer;
        const dims = viewer.processor?.getSlideDimensions?.() || viewer.presentation?.slideSize;
        const ratio = dims?.cx && dims?.cy ? dims.cx / dims.cy : 16 / 9;
        setSlideRatio(ratio);
        setTotal(viewer.getSlideCount());
        setCurrent(1);   // 由渲染 effect 执行首屏渲染（单一渲染路径）
      } catch (e) {
        if (e?.name === "AbortError" || !live()) return;
        if (e?.previewFatal) {
          setError(e.message);
          callbacksRef.current.onPreviewError?.(e.message);
          callbacksRef.current.onPreviewState?.(previewStateFromError(e));
        } else {
          // 加载/解码失败同样回退高保真，而不是停在错误页。
          setFallbackReason(String(e?.message || e));
          setRenderer("office");
          callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL);
        }
      } finally {
        if (live()) setLoading(false);
      }
    };
    load();
    return () => {
      controller.abort();
      releaseViewer();
    };
  }, [urls, fileIdentity, renderer, releaseViewer]);

  // 页码导航只设置目标页；执行交给统一渲染 effect（不在此处直接 renderSlide）。
  const go = useCallback((dir) => {
    setCurrent((value) => Math.min(total, Math.max(1, value + dir)));
  }, [total]);

  const jump = useCallback((page) => {
    const next = Number(page) || 1;
    setCurrent(Math.min(total || next, Math.max(1, next)));
  }, [total]);

  return (
    <div className="oaw-pptx-wrap">
      <div className="oaw-pptx-toolbar">
        {renderer === "canvas" && <>
          <button className="btn-xs" onClick={() => go(-1)} disabled={current <= 1} title="上一页">‹ 上一页</button>
          <span className="oaw-pptx-count">{current} / {total}</span>
          <button className="btn-xs" onClick={() => go(1)} disabled={current >= total} title="下一页">下一页 ›</button>
          <select className="oaw-pptx-jump" value={current} onChange={(e) => jump(Number(e.target.value))} title="跳转到页">
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => <option key={n} value={n}>第 {n} 页</option>)}
          </select>
          <span className="toolbar-sep" />
          <button className="btn-xs" onClick={() => setZoom((v) => Math.max(60, v - 10))} title="缩小幻灯片">−</button>
          <span className="oaw-pptx-zoom">{zoom}%</span>
          <button className="btn-xs" onClick={() => setZoom((v) => Math.min(180, v + 10))} title="放大幻灯片">＋</button>
          <button className="btn-xs" onClick={() => setZoom(100)} title="适合窗口">适合窗口</button>
        </>}
        {renderer === "canvas" ? (
          <button className="btn-xs" onClick={() => { setFallbackReason(""); setRenderer("office"); callbacksRef.current.onPreviewState?.(PREVIEW_STATE.LOADING); }} title="切换到 OfficeCLI 高保真预览">高保真预览</button>
        ) : (
          <>
            <span className="oaw-pptx-high-fidelity">OfficeCLI 高保真渲染{fallbackReason ? `（${fallbackReason}）` : "（适合超大 PPT）"}</span>
            {!largeFile && <button className="btn-xs" onClick={() => { setFallbackReason(""); setRenderer("canvas"); }} title="切换回浏览器 Canvas 渲染">浏览器渲染</button>}
          </>
        )}
        {renderer === "canvas" && 慢 && <span className="oaw-pptx-hint warn" role="status">渲染较慢，可切换高保真</span>}
        <span className="oaw-pptx-hint" title="Canvas 预览不播放动画/切换，文本不可选；字体可能替换">{renderer === "canvas" ? "Canvas · 不播放动画" : "HTML 高保真"}</span>
      </div>
      {loading && <div className="oaw-pptx-loading"><div className="loading-spinner"></div><div>{renderer === "office" ? "正在准备高保真预览..." : "正在渲染幻灯片..."}</div></div>}
      {error && <div className="oaw-pptx-error"><Icon name="warning" size={14} /> {error}</div>}
      <div className="oaw-pptx-host" ref={hostRef}>
        {renderer === "canvas" ? (
          <div className="oaw-pptx-stage">
            <canvas ref={canvasRef} />
            {首屏图 && !首屏就绪 && <img className="oaw-pptx-first-frame" src={首屏图} alt="" aria-hidden="true" />}
          </div>
        ) : (
          <iframe
            ref={officeFrameRef}
            className="oaw-pptx-frame"
            title={`${name} 高保真预览`}
            src={urls.html}
            onLoad={() => { setLoading(false); callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL); }}
            onError={() => { setLoading(false); setError("OfficeCLI 高保真预览加载失败，请切回浏览器渲染"); callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED); callbacksRef.current.onPreviewError?.("OfficeCLI 高保真预览加载失败"); }}
          />
        )}
      </div>
    </div>
  );
}
