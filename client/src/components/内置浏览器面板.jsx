import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { browserClose, browserInput, browserOpen, browserState } from "../api.js";

/**
 * 内置浏览器面板（工作产物 → 浏览器）
 *
 * - Agent 调用 browser_* 工具时，画面以帧流（CDP screencast）实时显示在这里；
 * - 用户可直接在画面上点击、输入，随时接管（登录、验证码等）；
 * - 只在有活动会话时建立帧流连接，避免空跑。
 */
/**
 * 地址栏输入解析：URL 原样打开；域名自动补 https://；其余内容当作搜索词走必应搜索。
 */
function resolveTarget(draft) {
  const value = String(draft || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(value)) return `https://${value}`;
  return `https://cn.bing.com/search?q=${encodeURIComponent(value)}`;
}

export default function BrowserPanel({ clientId, threadId, fullscreen = false, onToggleFullscreen }) {
  const [state, setState] = useState({ active: false, url: "", title: "", loading: false, viewport: { width: 1280, height: 800 }, hasFrame: false });
  const [tabs, setTabs] = useState([]);
  const [frame, setFrame] = useState(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [openDraft, setOpenDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const imgRef = useRef(null);
  const sourceRef = useRef(null);
  // 画面是否已出现：img 元素只在有帧后渲染，监听器必须等它挂载后再绑定；
  // 用布尔值而不是 frame 字符串做依赖，避免每 100ms 一帧导致监听器反复重建、拖拽状态被重置。
  const hasFrame = Boolean(frame);

  // Agent 虚拟鼠标：Agent 的点击/输入/滚动等操作以事件流下发，这里叠加显示，与用户鼠标区分。
  const viewRef = useRef(null);
  const [agentAction, setAgentAction] = useState(null);
  const [agentPoint, setAgentPoint] = useState({ nx: 0.5, ny: 0.5 });
  const [agentVisible, setAgentVisible] = useState(false);
  const [imgBox, setImgBox] = useState(null); // 帧画面相对 .browser-view 的像素位置，用于叠加定位
  const agentSeqRef = useRef(0);
  const agentHideTimerRef = useRef(null);

  // 先读取状态，再订阅帧流；这样用户切回“浏览器”页签时不会先看到旧的未启动状态。
  useEffect(() => {
    if (!clientId) return undefined;
    let stopped = false;
    let source = null;
    let retryTimer = null;
    let retryCount = 0;

    const syncState = async () => {
      try {
        const result = await browserState(clientId, threadId || "");
        if (!stopped && result?.state) setState((previous) => ({ ...previous, ...result.state }));
      } catch {}
    };

    const connect = () => {
      if (stopped) return;
      const params = new URLSearchParams({ client: clientId, thread: threadId || "", frames: "1" });
      source = new EventSource(`/api/browser/stream?${params.toString()}`);
      sourceRef.current = source;
      source.onopen = () => { retryCount = 0; setConnected(true); };
      source.onerror = () => {
        setConnected(false);
        try { source.close(); } catch {}
        if (!stopped) {
          const delay = Math.min(10000, 1000 * (2 ** Math.min(retryCount, 3)));
          retryCount += 1;
          retryTimer = setTimeout(connect, delay);
        }
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          if (payload.type === "state") {
            setState((previous) => ({ ...previous, ...(payload.data || {}) }));
          } else if (payload.type === "tabs") {
            setTabs(Array.isArray(payload.data?.tabs) ? payload.data.tabs : []);
          } else if (payload.type === "frame" && payload.data?.data) {
            setFrame(payload.data.data);
          } else if (payload.type === "agent-action") {
            const data = payload.data || {};
            if (Number.isFinite(data.nx) && Number.isFinite(data.ny)) setAgentPoint({ nx: data.nx, ny: data.ny });
            setAgentAction({ ...data, seq: ++agentSeqRef.current });
            setAgentVisible(true);
            if (agentHideTimerRef.current) clearTimeout(agentHideTimerRef.current);
            agentHideTimerRef.current = setTimeout(() => setAgentVisible(false), 6000);
          } else if (payload.type === "closed") {
            setFrame(null);
            setTabs([]);
            setTakeover(false);
            setState((previous) => ({ ...previous, active: false, hasFrame: false }));
          }
        } catch {}
      };
    };
    void syncState();
    connect();

    return () => {
      stopped = true;
      try { source?.close(); } catch {}
      if (retryTimer) clearTimeout(retryTimer);
      if (agentHideTimerRef.current) clearTimeout(agentHideTimerRef.current);
      sourceRef.current = null;
    };
  }, [clientId, threadId]);

  // 所有输入共用一个串行队列：按下/抬起、连续按键必须按顺序到达服务端。
  // 并发 POST 可能乱序（实测 mouseup 先于 mousedown 时 click 不触发、验证码拖动断裂）。
  const inputChainRef = useRef(Promise.resolve());
  const enqueueInput = useCallback((payload) => {
    const run = inputChainRef.current
      .catch(() => {})
      .then(() => browserInput({ client: clientId, thread: threadId || "", ...payload }))
      .then((result) => {
        if (result?.ok === false) setMessage(result.error || "操作失败");
        return result;
      })
      .catch((error) => {
        setMessage(String(error?.message || error));
        return { ok: false, error: String(error?.message || error) };
      });
    inputChainRef.current = run.catch(() => {});
    return run;
  }, [clientId, threadId]);

  const send = useCallback(async (payload) => {
    setBusy(true);
    setMessage("");
    try {
      await enqueueInput(payload);
      if (["click", "pointer", "wheel", "type", "key", "scroll", "back", "reload", "tab_new", "tab_switch", "tab_close"].includes(payload.action)) setTakeover(true);
    } finally {
      setBusy(false);
    }
  }, [enqueueInput]);

  const openUrl = useCallback(async (url) => {
    const target = resolveTarget(url);
    if (!target) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await browserOpen(clientId, threadId || "", target);
      if (result?.ok === false) throw new Error(result.error || "打开网页失败");
      if (result?.state) setState((previous) => ({ ...previous, ...result.state }));
      setOpenDraft(target);
      setUrlDraft("");
      setTakeover(false);
    } catch (error) {
      setMessage(String(error.message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  // 归一化坐标：不受帧缩放与设备像素比影响，由服务端按真实视口换算
  const normalizedPoint = useCallback((event) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      nx: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      ny: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }, []);

  // 鼠标接管：按下 → 拖动 → 抬起（支持滑块验证码/画布/文本选择；单击即按下+抬起）
  const dragRef = useRef({ active: false, lastSentAt: 0 });
  const sendPointer = useCallback((phase, point) => {
    setTakeover(true);
    enqueueInput({ action: "pointer", phase, nx: point.nx, ny: point.ny });
  }, [enqueueInput]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const onDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // preventDefault 会阻止浏览器默认的聚焦行为；手动聚焦保证点击画面后键盘可直输
      try { img.focus({ preventScroll: true }); } catch {}
      const point = normalizedPoint(event);
      if (!point) return;
      dragRef.current.active = true;
      dragRef.current.lastSentAt = Date.now();
      sendPointer("down", point);
    };
    const onMove = (event) => {
      if (!dragRef.current.active) return;
      const now = Date.now();
      if (now - dragRef.current.lastSentAt < 40) return; // 节流，避免刷屏
      const point = normalizedPoint(event);
      if (!point) return;
      dragRef.current.lastSentAt = now;
      sendPointer("move", point);
    };
    const onUp = (event) => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      const point = normalizedPoint(event);
      if (point) sendPointer("up", point);
    };
    img.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      img.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragRef.current.active = false;
    };
    // 注意：不要把 frame 本身放进依赖（每 ~100ms 一帧会反复重建监听器、重置拖拽状态）；
    // 用 hasFrame 布尔值：只在「第一帧出现/画面消失」时重新绑定一次。
  }, [state.active, hasFrame, normalizedPoint, sendPointer]);

  // 滚轮接管：把面板滚轮转发为页面滚动（节流合并，避免刷屏）
  const wheelRef = useRef({ deltaX: 0, deltaY: 0, timer: null, point: null });
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const flush = () => {
      const pending = wheelRef.current;
      pending.timer = null;
      if (!pending.point || (!pending.deltaX && !pending.deltaY)) return;
      const { deltaX, deltaY, point } = pending;
      pending.deltaX = 0;
      pending.deltaY = 0;
      enqueueInput({ action: "wheel", nx: point.nx, ny: point.ny, deltaX, deltaY });
    };
    const onWheel = (event) => {
      event.preventDefault();
      const point = normalizedPoint(event);
      if (!point) return;
      const pending = wheelRef.current;
      pending.point = point;
      pending.deltaX += event.deltaX;
      pending.deltaY += event.deltaY;
      setTakeover(true);
      if (!pending.timer) pending.timer = window.setTimeout(flush, 130);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      img.removeEventListener("wheel", onWheel);
      if (wheelRef.current.timer) window.clearTimeout(wheelRef.current.timer);
    };
  }, [state.active, hasFrame, enqueueInput, normalizedPoint]);

  // 测量帧画面在面板中的实际位置，供 Agent 虚拟鼠标叠加定位（标题栏显隐、面板缩放时自动更新）
  useLayoutEffect(() => {
    const measure = () => {
      const img = imgRef.current;
      const view = viewRef.current;
      if (!img || !view) { setImgBox(null); return; }
      const imgRect = img.getBoundingClientRect();
      const viewRect = view.getBoundingClientRect();
      const next = { left: imgRect.left - viewRect.left, top: imgRect.top - viewRect.top, width: imgRect.width, height: imgRect.height };
      setImgBox((previous) => {
        if (previous
          && Math.abs(previous.left - next.left) < 0.5
          && Math.abs(previous.top - next.top) < 0.5
          && Math.abs(previous.width - next.width) < 0.5
          && Math.abs(previous.height - next.height) < 0.5) return previous;
        return next;
      });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer) {
      if (imgRef.current) observer.observe(imgRef.current);
      if (viewRef.current) observer.observe(viewRef.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hasFrame, state.title, fullscreen]);

  const agentBubble = useMemo(() => {
    if (!agentAction) return "";
    const { kind } = agentAction;
    if (kind === "type") return `输入「${String(agentAction.text || "").slice(0, 40)}」`;
    if (kind === "navigate") return `打开 ${String(agentAction.url || "").replace(/^https?:\/\//, "").slice(0, 46)}`;
    if (kind === "key") return `按键 ${agentAction.key || "Enter"}`;
    if (kind === "scroll") return agentAction.direction === "up" ? "向上滚动" : "向下滚动";
    if (kind === "tab") return agentAction.action === "new" ? "新建标签页" : agentAction.action === "close" ? "关闭标签页" : "切换标签页";
    if (kind === "back") return "返回上一页";
    if (kind === "click") return agentAction.text ? `点击「${String(agentAction.text).slice(0, 28)}」` : "";
    return "";
  }, [agentAction]);

  // 键盘直输：点击画面后可直接打字（ASCII 字符 + 常用按键），IME 中文建议用下方输入行
  const sendQuiet = useCallback((payload) => {
    setTakeover(true);
    enqueueInput(payload);
  }, [enqueueInput]);
  const handleImageKeyDown = useCallback((event) => {
    if (!state.active) return;
    const key = event.key;
    const specialKeys = ["Backspace", "Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Delete"];
    if (specialKeys.includes(key)) {
      event.preventDefault();
      sendQuiet({ action: "key", key });
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      sendQuiet({ action: "type", text: key });
    }
  }, [state.active, sendQuiet]);

  const handleClose = useCallback(async () => {
    setBusy(true);
    try {
      const result = await browserClose(clientId, threadId || "", { force: true });
      setFrame(null);
      setState((previous) => ({ ...previous, active: false }));
      setTakeover(false);
      setMessage(result?.closed ? "浏览器已关闭" : result?.message || "浏览器未关闭");
    } catch (error) {
      setMessage(String(error.message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  const toggleTakeover = useCallback(() => {
    setTakeover((value) => {
      const next = !value;
      setMessage(next ? "已切换为手动操作，点击画面即可操作网页" : "已交还 Agent，Agent 可以继续编排网页");
      return next;
    });
  }, []);

  const statusText = useMemo(() => {
    if (!state.active) return "未启动";
    if (state.loading) return "加载中…";
    return "运行中";
  }, [state.active, state.loading]);

  if (!state.active && !frame) {
    return (
      <div className="browser-panel browser-panel-idle">
        <div className="browser-idle-card">
          <div className="browser-idle-icon"><Icon name="globe" size={22} /></div>
          <div className="browser-idle-heading"><strong>Open Plan 浏览器</strong><span>Agent 与你共用的可视化网页空间</span></div>
          <p>Agent 打开网页后，画面会实时出现在这里。你可以直接点击、拖动、滚动、输入，接管登录、验证码或网页操作；地址栏输入关键词可直接搜索。</p>
          <form className="browser-idle-open" onSubmit={(event) => { event.preventDefault(); openUrl(openDraft); }}>
            <Icon name="link" size={14} />
            <input value={openDraft} onChange={(event) => setOpenDraft(event.target.value)} placeholder="输入网址或搜索内容，例如：浙江省综合交通规划" spellCheck={false} />
            <button type="submit" className="browser-primary-btn" disabled={busy || !openDraft.trim()}><Icon name="arrowRight" size={13} />打开</button>
          </form>
          <div className="browser-quick-links">
            <span>快速打开</span>
            <button type="button" onClick={() => openUrl("https://cn.bing.com")} disabled={busy}>必应</button>
            <button type="button" onClick={() => openUrl("https://www.baidu.com")} disabled={busy}>百度</button>
            <button type="button" onClick={() => openUrl("https://example.com")} disabled={busy}>示例页</button>
          </div>
          <p className="browser-idle-hint">也可以直接对 Agent 说：<em>“打开浏览器，搜索浙江省综合交通规划 2026”</em></p>
          {message && <div className="browser-msg">{message}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-panel">
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            className={`browser-tab ${tab.active ? "active" : ""}`}
            onClick={() => { if (!tab.active) send({ action: "tab_switch", tabId: tab.id }); }}
            title={tab.url || tab.title}
          >
            <span className="browser-tab-title">{tab.title || "新标签页"}</span>
            <button
              type="button"
              className="browser-tab-close"
              title="关闭标签页"
              onClick={(event) => { event.stopPropagation(); send({ action: "tab_close", tabId: tab.id }); }}
            >✕</button>
          </div>
        ))}
        <button type="button" className="browser-tab-new" onClick={() => send({ action: "tab_new", url: "about:blank" })} disabled={busy} title="新建标签页">＋</button>
      </div>
      <div className="browser-toolbar">
        <div className="browser-nav-actions">
          <button className="btn-icon" onClick={() => send({ action: "back" })} disabled={busy} title="后退" aria-label="后退"><Icon name="back" size={13} /></button>
          <button className="btn-icon" onClick={() => send({ action: "reload" })} disabled={busy} title="刷新页面" aria-label="刷新页面"><Icon name="refresh" size={13} /></button>
        </div>
        <form
          className="browser-url-form"
          onSubmit={(event) => { event.preventDefault(); if (urlDraft.trim()) openUrl(urlDraft.trim()); }}
        >
          <Icon name="lock" size={12} />
          <input
            className="browser-url-input"
            value={urlDraft || state.url || ""}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="输入网址或搜索词，回车打开"
            spellCheck={false}
          />
        </form>
        <span className={`browser-status ${state.loading ? "loading" : state.active ? "active" : ""}`} title={state.error || "浏览器连接状态"}>
          <i /> {statusText}
        </span>
        <span className={`browser-connection ${connected ? "online" : "offline"}`}><i />{connected ? "同步中" : "重连中"}</span>
        <span className={`browser-takeover ${takeover ? "is-user" : "is-agent"}`} title={takeover ? "最近一次操作来自你，Agent 仍可继续使用此浏览器" : "Agent 可继续使用此浏览器"}>
          <i />{takeover ? "你在操作" : "Agent 可用"}
        </span>
        <button
          type="button"
          className={`browser-control-toggle ${takeover ? "active" : ""}`}
          onClick={toggleTakeover}
          title={takeover ? "交还 Agent 继续操作" : "切换为手动操作"}
        >
          <Icon name="cursor" size={12} />{takeover ? "交还 Agent" : "接管操作"}
        </button>
        <button
          type="button"
          className="browser-fullscreen-toggle"
          onClick={onToggleFullscreen}
          title={fullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
          aria-label={fullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
        >
          <Icon name={fullscreen ? "minimize" : "maximize"} size={13} />
        </button>
        <button className="btn-icon" onClick={handleClose} disabled={busy} title="关闭浏览器" aria-label="关闭浏览器"><Icon name="close" size={13} /></button>
      </div>
      {state.title && <div className="browser-title" title={state.title}>{state.title}</div>}
      <div className="browser-view" ref={viewRef} title="滚轮滚动 · 单击接管 · 按住拖动可操作滑块">
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="浏览器画面"
            draggable={false}
            tabIndex={0}
            onKeyDown={handleImageKeyDown}
          />
        ) : (
          <div className="browser-placeholder"><span>{state.loading ? "正在加载网页…" : "正在获取画面…"}</span><button className="btn-sm" onClick={() => send({ action: "reload" })} disabled={busy}>重新连接</button></div>
        )}
        {state.active && agentAction && imgBox && (
          <div
            className={`browser-agent-cursor kind-${agentAction.kind} ${agentVisible ? "visible" : ""}`}
            style={{ left: imgBox.left + imgBox.width * agentPoint.nx, top: imgBox.top + imgBox.height * agentPoint.ny }}
            title={agentBubble || "Agent 正在操作"}
          >
            <span key={agentAction.seq} className="browser-agent-ripple" />
            <svg width="18" height="24" viewBox="0 0 18 24" aria-hidden="true">
              <path d="M2 1.5 L2 19.5 L6.6 15.2 L9.6 22 L12.6 20.6 L9.7 14 L16 14 Z" fill="#8b5cf6" stroke="#ffffff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className="browser-agent-tag">Agent</span>
            {agentBubble && <span className="browser-agent-bubble">{agentBubble}</span>}
          </div>
        )}
      </div>
      <div className="browser-hint"><Icon name="cursor" size={11} /> 点击画面后可直接用键盘打字 · 滚轮滚动 · 按住拖动滑块/验证码 · 中文用下方输入行</div>
      <div className="browser-input-row">
        <span className="browser-input-label">向网页输入</span>
        <input
          className="browser-text-input"
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          placeholder="输入文本（先点击页面输入框）"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (textDraft) { send({ action: "type", text: textDraft }); setTextDraft(""); }
            }
          }}
        />
        <button className="btn-sm" disabled={busy || !textDraft} onClick={() => { send({ action: "type", text: textDraft }); setTextDraft(""); }}>输入</button>
        <button className="btn-sm" disabled={busy} onClick={() => send({ action: "key", key: "Enter" })}>回车</button>
        <button className="btn-sm" disabled={busy} onClick={() => send({ action: "scroll", direction: "down" })}>滚动</button>
      </div>
      {message && <div className="browser-msg">{message}</div>}
    </div>
  );
}
