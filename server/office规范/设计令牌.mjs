/**
 * Office 版式令牌（O-06）。
 *
 * 单一事实来源：中文字号、行距、缩进、页边距、配色只在本模块定义，
 * 生成器 / 流水线 / 验收规则统一引用，禁止在各处散落魔法值。
 *
 * 单位约定（与 OOXML 一致）：
 *   - 字号：pt（半磅 = pt × 2）
 *   - 行距/缩进/页边距：twips（1pt = 20 twips，1cm ≈ 567 twips）
 */

/** 中文字号 13 档（pt）。 */
export const FONT_SIZES = Object.freeze({
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
  六号: 7.5,
});

/** 行距四档：auto 用 line 倍数×240；exact 用固定 twips。 */
export const LINE_SPACING = Object.freeze({
  compact: Object.freeze({ line: 276, rule: "auto", label: "1.15 倍" }),
  normal: Object.freeze({ line: 312, rule: "auto", label: "1.3 倍" }),
  relaxed: Object.freeze({ line: 360, rule: "auto", label: "1.5 倍" }),
  fixed28: Object.freeze({ line: 560, rule: "exact", label: "固定 28pt" }),
});

/** 中文首行缩进两字符（twips）。 */
export const INDENT = Object.freeze({
  simsun: 480,
  yahei: 420,
  none: 0,
});

/** A4 页边距三套（twips）。 */
export const PAGE_MARGINS = Object.freeze({
  normal: Object.freeze({ top: 1440, bottom: 1440, left: 1800, right: 1800, label: "常规" }),
  official: Object.freeze({ top: 2098, bottom: 1984, left: 1588, right: 1474, label: "公文" }),
  narrow: Object.freeze({ top: 1134, bottom: 1134, left: 1134, right: 1134, label: "窄" }),
});

/** A4 纸尺寸（twips）。 */
export const PAGE_SIZE = Object.freeze({ width: 11906, height: 16838 });

/** 12 套低饱和配色（封面/强调色）。 */
export const PALETTES = Object.freeze([
  { id: "morandi", name: "莫兰迪", primary: "#4A6575", accent: "#B08968", background: "#F5F7FA", text: "#1F2933" },
  { id: "gov-blue", name: "政务蓝", primary: "#1F4E79", accent: "#C00000", background: "#FFFFFF", text: "#1A1A1A" },
  { id: "forest", name: "森林绿", primary: "#2F5D50", accent: "#C9A227", background: "#F4F7F5", text: "#1E2B26" },
  { id: "slate", name: "石板灰", primary: "#37474F", accent: "#78909C", background: "#ECEFF1", text: "#1C262B" },
  { id: "warm-sand", name: "暖沙", primary: "#6D4C41", accent: "#D4A373", background: "#FAF6F0", text: "#2B2118" },
  { id: "ink", name: "水墨", primary: "#2B2B2B", accent: "#8C8C8C", background: "#FAFAFA", text: "#111111" },
  { id: "ocean", name: "深海", primary: "#0F4C5C", accent: "#E36414", background: "#F2F7F8", text: "#102A31" },
  { id: "plum", name: "梅紫", primary: "#5B3A5E", accent: "#B08BBB", background: "#F8F4F9", text: "#2A1D2B" },
  { id: "traffic", name: "交通橙", primary: "#1D3557", accent: "#E76F51", background: "#F7F9FB", text: "#1B263B" },
  { id: "eco", name: "生态青", primary: "#1B5E5A", accent: "#8AB17D", background: "#F3F8F6", text: "#17302E" },
  { id: "academic", name: "学术灰", primary: "#333333", accent: "#7A8B99", background: "#FFFFFF", text: "#1A1A1A" },
  { id: "warm-red", name: "中国红", primary: "#8C1C13", accent: "#C9A227", background: "#FFFDF8", text: "#2A1A17" },
]);

/** 默认字体。 */
export const DEFAULT_FONTS = Object.freeze({
  body: "SimSun",
  heading: "SimHei",
  latin: "Times New Roman",
});

/**
 * 字号解析：支持中文名、"12pt"、数字。
 * @returns {{pt:number, halfPoints:number, name:string|null}}
 */
export function resolveFontSize(value, fallback = 12) {
  let pt = null;
  let name = null;
  if (typeof value === "number" && Number.isFinite(value)) pt = value;
  else {
    const text = String(value ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(FONT_SIZES, text)) {
      pt = FONT_SIZES[text];
      name = text;
    } else {
      const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:pt)?$/i);
      if (match) pt = Number(match[1]);
    }
  }
  if (!Number.isFinite(pt) || pt <= 0) pt = fallback;
  return { pt, halfPoints: Math.round(pt * 2), name };
}

/** 行距解析：档位名或 {line, rule}。 */
export function resolveLineSpacing(value, fallback = "normal") {
  if (value && typeof value === "object" && Number.isFinite(Number(value.line))) {
    return { line: Number(value.line), rule: value.rule === "exact" ? "exact" : "auto", label: value.label || "自定义" };
  }
  return LINE_SPACING[String(value || fallback)] || LINE_SPACING[fallback];
}

/** 页边距解析。 */
export function resolvePageMargins(value, fallback = "normal") {
  if (value && typeof value === "object") {
    return {
      top: Number(value.top) || PAGE_MARGINS[fallback].top,
      bottom: Number(value.bottom) || PAGE_MARGINS[fallback].bottom,
      left: Number(value.left) || PAGE_MARGINS[fallback].left,
      right: Number(value.right) || PAGE_MARGINS[fallback].right,
      label: value.label || "自定义",
    };
  }
  return PAGE_MARGINS[String(value || fallback)] || PAGE_MARGINS[fallback];
}

/** 配色解析。 */
export function resolvePalette(id, fallback = "morandi") {
  return PALETTES.find((item) => item.id === String(id || "")) || PALETTES.find((item) => item.id === fallback) || PALETTES[0];
}

/** 令牌完整性自检（测试与启动诊断共用）。 */
export function assertTokenIntegrity() {
  const problems = [];
  const sizes = Object.values(FONT_SIZES);
  if (sizes.length !== 13) problems.push(`字号档位应为 13，实际 ${sizes.length}`);
  if (new Set(sizes).size !== sizes.length) problems.push("字号档位存在重复值");
  const sorted = [...sizes].sort((a, b) => a - b);
  if (sizes.join(",") !== [...sorted].reverse().join(",")) problems.push("字号档位未按从大到小排列");
  if (Object.keys(LINE_SPACING).length !== 4) problems.push("行距档位应为 4");
  if (LINE_SPACING.fixed28.rule !== "exact") problems.push("固定行距必须使用 exact");
  if (INDENT.simsun !== 480 || INDENT.yahei !== 420) problems.push("CJK 首行缩进取值不符");
  if (Object.keys(PAGE_MARGINS).length !== 3) problems.push("页边距应为 3 套");
  if (PALETTES.length !== 12) problems.push("配色应为 12 套");
  for (const palette of PALETTES) {
    for (const key of ["primary", "accent", "background", "text"]) {
      if (!/^#[0-9a-f]{6}$/i.test(String(palette[key] || ""))) problems.push(`配色 ${palette.id} 的 ${key} 非法`);
    }
  }
  return problems;
}
