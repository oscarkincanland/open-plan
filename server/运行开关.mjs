/**
 * 运行开关（优化项统一 feature flag 管道）。
 *
 * 评审 R8 约束：所有优化项的开关统一由本模块读取（env 解析 + 默认值 + 只读快照），
 * 禁止各业务模块直读 process.env，避免开关语义分叉；快照经 /api/status 下发前端。
 *
 * 开关语义：
 *   - 每个开关只影响对应优化项的新路径；off（默认）时代码路径与历史基线行为一致。
 *   - 取值：环境变量命中 "1"/"true"/"on"（不区分大小写）视为开启，其余视为关闭。
 */

const TRUTHY = new Set(["1", "true", "on", "yes"]);

function readFlag(name) {
  const raw = String(process.env?.[name] ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

function readPositiveInt(name, fallback) {
  const raw = Number.parseInt(String(process.env?.[name] ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** 逗号/分号分隔的字符串列表（B5 域名白名单等配置型开关）。 */
function readStringList(name) {
  return String(process.env?.[name] ?? "")
    .split(/[,，;；\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** 只读快照：进程内唯一事实。模块加载时解析一次（服务生命周期内不热更）。 */
export const RUNTIME_FLAGS = Object.freeze({
  /** U2+U6：Pi 把关扩展（ToolCallEvent 单工具拦截 + 压缩生命周期事件增强） */
  piToolGateExtension: readFlag("OAW_PI_TOOL_GATE"),
  /** U5：bash 侧车执行（operations 派发到子进程） */
  piBashSidecar: readFlag("OAW_PI_SIDECAR"),
  /** U8：事件规范化管道（normalizePiEvent 接入 emit 前置） */
  eventNormalize: readFlag("OAW_EVENT_NORMALIZE"),
  /** U9：新工作区首次打开信任位（ProjectTrustStore 薄封装） */
  projectTrustGate: readFlag("OAW_PROJECT_TRUST_GATE"),
  /** U10：供应商提示词缓存保活（Pi 原生 CacheWarmer，streaming 模式：Run 进行中保活） */
  cacheWarming: readFlag("OAW_CACHE_WARMING"),
  /** U5 侧车空闲回收时间（毫秒，默认 10 分钟） */
  piBashSidecarIdleMs: readPositiveInt("OAW_PI_SIDECAR_IDLE_MS", 10 * 60 * 1000),
  /** 交互优化 P1：staged 产物在任务运行中即对产物面板可见（默认关：保持 run_finished 后可见） */
  stagedVisible: readFlag("OAW_STAGED_VISIBLE"),
  /** 交互优化 P2：run_finished 智能自动切产物页签（默认关） */
  autoTab: readFlag("OAW_AUTO_TAB"),
  /** 交互优化 P3：浏览器手关后对话侧活动徽标（默认关） */
  browserBadge: readFlag("OAW_BROWSER_BADGE"),
  /** 交互优化 P7：窄屏开浏览器记忆/恢复预览栏状态（默认关） */
  narrowRestore: readFlag("OAW_NARROW_RESTORE"),
  /** 交互优化 P8：浏览器帧流重连中与工具成功的对账提示（默认关） */
  reconcileHint: readFlag("OAW_RECONCILE_HINT"),
  /** 前端反馈基座：toast/confirmDialog 替代原生 alert/confirm（默认关=原生回退） */
  feedbackV2: readFlag("OAW_FEEDBACK_V2"),
  /** 浏览器 B3：面板不可见时自适应/暂停 screencast 推流（默认关） */
  browserAdaptiveStream: readFlag("OAW_BROWSER_ADAPTIVE_STREAM"),
  /** 浏览器 B4：整页截图与 PDF 导出底座（默认关） */
  browserFullpage: readFlag("OAW_BROWSER_FULLPAGE"),
  /** 浏览器 B5：导航 URL 防护（file:// 拒绝 + 域名白名单，默认关） */
  browserUrlGuard: readFlag("OAW_BROWSER_URL_GUARD"),
  /** B5 白名单配置：域名列表（留空 = 放行全部 http/https；子域名自动匹配） */
  browserUrlAllowlist: readStringList("OAW_BROWSER_URL_ALLOWLIST"),
});

/** /api/status 下发形态：布尔与数值分开，前端只读布尔位。 */
export function runtimeFlagsSnapshot() {
  return {
    piToolGateExtension: RUNTIME_FLAGS.piToolGateExtension,
    piBashSidecar: RUNTIME_FLAGS.piBashSidecar,
    eventNormalize: RUNTIME_FLAGS.eventNormalize,
    projectTrustGate: RUNTIME_FLAGS.projectTrustGate,
    cacheWarming: RUNTIME_FLAGS.cacheWarming,
    stagedVisible: RUNTIME_FLAGS.stagedVisible,
    autoTab: RUNTIME_FLAGS.autoTab,
    browserBadge: RUNTIME_FLAGS.browserBadge,
    narrowRestore: RUNTIME_FLAGS.narrowRestore,
    reconcileHint: RUNTIME_FLAGS.reconcileHint,
    feedbackV2: RUNTIME_FLAGS.feedbackV2,
    browserAdaptiveStream: RUNTIME_FLAGS.browserAdaptiveStream,
    browserFullpage: RUNTIME_FLAGS.browserFullpage,
    browserUrlGuard: RUNTIME_FLAGS.browserUrlGuard,
  };
}
