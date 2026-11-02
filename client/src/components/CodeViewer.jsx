import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  keymap,
} from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import Icon from "./Icon.jsx";

/**
 * 只读源码查看器（类 VSCode 的基础体验）。
 *
 * - CodeMirror 6：行号、语法高亮、搜索（Ctrl/Cmd+F）、选区、复制；
 * - 只读：不执行、不保存，不提供终端；
 * - 语言按需加载（@codemirror/language-data），未知语言回退纯文本；
 * - 颜色全部走 --code-* 令牌，跟随明暗主题。
 */
const appHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--code-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-number)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--code-function)" },
  { tag: [tags.typeName, tags.className, tags.definition(tags.typeName)], color: "var(--code-type)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--code-attr)" },
  { tag: [tags.tagName, tags.angleBracket], color: "var(--code-tag)" },
  { tag: [tags.heading], color: "var(--accent)", fontWeight: "700" },
  { tag: [tags.link, tags.url], color: "var(--code-string)", textDecoration: "underline" },
]);

const appTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--code-font-size, 12.5px)", color: "var(--text)", backgroundColor: "transparent" },
  ".cm-scroller": { overflow: "auto", fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace' },
  ".cm-content": { padding: "12px 0", lineHeight: "1.65", caretColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--dim)", border: "none", paddingRight: "4px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "32px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-panels": { backgroundColor: "var(--panel2-bg)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 28%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)" },
});

function languageDescription(language) {
  const key = String(language || "").toLowerCase();
  if (!key || key === "text") return null;
  return languages.find((item) => item.name.toLowerCase() === key || (item.alias || []).some((alias) => String(alias).toLowerCase() === key)) || null;
}

export default function CodeViewer({ content = "", language = "text", fileName = "", truncated = false }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const wrapCompartment = useRef(new Compartment());
  const [ready, setReady] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [fontSize, setFontSize] = useState(12.5);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let view = null;
    setReady(false);
    setError("");
    (async () => {
      const extensions = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([...defaultKeymap, ...searchKeymap]),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        appTheme,
        syntaxHighlighting(appHighlight),
        wrapCompartment.current.of([]),
      ];
      const description = languageDescription(language);
      if (description) {
        try {
          const support = await description.load();
          if (!cancelled) extensions.push(support);
        } catch {
          // 语言包加载失败不影响纯文本查看
        }
      }
      if (cancelled || !hostRef.current) return;
      try {
        view = new EditorView({
          state: EditorState.create({ doc: String(content || ""), extensions }),
          parent: hostRef.current,
        });
        viewRef.current = view;
        setReady(true);
      } catch (loadError) {
        setError(String(loadError?.message || loadError).slice(0, 200));
      }
    })();
    return () => {
      cancelled = true;
      try { view?.destroy(); } catch {}
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [content, language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    try {
      view.dispatch({ effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
    } catch {}
  }, [wrap]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(content || ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-viewer" style={{ "--code-font-size": `${fontSize}px` }}>
      <div className="code-viewer-toolbar">
        <span className="code-viewer-title" title={fileName}>{fileName || "源码"}</span>
        {language && language !== "text" ? <span className="code-viewer-lang">{language}</span> : null}
        {truncated ? <span className="code-viewer-notice" title="文件超过 2MB，仅显示前 2MB">已截断</span> : null}
        <span className="code-viewer-actions">
          <button type="button" className="btn-xs" onClick={copy} title="复制全文">
            <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "已复制" : "复制"}
          </button>
          <button type="button" className={`btn-xs ${wrap ? "active" : ""}`} onClick={() => setWrap((value) => !value)} title="自动换行">
            <Icon name="wrap" size={12} /> 换行
          </button>
          <button type="button" className="btn-xs" onClick={() => setFontSize((value) => Math.max(11, value - 1))} title="减小字号">A−</button>
          <button type="button" className="btn-xs" onClick={() => setFontSize((value) => Math.min(18, value + 1))} title="增大字号">A+</button>
        </span>
      </div>
      {error ? <div className="code-viewer-error">源码渲染失败：{error}</div> : null}
      {!ready && !error ? <div className="code-viewer-loading" role="status">正在加载源码…</div> : null}
      <div className="code-viewer-host" ref={hostRef} />
    </div>
  );
}
