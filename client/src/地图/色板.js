/**
 * 地图色板（单一来源）— 方案 docs/plans/2026-11-18-002 D1/D2。
 *
 * 职责：
 *   1) 图层默认色（server/正式层 + 前端复用）：`图层默认色`，server/map.mjs layerStyle()
 *      直接 import 本模块，避免前后端两份 hex 漂移；
 *   2) 语义令牌深浅值（`地图令牌`）：与 styles.css 的 --map-* 令牌同源，
 *      scripts/设计令牌一致性测试.mjs 做双源互查（同名令牌两处必须相等）；
 *   3) 色阶词汇表（`色阶词汇表`）：预注册色阶，供 agent 经 palette 枚举引用，
 *      禁止 agent 自由选色（CARTO deck.gl AI-ready 实证：放任选色必产出万金油色带）；
 *   4) JS 消费辅助：`令牌色()` 经 getComputedStyle 读取令牌实际值（MapLibre paint
 *      不支持 CSS var()），`订阅主题变更()` 监听 data-theme 切换后重设 paint 属性。
 *
 * 本模块必须保持零副作用、零 DOM 依赖（server 端也会 import），DOM 访问全部惰性。
 */

/* ---------------- 1) 正式图层默认色（与底图主题无关，深浅底图通用） ----------------
 * qualitative.road-class 采用色盲安全组合（消除旧"高速红 + 乡道绿"红绿对），
 * 以明度差 + 线宽冗余编码兜底（DESIGN §9.3 / 方案 D2）。 */
export const 图层默认色 = {
  "boundary-city": "#e4572e",
  "boundary-county": "#b8b8c8",
  highways: "#dc2626",
  "roads-rural": "#94a3b8",
  roads: "#3b82f6",
  "toll-stations": "#2ca02c",
  "point-generic": "#9467bd",
};

/* ---------------- 2) 语义令牌深浅值（与 styles.css --map-* 同源） ---------------- */
export const 地图令牌 = {
  dark: {
    "map-accent": "#4a90d9",
    "map-draft-pending": "#fbbf24",
    "map-draft-stroke": "#1f2937",
    "map-analysis": "#8b5cf6",
    "map-analysis-edge": "#7c3aed",
    "map-demo-badge": "#d9a13c",
    "map-boundary-city": "#e4572e",
    "map-boundary-county": "#b8b8c8",
    "map-road-highway": "#dc2626",
    "map-road-rural": "#94a3b8",
    "map-road-generic": "#3b82f6",
    "map-point-toll": "#2ca02c",
    "map-point-generic": "#9467bd",
    "map-route-origin": "#d62728",
    "map-route-dest": "#2ca02c",
    "map-measure": "#1f77b4",
    "map-draw-accent": "#f97316",
    "map-label-ink": "#17212b",
    "map-label-halo": "#ffffff",
  },
  light: {
    "map-accent": "#4a90d9",
    "map-draft-pending": "#f59e0b",
    "map-draft-stroke": "#ffffff",
    "map-analysis": "#8b5cf6",
    "map-analysis-edge": "#7c3aed",
    "map-demo-badge": "#b7791f",
    "map-boundary-city": "#e4572e",
    "map-boundary-county": "#b8b8c8",
    "map-road-highway": "#dc2626",
    "map-road-rural": "#94a3b8",
    "map-road-generic": "#3b82f6",
    "map-point-toll": "#2ca02c",
    "map-point-generic": "#9467bd",
    "map-route-origin": "#d62728",
    "map-route-dest": "#2ca02c",
    "map-measure": "#1f77b4",
    "map-draw-accent": "#f97316",
    "map-label-ink": "#17212b",
    "map-label-halo": "#ffffff",
  },
};

/* ---------------- 3) 色阶词汇表（agent 可引用的预注册色阶） ----------------
 * 命名：<类型>.<语义>。agent 工具的 palette 参数只能是这里的键名，
 * 未知名称必须拒绝（方案 D2 约束机制）。 */
