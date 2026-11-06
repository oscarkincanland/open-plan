import React, { useState, useRef, useEffect, useCallback } from "react";
import Icon from "./Icon.jsx";
import { loadSettings } from "./SettingsPanel.jsx";
import { motionScrollBehavior } from "../界面外观.js";
import { scrollToElementInContainer } from "./文档定位.js";

/**
 * 批注组件（Word 风格）
 * - 批注列表（右侧栏）：点击 → 定位到文档对应段落
 * - 定位效果：段落黄色高亮 + 段落前插入编号徽标 + 滚动居中
 * - 文档正文关键词匹配失败时回退到段落级匹配
 */
export default function CommentMarker({ comments, containerRef, activeComment, setActiveComment }) {
  const [hoveredComment, setHoveredComment] = useState(null);
  const highlightTimerRef = useRef(null);
  const badgeTimerRef = useRef(null);

  // 清理高亮和徽标
  const clearVisuals = useCallback(() => {
    if (containerRef?.current) {
      const c = containerRef.current;
      const doc = c.tagName === "IFRAME" ? (c.contentDocument || null) : c;
      if (doc) {
        doc.querySelectorAll(".comment-highlight-active").forEach((el) => el.classList.remove("comment-highlight-active"));
        doc.querySelectorAll(".comment-anchor-badge").forEach((el) => el.remove());
      }
    }
  }, [containerRef]);

  // 从批注指令中提取正文可能包含的关键词（4+ 字符中文/英文串）
  const extractKeywords = useCallback((text) => {
    const clean = (text || "")
      .replace(/\[当前打开文件:?[^\]]*\]/g, " ")
      .replace(/[模式:[^\]]*\]/g, " ")
      .replace(/^[@#@]\S+\s*/g, " ");
    const kws = [];
    // 中文连续片段
    const cn = clean.match(/[\u4e00-\u9fa5]{4,}/g) || [];
    // 英文/数字连续片段
    const en = clean.match(/[A-Za-z0-9._-]{4,}/g) || [];
    for (const w of cn) kws.push(w);
    for (const w of en) kws.push(w);
    return kws;
  }, []);

  // 收集 docx-preview 渲染出的批注锚点，按「批注 id → 节点」建映射。
  //
  // 为什么不能用数组下标：docx-preview 为每条批注生成**两个** HTML 注释节点
  //   ① "start of comment #N"（范围起点，docx-preview.js renderCommentRangeStart）
  //   ② "comment #N by <author> on <date>"（引用处，renderCommentReference）
  // 旧实现把两类都塞进同一数组再按批注序号取数组下标，
  // 于是从第 2 条起整体偏前一位 → 几乎所有批注都跳到上一条的位置。
  // 现在从注释文本里解析出批注 id 精确匹配，与顺序/条数无关。
  const collectCommentAnchors = useCallback((doc, container) => {
    const anchors = new Map(); // id(number) -> { start, ref }
    try {
      const docObj = doc && doc.nodeType === 9 ? doc : (doc?.ownerDocument || doc);
      const walker = docObj.createNodeIterator(container, NodeFilter.SHOW_COMMENT, null);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || "").trim();
        const m = t.match(/^(start of comment|comment) #(\d+)/);
        if (!m) continue;
        const id = Number(m[2]);
        if (!Number.isFinite(id)) continue;
        const entry = anchors.get(id) || { start: null, ref: null };
        if (m[1] === "start of comment") {
          if (!entry.start) entry.start = n;
        } else if (!entry.ref) {
          entry.ref = n;
        }
        anchors.set(id, entry);
      }
    } catch { /* 非 DOM 容器（如未渲染完成的 iframe） */ }
    return anchors;
  }, []);

  /** 取锚点里最靠前的那一类：范围起点优先（更贴近被批注的正文），其次引用处。 */
  const anchorNodeOf = (anchors, id) => {
    const entry = anchors?.get(Number(id));
    return entry ? (entry.start || entry.ref || null) : null;
  };

  // 从注释锚点向上找最近的块级元素（段落）
  const findBlockAncestor = useCallback((el, root) => {
    let cur = el;
    while (cur && cur !== root) {
      if (/^(P|H1|H2|H3|H4|H5|H6|LI|TD|TH|BLOCKQUOTE|PRE)$/.test(cur.tagName)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }, []);

  // 定位批注对应段落（优先级：批注 id 锚点 → 文档顺序兜底 → 关键词兜底）
  const findCommentElement = useCallback((comment, index) => {
    if (!containerRef?.current) return null;
    const container = containerRef.current;
    const doc = container.tagName === "IFRAME" ? (container.contentDocument || container.contentWindow?.document) : container;
    if (!doc) return null;

    const anchors = collectCommentAnchors(doc, container);

    // 1) 首选：服务端回传的 commentId 精确命中（与文档顺序、批注条数无关）
    const byId = anchorNodeOf(anchors, comment?.id);
    if (byId) {
      const para = findBlockAncestor(byId.parentElement, container);
      if (para) return para;
    }

    // 2) 显式 path / data-comment-id
    if (comment.path) {
      const el = doc.querySelector(`[data-path="${comment.path}"], [data-comment-id="${comment.id}"]`);
      if (el) return el;
    }

    // 3) 没有 id 时按文档顺序兜底：把锚点 id 升序排好，取第 index 个
    //    （仅当服务端未提供 id 的旧响应才会走到这里）
    if (!comment?.id && anchors.size && typeof index === "number") {
      const orderedIds = [...anchors.keys()].sort((a, b) => a - b);
      const node = anchorNodeOf(anchors, orderedIds[index]);
      if (node) {
        const para = findBlockAncestor(node.parentElement, container);
        if (para) return para;
      }
    }

    // 4) 最后兜底：关键词匹配。批注正文与正文通常没有交集，只在前面全部落空时使用；
    //    且从当前视口附近开始找，避免恒命中文档最前面一个偶然同词段落。
    const keywords = extractKeywords(comment.text);
    if (keywords.length) {
      const candidates = Array.from(doc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th"));
      const containerRect = container.getBoundingClientRect();
      const near = (el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.top - containerRect.top - containerRect.height / 2);
      };
      for (const kw of [...keywords].sort((a, b) => b.length - a.length)) {
        const hits = candidates.filter((el) => el.textContent.includes(kw));
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) return hits.sort((a, b) => near(a) - near(b))[0];
      }
    }

    // 5) 仍无命中但有锚点：回到该 id 的锚点（即使是引用处）
    const fallbackAnchor = anchorNodeOf(anchors, comment?.id);
    if (fallbackAnchor) return findBlockAncestor(fallbackAnchor.parentElement, container);
    return null;
  }, [containerRef, extractKeywords, collectCommentAnchors, findBlockAncestor]);

  // 点击批注：定位 + 高亮 + 徽标
  const handleCommentClick = useCallback((comment, index) => {
    setActiveComment?.(index);
    clearVisuals();
    const el = findCommentElement(comment, index);
    if (el) {
      const container = containerRef.current;
      const doc = container?.tagName === "IFRAME"
        ? (container.contentDocument || null)
        : container;
      // 段落级高亮
      el.classList.add("comment-highlight-active");
      // 段落前插入编号徽标（Word 风格）
      if (doc) {
        // createElement 是 Document 的方法；doc 可能是 Element（div 容器）
        const docObj = doc.nodeType === 9 ? doc : (doc.ownerDocument || doc);
        const badge = docObj.createElement("span");
        badge.className = "comment-anchor-badge";
        badge.textContent = String(index + 1);
        badge.style.position = "absolute";
        // 徽标必须挂在"页面"里：docx 页面（section）自身是定位上下文，
        // 挂在 host/body 上会以整个文档为参照，既跑位又会把页面撑出大片空白。
        const pageEl = el.closest("section.oaw-docx") || (doc.body || container);
        const baseRect = pageEl.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        badge.style.left = Math.max(4, rect.left - baseRect.left - 26) + "px";
        badge.style.top = Math.max(0, rect.top - baseRect.top) + "px";
        badge.style.zIndex = "50";
        pageEl.appendChild(badge);
      }
      // 只滚动预览容器，避免把整个工作台/页面一起滚动（zoom 换算走 文档定位.js）
      const scroller = container && container.tagName !== "IFRAME" ? container : null;
      if (scroller) {
        scrollToElementInContainer(scroller, el, { center: true, behavior: motionScrollBehavior() });
      } else {
        el.scrollIntoView({ behavior: motionScrollBehavior(), block: "center" });
      }
      // 高亮保持时长（设置面板可调，默认 20 秒）
      const ms = loadSettings().commentHighlightMs || 20000;
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => el.classList.remove("comment-highlight-active"), ms);
      clearTimeout(badgeTimerRef.current);
      badgeTimerRef.current = setTimeout(clearVisuals, ms);
    }
  }, [containerRef, findCommentElement, clearVisuals, setActiveComment]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    };
  }, []);

  if (!comments || comments.length === 0) return null;

  return (
    <div className="comment-marker-panel">
      <div className="comment-marker-header">
        <span className="comment-marker-icon"><Icon name="comment" size={14} /></span>
        <span>批注 ({comments.length})</span>
        <span className="comment-marker-tip">点击定位到文档段落</span>
      </div>
      <div className="comment-marker-list">
        {comments.map((c, i) => (
          <div
            key={i}
            className={`comment-marker-item ${activeComment === i ? "active" : ""} ${hoveredComment === i ? "hovered" : ""}`}
            onClick={() => handleCommentClick(c, i)}
            onMouseEnter={() => setHoveredComment(i)}
            onMouseLeave={() => setHoveredComment(null)}
          >
            <div className="comment-marker-index">{i + 1}</div>
            <div className="comment-marker-content">
              <div className="comment-marker-author">{c.author || "匿名"}</div>
              <div className="comment-marker-text">{c.text}</div>
              {c.path && <div className="comment-marker-path">{c.path}</div>}
            </div>
            <div className="comment-marker-locate" title="定位到段落">
              <Icon name="pin" size={14} />
            </div>
          </div>
        ))}
      </div>
      <div className="comment-marker-footer">点击批注定位到文档对应段落（黄底高亮 + 编号徽标）</div>
    </div>
  );
}
