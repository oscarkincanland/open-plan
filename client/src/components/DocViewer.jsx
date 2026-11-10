import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { openInSystem, revealInSystem } from "../api.js";
import { notifyError } from "./Feedback.jsx";
import { buildDocUrls, makeFileIdentity, identityMatches, PREVIEW_STATE, PREVIEW_STATE_LABEL } from "../文件地址.js";
import MarkdownBody from "./MarkdownBody.jsx";
import MarkdownToc from "./MarkdownToc.jsx";
import ExcelGrid from "./ExcelGrid.jsx";
import CadViewer from "./CadViewer.jsx";
import DocxViewer from "./DocxViewer.jsx";
import PptxViewer from "./PptxViewer.jsx";
import ImageViewer from "./ImageViewer.jsx";
import CommentMarker from "./CommentMarker.jsx";
import Icon from "./Icon.jsx";
import 文件类型图标 from "./文件类型图标.jsx";
import CodeViewerBoundary from "./CodeViewerBoundary.jsx";
import { previewCapability } from "../预览能力.js";

// 源码查看器按需加载：CodeMirror 与语言包只在打开代码文件时才进入页面。
const CodeViewer = React.lazy(() => import("./CodeViewer.jsx"));
const ANNO_SAVE_DEBOUNCE = 800;

// ===== 标注定位模型（2026-11-06，替换「纯文本首匹配」）=====
// 旧实现只存 `text` 且恢复时取文档里**第一个**匹配：同一句话出现两次就必然标错，
// 且选区跨文本节点时 surroundContents 直接抛错、标注静默丢失。
// 现在额外存「上下文（前后各 30 字）+ 出现序号」，恢复时按锚点择优。
const ANNO_CONTEXT_CHARS = 30;

/** 收集容器内全部文本节点与累计偏移，用于把 (节点, 偏移) 换算成绝对字符位置。 */
function collectTextNodes(root) {
  const entries = [];
  let total = 0;
  try {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue ? node.nodeValue.length : 0;
      entries.push({ node, start: total, end: total + len });
      total += len;
    }
  } catch { /* 非 DOM 容器 */ }
  return { entries, total, text: entries.map((e) => e.node.nodeValue || "").join("") };
}

/** 记录选区锚点：文本 + 前文 + 后文 + 在全文中的出现序号。 */
function buildAnnotationAnchor(root, range) {
  try {
    const text = range.toString();
    if (!text || !text.trim()) return null;
    const { entries, text: full } = collectTextNodes(root);
    // 选区起点换算成绝对偏移（起点不在文本节点时退化为 -1 → 只用 occurrence=0）
    let abs = -1;
    for (const entry of entries) {
      if (entry.node === range.startContainer) { abs = entry.start + range.startOffset; break; }
    }
    if (abs < 0) return { text: text.trim(), before: "", after: "", occurrence: 0 };
    const before = full.slice(Math.max(0, abs - ANNO_CONTEXT_CHARS), abs);
    const after = full.slice(abs + text.length, abs + text.length + ANNO_CONTEXT_CHARS);
    const occurrence = full.slice(0, abs).split(text).length - 1;
    return { text: text.trim(), before, after, occurrence };
  } catch {
    return null;
  }
}

/** 在文档里找出某段文本的全部「单节点内」匹配（跨节点的匹配无法安全包裹，跳过）。 */
function findAllTextMatches(root, text) {
  const out = [];
  if (!root || !text) return out;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes(text)) return NodeFilter.FILTER_REJECT;
      // 已包裹的跳过，避免重复包裹
      let p = node.parentNode;
      while (p && p !== root) {
        if (p.nodeType === 1 && p.classList
          && (p.classList.contains("oa-anno-hl") || p.classList.contains("oa-anno-cm"))) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue || "";
    let from = 0;
    for (;;) {
      const idx = value.indexOf(text, from);
      if (idx < 0) break;
      out.push({ node, idx });
      from = idx + text.length;
    }
  }
  return out;
}