export const 色阶词汇表 = {
  "sequential.heat-flow": {
    类型: "sequential",
    语义: "客流/出行强度热力",
    图例: "浅→深 = 流量低→高",
    色标: [[0, "rgba(45,156,219,0)"], [0.28, "#2d9cdb"], [0.52, "#f2c94c"], [0.78, "#f97316"], [1, "#dc2626"]],
    // 线变体：OD/客流线的同语义三档（无透明起点，避免细线不可见）
    线变体: ["#2d9cdb", "#f2c94c", "#dc2626"],
  },
  "sequential.density": {
    类型: "sequential",
    语义: "密度/强度分级填色（单色明度梯度）",
    图例: "浅→深 = 密度低→高",
    色标: [[0, "#dbeafe"], [0.33, "#93c5fd"], [0.66, "#3b82f6"], [1, "#1d4ed8"]],
  },
  "diverging.od-balance": {
    类型: "diverging",
    语义: "OD 净流入/流出（中点有意义）",
    图例: "红=净流出 · 中性=均衡 · 蓝=净流入",
    色标: [[0, "#dc2626"], [0.5, "#e5e7eb"], [1, "#2563eb"]],
  },
  "qualitative.road-class": {
    类型: "qualitative",
    语义: "道路等级（色盲安全：明度差 + 线宽冗余）",
    分类色: { 高速: "#dc2626", 主干: "#f59e0b", 次干: "#3b82f6", 乡道: "#94a3b8" },
  },
  "qualitative.mode-family": {
    类型: "qualitative",
    语义: "交通方式分组",
    分类色: { 轨道: "#3b82f6", 常规公交: "#f59e0b", 出租车网车: "#8b5cf6", 慢行: "#14b8a6", 货运: "#94a3b8", 其他: "#6b7280" },
  },
};

export const 色阶名称列表 = Object.keys(色阶词汇表);

/** 解析色阶；未知名称返回 null（调用方必须拒绝，不得静默回退）。 */
export function 解析色阶(名称) {
  return Object.prototype.hasOwnProperty.call(色阶词汇表, 名称) ? 色阶词汇表[名称] : null;
}

/** 构造 MapLibre interpolate 表达式（heatmap-color 等连续色带）；未知色阶返回 null。 */
export function 色阶插值表达式(名称, 输入) {
  const 色阶 = 解析色阶(名称);
  if (!色阶?.色标) return null;
  return ["interpolate", ["linear"], 输入, ...色阶.色标.flat()];
}

/** 色阶主色（分类色取第一类；连续色带取最深的实色端）；未知色阶返回 null。 */
export function 色阶主色(名称) {
  const 色阶 = 解析色阶(名称);
  if (!色阶) return null;
  if (色阶.分类色) return Object.values(色阶.分类色)[0] || null;
  const 实色 = (色阶.色标 || []).map(([, c]) => c).filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c));
  return 实色.length ? 实色[实色.length - 1] : null;
}

/* ---------------- 4) 记录型收敛色（JS 专用，不进 styles.css） ----------------
 * 既有硬编码按语义归位，棘轮测试只拦"新增"，存量在此登记。 */
export const 补充色 = {
  分析描边深: "#ea580c",
  等时圈标注: "#5b21b6",
  等时圈环: ["#f97316", "#f59e0b", "#84cc16", "#22c55e"],
  圆点描边: "#ffffff",
  画布红: "#d62728",
  绘制绿: "#2ca02c",
  图层样式默认: { line: "#d62728", fill: "#8abeb7", circle: "#9467bd" },
  拾色器行1: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f"],
  拾色器行2: ["#e4572e", "#17bebb", "#ffc914", "#2e282a", "#76b041", "#8b5e34"],
};

/* ---------------- 5) JS 消费辅助 ---------------- */

/** 当前 UI 主题（"dark" 为默认）。 */
export function 当前主题() {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * 读取语义令牌实际色值（MapLibre paint 不支持 var()，需在 JS 设值）。
 * 优先读 CSS computed 值（允许皮肤覆盖），失败回退本模块深浅表。
 * @param {string} 名 令牌短名，如 "map-draft-pending"（可带可不带 -- 前缀）
 */
export function 令牌色(名) {
  const 短名 = String(名 || "").replace(/^--/, "");
  if (typeof window !== "undefined") {
    try {
      const 值 = getComputedStyle(document.documentElement).getPropertyValue(`--${短名}`).trim();
      if (值) return 值;
    } catch { /* SSR/测试环境无 DOM，走回退 */ }
  }
  const 主题 = 当前主题();
  return 地图令牌[主题]?.[短名] || 地图令牌.dark[短名] || "";
}

/**
 * 订阅 <html data-theme> 变更（MutationObserver，方案 §6.5.1 机制）。
 * 返回取消订阅函数。MapLibre 图层颜色在 JS 设值，主题切换后需重设 paint 属性。
 */
export function 订阅主题变更(回调) {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const 观察者 = new MutationObserver(() => 回调(当前主题()));
  观察者.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => 观察者.disconnect();
}
