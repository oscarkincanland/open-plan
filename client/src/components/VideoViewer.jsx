import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import 提示气泡 from "./提示气泡.jsx";
import { openInSystem, revealInSystem } from "../api.js";
import { PREVIEW_STATE } from "../文件地址.js";
import { notifyError } from "./Feedback.jsx";

/**
 * 视频查看器（预览面板，2026-11-15-006 计划）
 *   - 与 ImageViewer 同构：raw 地址带文件身份，切换文件不会串内容；
 *   - 原生 <video> 承载播放（controls 全由浏览器提供：进度条/音量/全屏）；
 *     服务端 sendFile 原生支持 Range，拖动进度条按分段加载；
 *   - 只读预览：不做缩放档位（视频等比自适应容器），明确 loading / ready / failed 状态。
 */
export default function VideoViewer({ doc, onPreviewState, onPreviewError }) {
  const [state, setState] = useState(PREVIEW_STATE.LOADING);
  const url = doc?.url || "";
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setState(PREVIEW_STATE.LOADING);
    onPreviewState?.(PREVIEW_STATE.LOADING);
  }, [url, doc?.identity?.relativePath, doc?.identity?.revision, onPreviewState]);

  const markReady = useCallback((event) => {
    // 代次守卫：旧 <video> 元素迟到的 canplay 不覆盖新文件状态（与 ImageViewer 同口径）。
    const video = event?.currentTarget;
    if (!video || video.dataset.generation !== String(generationRef.current)) return;
    setState(PREVIEW_STATE.READY);
    onPreviewState?.(PREVIEW_STATE.READY);
  }, [onPreviewState]);

  const markFailed = useCallback(() => {
    setState(PREVIEW_STATE.FAILED);
    onPreviewState?.(PREVIEW_STATE.FAILED);
    onPreviewError?.("视频加载失败：文件可能损坏、编码不受支持，或已不可读");
  }, [onPreviewError, onPreviewState]);

  const handleOpenOriginal = useCallback(() => {
    if (doc?.identity?.relativePath) openInSystem(doc.identity.relativePath).catch((error) => notifyError(`打开失败：${error.message}`));
  }, [doc?.identity?.relativePath]);

  const handleReveal = useCallback(() => {
    if (doc?.identity?.relativePath) revealInSystem(doc.identity.relativePath).catch((error) => notifyError(`在文件管理器中显示失败：${error.message}`));
  }, [doc?.identity?.relativePath]);

  return (
    <div className="video-viewer">
      <div className="video-viewer-toolbar">
        <span className="badge"><Icon name="play" size={12} /> {doc?.ext ? String(doc.ext).toUpperCase() : "视频"}</span>
        <span className="video-viewer-spacer" />
        <button type="button" className="btn-xs" onClick={handleOpenOriginal} title="用系统默认应用打开原文件"><Icon name="externalLink" size={12} /> 打开原文件</button>
        <提示气泡 label="在文件管理器中显示">
          <button type="button" className="btn-xs" onClick={handleReveal} aria-label="在文件管理器中显示"><Icon name="folderOpen" size={12} /></button>
        </提示气泡>
      </div>
      {state === PREVIEW_STATE.FAILED && (
        <div className="video-viewer-error" role="alert">
          <Icon name="warning" size={16} />
          <span>视频加载失败：文件可能损坏、编码不受支持，或已不可读。</span>
          <提示气泡 label="用系统应用打开"><button type="button" className="btn-xs" onClick={handleOpenOriginal} aria-label="用系统应用打开"><Icon name="externalLink" size={12} /></button></提示气泡>
        </div>
      )}
      {state !== PREVIEW_STATE.FAILED && (
        <div className="video-viewer-stage">
          {state === PREVIEW_STATE.LOADING && <div className="video-viewer-loading">正在加载视频…</div>}
          <video
            key={url}
            data-generation={generationRef.current}
            src={url}
            controls
            playsInline
            preload="metadata"
            onCanPlay={markReady}
            onError={markFailed}
          />
        </div>
      )}
    </div>
  );
}
