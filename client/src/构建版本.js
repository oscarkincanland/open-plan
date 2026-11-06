/**
 * 构建版本守卫：检测服务端已换成新构建后提示刷新。
 *
 * ## 为什么需要
 *
 * `index.html` 是 no-store、`assets/*` 带 hash 强缓存，**手动刷新一定能拿到新构建**。
 * 但浏览器不会主动重新拉取 index.html，所以部署新构建后已打开的页面会一直跑旧代码。
 * 叠加 `dist/assets` 刻意保留历史包（旧页面懒加载不 404），连"分包 404 → 自动刷新"
 * 这条兜底也触发不了。
 *
 * 后果是修好并上线的问题，用户在旧页面上看还是老样子（2026-11-02 的会话加载超时
 * 修复就被误判为"没修好"）。这里补一条"构建变了就说一声"的通道。
 *
 * ## 做法
 *
 * 1. 从本页实际加载的 `<script src=".../assets/index-<hash>.js">` 取当前构建 id；
 * 2. 每 60 秒（仅页面可见时）问一次 /api/status 的 clientBuild；
 * 3. 不一致就回调，由界面提示"检测到新版本，点此刷新"。
 *
 * 不自动刷新：任务可能在跑，强制刷新会打断用户；只做提示。
 */

/** 本页实际加载的入口脚本文件名（如 `index-4rjN3GS-.js`）；取不到返回空串。 */
export function currentBuildId() {
  if (typeof document === "undefined") return "";
  try {
    const scripts = [...document.querySelectorAll("script[src]")];
    for (const script of scripts) {
      const src = String(script.getAttribute("src") || "");
      const name = src.split(/[?#]/)[0].split("/").pop() || "";
      if (/^index-.*\.js$/i.test(name)) return name;
    }
  } catch {
    /* DOM 不可用：当作未知 */
  }
  return "";
}

/**
 * 轮询服务端构建标识，与本地不一致时回调。
 * 返回取消函数（组件卸载时调用）。
 *
 * @param {(info: { running: string, latest: string }) => void} onChange
 */
export function watchBuildChange(onChange, { intervalMs = 60000 } = {}) {
  if (typeof window === "undefined" || typeof fetch !== "function") return () => {};
  const running = currentBuildId();
  // 取不到自己的入口（开发模式 / 被内联）：不做判断，避免误报。
  if (!running) return () => {};

  let stopped = false;
  let timer = null;

  const check = async () => {
    if (stopped || document.visibilityState !== "visible") return;
    try {
      const response = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const status = await response.json();
      const latest = String(status?.clientBuild || "");
      // 服务端读不到 index.html 时 latest 为空：视为未知，不惊动用户。
      if (stopped || !latest || latest === running) return;
      onChange?.({ running, latest });
      stop();
    } catch {
      /* 网络/超时：下一轮再试 */
    }
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  timer = setInterval(check, intervalMs);
  // 页面从后台回来时立刻查一次，不必等满一个周期。
  const onVisible = () => { if (!stopped && document.visibilityState === "visible") void check(); };
  document.addEventListener("visibilitychange", onVisible);
  void check();

  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