/** 把匹配包裹成高亮/批注元素。 */
function wrapTextMatch(match, wrapType, note) {
  const doc = match.node.ownerDocument;
  const className = wrapType === "highlight" ? "oa-anno-hl" : "oa-anno-cm";
  const tag = wrapType === "highlight" ? "mark" : "u";
  const length = String(match.text || "").length;
  if (!length) return false;
  try {
    const range = doc.createRange();
    range.setStart(match.node, match.idx);
    range.setEnd(match.node, match.idx + length);
    const wrap = doc.createElement(tag);
    wrap.className = className;
    if (wrapType === "comment" && note) wrap.title = note;
    range.surroundContents(wrap);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按锚点恢复一条标注：优先选「上下文匹配」的候选，其次按出现序号，最后退回首个匹配。
 * 返回是否成功包裹。
 */
function wrapAnnotatedText(root, anno) {
  const text = anno?.text;
  if (!root || !text) return false;
  const matches = findAllTextMatches(root, text);
  if (!matches.length) return false;
  for (const match of matches) match.text = text;

  if (typeof anno.occurrence === "number" && anno.occurrence >= 0 && anno.occurrence < matches.length) {
    // 序号命中且上下文也对得上 → 直接采用（最强证据）
    const candidate = matches[anno.occurrence];
    const value = candidate.node.nodeValue || "";
    const before = value.slice(Math.max(0, candidate.idx - ANNO_CONTEXT_CHARS), candidate.idx);
    const after = value.slice(candidate.idx + text.length, candidate.idx + text.length + ANNO_CONTEXT_CHARS);
    const contextOk = (!anno.before || before.endsWith(anno.before))
      && (!anno.after || after.startsWith(anno.after));
    if (contextOk) return wrapTextMatch(candidate, anno.type, anno.note);
    // 上下文不符（文档被 Agent 改过）→ 序号仍可用
    if (wrapTextMatch(candidate, anno.type, anno.note)) return true;
  }
  // 无锚点的旧数据 / 序号越界 → 首个匹配（保持向后兼容）
  return wrapTextMatch(matches[0], anno.type, anno.note);
}

// 在 iframe load 时按 annotations 列表逐个恢复 DOM 包裹
function restoreAnnotationsInDoc(rootDoc, annotations) {
  if (!rootDoc || !rootDoc.body || !annotations || !annotations.length) return;
  for (const a of annotations) {
    if (!a || !a.text) continue;
    wrapAnnotatedText(rootDoc.body, a);
  }
}

// 把 range.getBoundingClientRect() 转换为 iframe 父容器 (docframe-container) 内的坐标
function selectionToContainerCoords(iframe, range) {
  if (!iframe || !range) return null;
  const container = iframe.parentElement;
  if (!container) return null;
  const iframeRect = iframe.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  return {
    x: iframeRect.left - containerRect.left + r.left,
    y: iframeRect.top - containerRect.top + (r.top - iframeRect.height > 0 ? 0 : r.top), // 选区在 iframe 视口内
    width: r.width,
    height: r.height,
  };
}

// 单文件内容渲染
function DocContent({ doc, loading, onRefresh, onSendToAgent, onInsertContext, onDirtyChange }) {
  const [watchUrl, setWatchUrl] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");
  const [comments, setComments] = useState([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);

  // 统一预览状态：loading | ready | partial | unsupported | failed（子查看器一致消费）
  const [previewState, setPreviewState] = useState(PREVIEW_STATE.LOADING);
  const [previewErr, setPreviewErr] = useState("");
  // 文档信息浮层（2026-11-03 预览收敛）：预览能力与排版说明收进 ⓘ
  const [infoOpen, setInfoOpen] = useState(false);
  const infoWrapRef = useRef(null);

  useEffect(() => {
    if (!infoOpen) return undefined;
    const onPointerDown = (event) => {
      if (!infoWrapRef.current?.contains(event.target)) setInfoOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setInfoOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [infoOpen]);

  // 标注模式相关状态
  const [annoMode, setAnnoMode] = useState(false);
  const [annotations, setAnnotations] = useState([]);
  const [annoLoaded, setAnnoLoaded] = useState(false); // 服务端 annotations 已加载
  const [iframeReady, setIframeReady] = useState(false); // iframe 已 onload
  const [annoToolbar, setAnnoToolbar] = useState(null); // {x,y,text}
  const [annoInput, setAnnoInput] = useState(null); // {mode:'comment'|'agent', text, value}

  const iframeReadyRef = useRef(false);
  const saveTimerRef = useRef(null);
  const lastSavedJsonRef = useRef("[]");
  // 预览/源码切换：只对文本类（Markdown/文本/HTML/代码）有意义，切文件时复位。
  const [sourceMode, setSourceMode] = useState(false);
  const [codeRetry, setCodeRetry] = useState(0);
  const capability = previewCapability(doc?.ext, { code: doc?.kind === "code" });

  // 文件身份：所有预览请求都显式带同一份 { cwd, relativePath, revision }。
  const identity = useMemo(
    () => doc?.identity || makeFileIdentity({ relativePath: doc?.name }),
    [doc?.identity, doc?.name],
  );
  const docKey = `${identity.workspaceId}::${identity.relativePath}`;
  useEffect(() => { setSourceMode(false); setCodeRetry(0); }, [docKey, doc?.kind]);
  const urls = useMemo(() => buildDocUrls(identity), [identity.workspaceId, identity.relativePath, identity.revision]);
  // 渲染 generation：切文件时递增，旧请求（即使已完成）的结果直接丢弃。
  const generationRef = useRef(0);
  const abortMapRef = useRef(new Map());
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  // 按通道取消旧请求并发起新请求，返回的 controller 供调用方 abort。
  const scopedFetch = useCallback((channel, url, options = {}) => {
    abortMapRef.current.get(channel)?.abort();
    const controller = new AbortController();
    abortMapRef.current.set(channel, controller);
    return fetch(url, { cache: "no-store", ...options, signal: controller.signal });
  }, []);

  // 响应身份核对：服务端返回 identity 与当前文件不符则丢弃（防止串内容）。
  const identityOk = useCallback((serverIdentity) => {
    if (!serverIdentity) return true;
    return identityMatches(identityRef.current, serverIdentity);
  }, []);

  const isHtmlKind = doc?.kind === "html" || doc?.kind === "htmlfile";
  // DOCX/PPTX 使用各自的专用查看器；通用 HTML 工具栏对这两类文件不生效。
  const isOfficePreview = doc?.kind === "html" && (doc.ext === "docx" || doc.ext === "pptx");

  // iframe 内容通过 postMessage 上报身份与就绪状态：onload 只代表页面已加载。
  useEffect(() => {
    const onMessage = (event) => {
      const data = event?.data;
      if (!data || data.__oawPreview !== true) return;
      // 只接受来自当前预览 iframe 的消息，忽略其它来源。
      if (htmlFrameRef.current && event.source && event.source !== htmlFrameRef.current.contentWindow) return;
      // 身份不符：内容来自别的文件/工作区，直接判定失败，不展示。
      if (data.identity && !identityMatches(identityRef.current, data.identity)) {
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr("预览内容与当前文件身份不一致，已停止展示");
        return;
      }
      if (data.type === "unsupported") { setPreviewState(PREVIEW_STATE.UNSUPPORTED); setPreviewErr(""); }
      else if (data.type === "error") { setPreviewState(PREVIEW_STATE.FAILED); setPreviewErr(data.message || "预览渲染失败"); }
      else if (data.type === "ready") { setPreviewState(PREVIEW_STATE.READY); setPreviewErr(""); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [docKey]);

  const fetchComments = useCallback(async () => {
    if (!doc) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    setCommentsLoading(true);
    try {
      const r = await scopedFetch("comments", urls.comments);
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      const d = await r.json();
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      if (!identityOk(d?.identity)) {
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr("批注响应与当前文件身份不一致，已丢弃");
        return;
      }
      setComments(d.comments || []);
    } catch (e) {
      if (e?.name !== "AbortError") console.error("获取批注失败:", e);
    } finally {
      if (gen === generationRef.current && key === docKeyRef.current) setCommentsLoading(false);
    }
  }, [doc, urls, scopedFetch, identityOk]);

  // 切换/打开文件时重置标注状态 + 加载服务端 annotations
  useEffect(() => {
    // 进入新文件：递增 generation 并取消所有在途预览请求，旧结果不得写入。
    generationRef.current += 1;
    for (const controller of abortMapRef.current.values()) { try { controller.abort(); } catch {} }
    abortMapRef.current.clear();
    // text / xlsx / htmlfile / cad 的内容已随 open 响应返回并经身份核对，可直接 ready；
    // 其余格式（docx/pptx/pdf/html）还要经过渲染或 iframe 加载，先置 loading。
    const localReady = doc?.kind === "text" || doc?.kind === "code" || doc?.kind === "xlsx" || doc?.kind === "htmlfile" || doc?.kind === "cad";
    setPreviewState(localReady ? PREVIEW_STATE.READY : PREVIEW_STATE.LOADING);
    setPreviewErr("");
    setWatchUrl(null);
    setWatchLoading(false);
    setWatchErr("");
    setComments([]);
    setCommentsOpen(false);
    setAnnoMode(false);
    setAnnoToolbar(null);
    setAnnoInput(null);
    setAnnoLoaded(false);
    setIframeReady(false);
    iframeReadyRef.current = false;
    lastSavedJsonRef.current = "[]";
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    // DOCX/PPTX 由专用查看器自己读取批注/原始文件；这里不要再触发一轮
    // OfficeCLI 查询，否则每次点击 Word 预览都会重复启动一次读取进程。
    if ((doc?.kind === "html" && !isOfficePreview) || doc?.kind === "text") {
      fetchComments();
    }
    if (isHtmlKind && !isOfficePreview) {
      const gen = generationRef.current;
      scopedFetch("annotations", urls.annotations)
        .then((r) => {
          if (gen !== generationRef.current) return null;
          return r.json();
        })
        .then((d) => {
          if (!d || gen !== generationRef.current) return;
          if (!identityOk(d.identity)) {
            setPreviewState(PREVIEW_STATE.FAILED);
            setPreviewErr("标注响应与当前文件身份不一致，已丢弃");
            return;
          }
          const list = d.annotations || [];
          setAnnotations(list);
          setAnnoLoaded(true);
          lastSavedJsonRef.current = JSON.stringify(list);
        })
        .catch((e) => { if (e?.name !== "AbortError") console.error("加载标注失败:", e); });
    } else {
      setAnnotations([]);
      setAnnoLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, doc?.kind, isOfficePreview, isHtmlKind]);

  const startLive = useCallback(async () => {
    if (!doc) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    setWatchLoading(true);
    setWatchErr("");
    try {
      const r = await scopedFetch("watch", urls.watch).then((x) => x.json());
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      if (r.ok) {
        setWatchUrl(r.url);
      } else {
        setWatchErr(r.error || "启动实时预览失败");
      }
    } catch (e) {
      if (e?.name !== "AbortError") setWatchErr("网络错误: " + e.message);
    } finally {
      if (gen === generationRef.current && key === docKeyRef.current) setWatchLoading(false);
    }
  }, [doc, urls, scopedFetch]);

  const stopLive = useCallback(() => {
    setWatchUrl(null);
    // 通知服务端停止该文件的 watch，避免切换静态预览后进程长期驻留。
    try { scopedFetch("watch", urls.watchStop, { method: "POST" }).catch(() => {}); } catch {}
  }, [urls, scopedFetch]);

  const mdContentRef = useRef(null);
  const htmlFrameRef = useRef(null);
  const [showComments, setShowComments] = useState(false);
  const [activeComment, setActiveComment] = useState(null);

  // annotations 变化 → 防抖保存（带文件身份，切文件后不再写回旧文件）
  useEffect(() => {
    if (!isHtmlKind || !annoLoaded) return;
    const json = JSON.stringify(annotations);
    if (json === lastSavedJsonRef.current) return;
    const key = docKey;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (key !== docKeyRef.current) return;
      lastSavedJsonRef.current = json;
      fetch(urls.annotations, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations }),
      }).catch((e) => console.error("保存标注失败:", e));
    }, ANNO_SAVE_DEBOUNCE);
  }, [annotations, docKey, urls, isHtmlKind, annoLoaded]);

  // iframe onload → 只代表页面已加载（partial）；内容身份由 postMessage 确认后才 ready。
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    setIframeReady(true);
    setPreviewState((prev) => (prev === PREVIEW_STATE.FAILED ? prev : PREVIEW_STATE.PARTIAL));
  }, []);

  // ready + annotations 变化都触发恢复（首次 + 新增项）
  useEffect(() => {
    if (!iframeReady || !annoLoaded || !isHtmlKind) return;
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!doc || !doc.body) return;
    // 等 body 就绪（srcDoc 下可能下一帧才解析完）
    const restore = () => restoreAnnotationsInDoc(doc, annotations);
    // 恢复函数本身有"已包裹跳过"逻辑，重复调用安全
    restore();
    // 下一次微任务再补一次，规避某些浏览器首次挂载时机问题
    const raf = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(raf);
  }, [iframeReady, annoLoaded, annotations, isHtmlKind]);

  // 标注模式开启 → 在 iframe 文档内绑定 mouseup/scroll 监听
  useEffect(() => {
    if (!annoMode || !isHtmlKind) {
      setAnnoToolbar(null);
      setAnnoInput(null);
      return;
    }
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc;
    try {
      innerDoc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!innerDoc || !innerDoc.body) return;

    const onMouseUp = () => {
      const sel = innerDoc.getSelection ? innerDoc.getSelection() : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setAnnoToolbar(null);
        return;
      }
      const text = sel.toString();
      if (!text || !text.trim()) {
        setAnnoToolbar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const coords = selectionToContainerCoords(iframe, range);
      if (!coords) {
        setAnnoToolbar(null);
        return;
      }
      setAnnoInput(null);
      // 选区还在时就把锚点（上下文 + 出现序号）算好，保存后恢复才定位得准
      setAnnoToolbar({ ...coords, text: text.trim(), anchor: buildAnnotationAnchor(innerDoc.body, range) });
    };

    const onScroll = () => {
      setAnnoToolbar(null);
      setAnnoInput(null);
    };

    const onIframeWinScroll = () => {
      setAnnoToolbar(null);
      setAnnoInput(null);
    };

    innerDoc.addEventListener("mouseup", onMouseUp);
    innerDoc.addEventListener("scroll", onScroll, true);
    if (iframe.contentWindow) {
      iframe.contentWindow.addEventListener("scroll", onIframeWinScroll, true);
    }

    return () => {
      innerDoc.removeEventListener("mouseup", onMouseUp);
      innerDoc.removeEventListener("scroll", onScroll, true);
      if (iframe.contentWindow) {
        iframe.contentWindow.removeEventListener("scroll", onIframeWinScroll, true);
      }
    };
  }, [annoMode, isHtmlKind]);

  // 标注模式切换（关闭时清空工具条）
  const toggleAnnoMode = useCallback(() => {
    setAnnoMode((v) => {
      if (v) {
        setAnnoToolbar(null);
        setAnnoInput(null);
      }
      return !v;
    });
  }, []);

  // 高亮：包 mark.oa-anno-hl
  const handleHighlight = useCallback(() => {
    if (!annoToolbar) return;
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc;
    try {
      innerDoc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!innerDoc) return;
    const sel = innerDoc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    try {
      const wrap = innerDoc.createElement("mark");
      wrap.className = "oa-anno-hl";
      range.surroundContents(wrap);
      sel.removeAllRanges();
      const newAnno = {
        id: `${Date.now()}-h${Math.random().toString(36).slice(2, 6)}`,
        type: "highlight",
        text: annoToolbar.text,
        // 锚点：上下文 + 出现序号，避免同文多处时恢复错位
        ...(annoToolbar.anchor || {}),
        created: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
      setAnnoToolbar(null);
    } catch (e) {
      console.warn("高亮包裹失败（选区可能跨元素）:", e);
    }
  }, [annoToolbar]);

  // 进入批注输入态
  const handleCommentClick = useCallback(() => {
    if (!annoToolbar) return;
    setAnnoInput({ mode: "comment", text: annoToolbar.text, anchor: annoToolbar.anchor || null, value: "" });
  }, [annoToolbar]);

  // 进入交给 agent 输入态
  const handleAgentClick = useCallback(() => {
    if (!annoToolbar) return;
    setAnnoInput({ mode: "agent", text: annoToolbar.text, value: "" });
  }, [annoToolbar]);

  // 提交内联输入
  const submitInput = useCallback(() => {
    if (!annoInput) return;
    const val = (annoInput.value || "").trim();
    if (annoInput.mode === "comment") {
      if (!val) {
        setAnnoInput(null);
        setAnnoToolbar(null);
        return;
      }
      const iframe = htmlFrameRef.current;
      let innerDoc;
      try {
        innerDoc = iframe?.contentDocument;
      } catch (e) {}
      if (innerDoc) {
        const sel = innerDoc.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          let wrapped = false;
          // 尝试直接包裹 u.oa-anno-cm
          try {
            const wrap = innerDoc.createElement("u");
            wrap.className = "oa-anno-cm";
            wrap.title = val;
            range.surroundContents(wrap);
            wrapped = true;
          } catch (e) {
            // 选区可能跨元素或已被高亮包裹；尝试退而求其次
            try {
              const wrap = innerDoc.createElement("u");
              wrap.className = "oa-anno-cm";
              wrap.title = val;
              wrap.textContent = annoInput.text;
              range.extractContents();
              range.insertNode(wrap);
              wrapped = true;
            } catch (e2) {
              console.warn("批注包裹失败:", e2);
            }
          }
          if (wrapped) sel.removeAllRanges();
        }
      }
      const newAnno = {
        id: `${Date.now()}-c${Math.random().toString(36).slice(2, 6)}`,
        type: "comment",
        text: annoInput.text,
        note: val,
        ...(annoInput.anchor || {}), // 锚点：上下文 + 出现序号
        created: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
    } else if (annoInput.mode === "agent") {
      if (!val) {
        setAnnoInput(null);
        setAnnoToolbar(null);
        return;
      }
      if (onInsertContext || onSendToAgent) {
        const msg = `在当前打开的 ${doc.name} 中，对选中内容「${annoInput.text}」做修改：${val}`;
        try {
          (onInsertContext || onSendToAgent)(msg);
        } catch (e) {
          console.error("onSendToAgent 调用失败:", e);
        }
      }
    }
    setAnnoInput(null);
    setAnnoToolbar(null);
  }, [annoInput, doc, onInsertContext, onSendToAgent]);

  if (loading && !doc.kind) {
    return (
      <div className="docview-body">
        <div className="empty-view">
          <div className="loading-spinner"></div>
          <div>正在加载文件...</div>
        </div>
      </div>
    );
  }

  // 浮动工具条按钮样式辅助
  const agentDisabled = !onSendToAgent;

  return (
    <>
      <div className="docview-head">
        <span className="doc-title" title={doc.name}>{doc.name}</span>
        {/* 状态只留一个圆点（标题行不再堆文字徽标）；失败等异常仍走下方警示行 */}
        <span
          className={`preview-state-dot preview-state-${previewState}`}
          title={previewErr || (PREVIEW_STATE_LABEL[previewState] || previewState)}
          aria-label={PREVIEW_STATE_LABEL[previewState] || previewState}
          role="status"
        />
        {doc.kind === "html" && !isOfficePreview && (
          <>
            {!watchUrl && (
              <button className="btn-sm" onClick={startLive} disabled={watchLoading}>
                {watchLoading ? "启动中..." : "开启实时预览"}
              </button>
            )}
            {watchUrl && (
              <button className="btn-sm" onClick={stopLive}>转为静态预览</button>
            )}
          </>
        )}
        {(doc.kind === "text" || doc.kind === "htmlfile") && (
          <div className="doc-viewmode" role="group" aria-label="预览方式">
            <button type="button" className={`btn-sm ${sourceMode ? "" : "active"}`} onClick={() => setSourceMode(false)}>预览</button>
            <button type="button" className={`btn-sm ${sourceMode ? "active" : ""}`} onClick={() => setSourceMode(true)}>源码</button>
          </div>
        )}
        {doc.truncated && <span className="badge ws-hint" title="文件超过预览上限，仅显示前一部分；可用系统应用打开完整文件">已截断</span>}
        {isHtmlKind && !isOfficePreview && (
          <button
            className={`btn-sm oa-anno-toggle ${annoMode ? "active" : ""}`}
            onClick={toggleAnnoMode}
            title="标注模式：划词高亮/批注"
          >
            <Icon name={annoMode ? "pin" : "comment"} size={12} />
            {annoMode ? "退出标注" : "标注"}
          </button>
        )}
        {(doc.kind === "text" || (doc.kind === "html" && !isOfficePreview)) && (
          <>
            <button
              className="btn-sm"
              onClick={fetchComments}
              disabled={commentsLoading}
              title="刷新批注"
            >
              <Icon name={commentsLoading ? "loading" : "refresh"} size={12} />
            </button>
            <button
              className={`btn-sm comment-btn ${showComments ? "active" : ""}`}
              onClick={() => setShowComments(!showComments)}
            >
              <Icon name="comment" size={12} /> 批注 ({comments.length})
            </button>
          </>
        )}
        {watchErr && <span className="badge err-badge"><Icon name="warning" size={12} /> {watchErr}</span>}
        {previewErr && <span className="badge err-badge"><Icon name="warning" size={12} /> {previewErr}</span>}
        {watchUrl && <span className="badge ws-hint">可点选元素，配合右侧 agent 修改</span>}
        {/* 文档信息：预览能力、编辑能力与排版说明收进 ⓘ，标题行不再堆文字徽标 */}
        <div className="doc-info-wrap" ref={infoWrapRef}>
          <button
            type="button"
            className={`doc-info-btn ${infoOpen ? "active" : ""}`}
            onClick={() => setInfoOpen((value) => !value)}
            aria-haspopup="dialog"
            aria-expanded={infoOpen}
            aria-label="文档信息"
            title="文档信息：预览能力与排版说明"
          >
            <Icon name="info" size={13} />
          </button>
          {infoOpen && (
            <div className="doc-info-pop" role="dialog" aria-label="文档信息">
              <div className="doc-info-head">
                <strong>{capability.label}</strong>
                <span className={`preview-capability preview-capability-${capability.level}`}>{capability.level}</span>
              </div>
              <p>{capability.detail}</p>
              <p className="doc-info-row">编辑能力：{capability.editable || "无"}</p>
              <p className="doc-info-row">文件：{doc.name}</p>
              {/* DESIGN §8：预览方式与类型说明收进 ⓘ，标题行不再常驻文字徽标 */}
              <p className="doc-info-row">格式：{String(doc.ext || "").toUpperCase() || "-"}</p>
              {doc.kind === "html" && !isOfficePreview && (
                <p className="doc-info-row">预览方式：{watchUrl ? "实时预览（随文件变化刷新）" : "静态预览"}</p>
              )}
              {doc.kind === "code" && <p className="doc-info-row">语言：{doc.language || doc.ext || "text"}</p>}
              {doc.truncated && <p className="doc-info-row">内容：超过预览上限，仅显示前一部分</p>}
            </div>
          )}
        </div>
      </div>
      {commentsOpen && comments.length > 0 && !showComments && (
        <div className="comments-panel">
          <div className="comments-head">文档批注</div>
          {comments.map((c, i) => (
            <div className="comment-item" key={i}>
              <div className="comment-meta">
                <span className="comment-author">{c.author || "匿名"}</span>
                {c.date && <span className="comment-date">{String(c.date).slice(0, 10)}</span>}
              </div>
              <div className="comment-text">{c.text}</div>
              {c.path && <div className="comment-path">{c.path}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="docview-body">
        {doc.kind === "code" && (
          <CodeViewerBoundary key={`${docKey}:code:${codeRetry}`} onRetry={() => setCodeRetry((value) => value + 1)}>
            <React.Suspense fallback={<div className="code-viewer-loading" role="status">正在加载源码…</div>}>
              <CodeViewer content={doc.content} language={doc.language} fileName={doc.name} truncated={doc.truncated} />
            </React.Suspense>
          </CodeViewerBoundary>
        )}
        {sourceMode && (doc.kind === "text" || doc.kind === "htmlfile") && (
          <CodeViewerBoundary key={`${docKey}:source:${codeRetry}`} onRetry={() => setCodeRetry((value) => value + 1)}>
            <React.Suspense fallback={<div className="code-viewer-loading" role="status">正在加载源码…</div>}>
              <CodeViewer
                content={doc.content}
                language={doc.kind === "htmlfile" ? "html" : (doc.ext === "md" || doc.ext === "markdown" ? "markdown" : "text")}
                fileName={doc.name}
                truncated={doc.truncated}
              />
            </React.Suspense>
          </CodeViewerBoundary>
        )}
        {doc.kind === "html" && doc.ext === "docx" && (
          <DocxViewer name={doc.name} revision={doc.previewRevision} identity={identity} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} onSendToAgent={onSendToAgent} onInsertContext={onInsertContext} onDirtyChange={onDirtyChange} />
        )}
        {doc.kind === "html" && doc.ext === "pptx" && (
          <PptxViewer name={doc.name} revision={doc.previewRevision} identity={identity} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} />
        )}
        {doc.kind === "html" && doc.ext !== "docx" && doc.ext !== "pptx" && (
          <div className="docframe-container">
            <iframe
              ref={htmlFrameRef}
              title={doc.name}
              src={watchUrl || doc.url}
              className="docframe"
              onLoad={handleIframeLoad}
            />
            {annoMode && annoToolbar && !annoInput && (
              <div
                className="oa-anno-toolbar"
                style={{
                  left: Math.max(0, annoToolbar.x),
                  top: Math.max(0, annoToolbar.y - 36),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <button className="oa-anno-btn" onClick={handleHighlight} title="高亮">
                  <Icon name="edit" size={12} />
                  <span>高亮</span>
                </button>
                <button className="oa-anno-btn" onClick={handleCommentClick} title="批注">
                  <Icon name="comment" size={12} />
                  <span>批注</span>
                </button>
                <button
                  className="oa-anno-btn"
                  onClick={handleAgentClick}
                  disabled={agentDisabled}
                  title={agentDisabled ? "未连接 agent" : "交给 agent"}
                >
                  <Icon name="robot" size={12} />
                  <span>交给agent</span>
                </button>
              </div>
            )}
            {annoMode && annoInput && (
              <div
                className="oa-anno-input"
                style={{
                  left: Math.max(0, annoToolbar?.x ?? 0),
                  top: Math.max(0, (annoToolbar?.y ?? 0) - 56),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="oa-anno-input-head">
                  {annoInput.mode === "comment" ? "添加批注" : "交给 agent 的指令"}
                </div>
                <div className="oa-anno-input-body">
                  <input
                    type="text"
                    autoFocus
                    value={annoInput.value}
                    placeholder={annoInput.mode === "comment" ? "写下你的批注..." : "例如：把这段改成红色加粗"}
                    onChange={(e) =>
                      setAnnoInput((prev) => (prev ? { ...prev, value: e.target.value } : prev))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitInput();
                      else if (e.key === "Escape") {
                        setAnnoInput(null);
                        setAnnoToolbar(null);
                      }
                    }}
                  />
                  <button className="oa-anno-btn oa-anno-primary" onClick={submitInput}>
                    确定
                  </button>
                </div>
                <div className="oa-anno-input-hint">
                  选中：「{annoInput.text.slice(0, 30)}{annoInput.text.length > 30 ? "..." : ""}」
                </div>
              </div>
            )}
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={htmlFrameRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
        {doc.kind === "image" && (
          <ImageViewer doc={doc} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} />
        )}
        {doc.kind === "pdf" && (
          <div className="docframe-container">
            <iframe
              title={doc.name}
              src={doc.url}
              className="docframe"
              onLoad={() => setPreviewState((prev) => (prev === PREVIEW_STATE.FAILED ? prev : PREVIEW_STATE.PARTIAL))}
              onError={() => { setPreviewState(PREVIEW_STATE.FAILED); setPreviewErr("PDF 预览加载失败，可用系统应用打开"); }}
            />
          </div>
        )}
        {doc.kind === "xlsx" && <ExcelGrid name={doc.name} sheets={doc.sheets} grids={doc.grids} officeHtmlUrl={urls.html} onDirtyChange={onDirtyChange} />}
        {doc.kind === "cad" && <CadViewer doc={doc} />}
        {doc.kind === "htmlfile" && !sourceMode && (
          <div className="docframe-container">
            <iframe
              ref={htmlFrameRef}
              title={doc.name}
              srcDoc={doc.content || ""}
              className="docframe"
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => { handleIframeLoad(); setPreviewState(PREVIEW_STATE.READY); }}
            />
            {annoMode && annoToolbar && !annoInput && (
              <div
                className="oa-anno-toolbar"
                style={{
                  left: Math.max(0, annoToolbar.x),
                  top: Math.max(0, annoToolbar.y - 36),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <button className="oa-anno-btn" onClick={handleHighlight} title="高亮">
                  <Icon name="edit" size={12} />
                  <span>高亮</span>
                </button>
                <button className="oa-anno-btn" onClick={handleCommentClick} title="批注">
                  <Icon name="comment" size={12} />
                  <span>批注</span>
                </button>
                <button
                  className="oa-anno-btn"
                  onClick={handleAgentClick}
                  disabled={agentDisabled}
                  title={agentDisabled ? "未连接 agent" : "交给 agent"}
                >
                  <Icon name="robot" size={12} />
                  <span>交给agent</span>
                </button>
              </div>
            )}
            {annoMode && annoInput && (
              <div
                className="oa-anno-input"
                style={{
                  left: Math.max(0, annoToolbar?.x ?? 0),
                  top: Math.max(0, (annoToolbar?.y ?? 0) - 56),
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="oa-anno-input-head">
                  {annoInput.mode === "comment" ? "添加批注" : "交给 agent 的指令"}
                </div>
                <div className="oa-anno-input-body">
                  <input
                    type="text"
                    autoFocus
                    value={annoInput.value}
                    placeholder={annoInput.mode === "comment" ? "写下你的批注..." : "例如：把这段改成红色加粗"}
                    onChange={(e) =>
                      setAnnoInput((prev) => (prev ? { ...prev, value: e.target.value } : prev))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitInput();
                      else if (e.key === "Escape") {
                        setAnnoInput(null);
                        setAnnoToolbar(null);
                      }
                    }}
                  />
                  <button className="oa-anno-btn oa-anno-primary" onClick={submitInput}>
                    确定
                  </button>
                </div>
                <div className="oa-anno-input-hint">
                  选中：「{annoInput.text.slice(0, 30)}{annoInput.text.length > 30 ? "..." : ""}」
                </div>
              </div>
            )}
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={htmlFrameRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
        {doc.kind === "text" && !sourceMode && (
          <div className="mdview-container">
            <MarkdownToc content={doc.content} targetRef={mdContentRef} />
            <div className="mdview" ref={mdContentRef}>
              <div className="markdown-body">
                <MarkdownBody withToc>{doc.content || ""}</MarkdownBody>
              </div>
            </div>
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={mdContentRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default function DocViewer({ tabs = [], activeTab, onSwitchTab, onCloseTab, onOpenFile, loading, onSendToAgent, onInsertContext, hideTabBar = false, onDirtyChange }) {
  // activeTab 是标签 id（工作区 + 相对路径），兼容旧数据仍可能传文件名。
  const doc = tabs.find((t) => (t.id || t.name) === activeTab) || null;
  useEffect(() => { onDirtyChange?.(false); }, [doc?.id, onDirtyChange]);
  const tabId = (t) => t.id || t.name;
  // 标签副标题：不同工作区的同名文件用工作区末段提示，便于区分。
  const workspaceHint = (t) => {
    const ws = t.identity?.workspaceId || t.identity?.cwd || "";
    const parts = String(ws).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };

  // 本机原生操作：用系统默认应用打开 / 在文件管理器中显示（服务端做路径白名单校验）
  const handleNative = async (action) => {
    if (!doc?.name) return;
    try {
      if (action === "reveal") await revealInSystem(doc.name);
      else await openInSystem(doc.name);
    } catch (error) {
      notifyError(`${action === "reveal" ? "在文件管理器中显示" : "用系统应用打开"}失败：${error.message}`);
    }
  };

  return (
    <div className="docview">
      {/* 文件 tab 栏（类似浏览器标签页）；画布模式把标签提升到画布顶部时隐藏 */}
      {!hideTabBar && tabs.length > 0 && (
        <div className="doc-tabs">
          {tabs.map((t) => (
            <div
              key={tabId(t)}
              role="tab"
              tabIndex={0}
              aria-selected={tabId(t) === activeTab}
              className={`doc-tab ${tabId(t) === activeTab ? "active" : ""}`}
              onClick={() => onSwitchTab && onSwitchTab(tabId(t))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSwitchTab && onSwitchTab(tabId(t)); }
              }}
              title={workspaceHint(t) ? `${t.name} — ${workspaceHint(t)}` : t.name}
            >
              {/* 页签图标与文件树共用同一套扁平类型图标（DESIGN §5.8），避免预览区图标漂移 */}
              <span className="doc-tab-icon"><文件类型图标 file={{ name: t.name }} size={14} /></span>
              <span className="doc-tab-name">{t.name}</span>
              <button
                type="button"
                className="doc-tab-close"
                aria-label={`关闭 ${t.name}`}
                title={`关闭 ${t.name}`}
                onClick={(e) => { e.stopPropagation(); onCloseTab && onCloseTab(tabId(t)); }}
              ><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      {/* 本机原生操作条：与预览器无关，任何格式都可用（图片/Excel/PDF 等用系统应用打开） */}
      {doc && (
        <div className="doc-native-actions">
          <span className="doc-native-name" title={doc.name}><文件类型图标 file={{ name: doc.name }} size={14} /> {doc.name}</span>
          <span className="doc-native-spacer" />
          <button type="button" className="btn-xs" onClick={() => handleNative("open")} title="用系统默认应用打开（例如 WPS/Word/预览/浏览器）">
            <Icon name="externalLink" size={12} /> 用系统应用打开
          </button>
          <button type="button" className="btn-xs" onClick={() => handleNative("reveal")} title="在文件管理器中显示该文件">
            <Icon name="folderOpen" size={12} /> 在文件管理器中显示
          </button>
        </div>
      )}
      {!doc ? (
        <div className="docview-body">
          <div className="empty-view">
            <div>从左侧选择一个文件</div>
            <div className="hint">.docx / .xlsx / .pptx / .md / .html — 支持多标签打开</div>
          </div>
        </div>
      ) : (
        <DocContent doc={doc} loading={loading} onSendToAgent={onSendToAgent} onInsertContext={onInsertContext} onDirtyChange={onDirtyChange} />
      )}
    </div>
  );
}
