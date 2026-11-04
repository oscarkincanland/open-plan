import React from "react";
import 品牌图形 from "./供应商品牌图形.js";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowLeft,
  IconArrowRight,
  IconArrowsSplit2,
  IconAt,
  IconBook,
  IconBookmark,
  IconBrain,
  IconBus,
  IconChartBar,
  IconChartHistogram,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCloud,
  IconCode,
  IconCopy,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFileTypeHtml,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconHistory,
  IconInfoCircle,
  IconLayoutColumns,
  IconLayoutGrid,
  IconLink,
  IconList,
  IconLoader2,
  IconLock,
  IconMap2,
  IconMapPin,
  IconMarkdown,
  IconMaximize,
  IconMenu2,
  IconMessage,
  IconMessagePlus,
  IconMinimize,
  IconMinus,
  IconMoon,
  IconMusic,
  IconPackage,
  IconPencil,
  IconPhoto,
  IconPin,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlug,
  IconPlus,
  IconPointer,
  IconRefresh,
  IconRoad,
  IconRobot,
  IconRoute,
  IconSearch,
  IconSend,
  IconSettings,
  IconShield,
  IconShieldCheck,
  IconSparkles,
  IconStack2,
  IconStar,
  IconSun,
  IconTerminal2,
  IconTextWrap,
  IconTool,
  IconTrash,
  IconUpload,
  IconUser,
  IconWorld,
  IconX,
} from "@tabler/icons-react";

/**
 * 统一图标库（Tabler Icons，stroke 风格）。
 * 用法: <Icon name="file" size={14} />
 *
 * 2026-11-04：业务图标从手绘 SVG 迁移到 @tabler/icons-react；
 * Logo（Policy）与 ProviderIcon（供应商品牌）保持独立，不走 Tabler。
 * 映射目标保持唯一：同一语义不重复占用两个 Tabler 字形。
 */
const ICONS = {
  // 文件类型
  xls: IconFileTypeXls,
  ppt: IconFileTypePpt,
  md: IconMarkdown,
  html: IconFileTypeHtml,
  txt: IconFileTypeTxt,
  pdf: IconFileTypePdf,
  file: IconFile,
  folder: IconFolder,
  folderOpen: IconFolderOpen,
  // 媒体/布局/地图
  play: IconPlayerPlay,
  audio: IconMusic,
  columns: IconLayoutColumns,
  map: IconMap2,
  layers: IconStack2,
  chart: IconChartBar,
  flow: IconArrowsSplit2,
  sankey: IconChartHistogram,
  road: IconRoad,
  route: IconRoute,
  locate: IconMapPin,
  bus: IconBus,
  // 界面操作
  search: IconSearch,
  refresh: IconRefresh,
  close: IconX,
  plus: IconPlus,
  minus: IconMinus,
  chevronDown: IconChevronDown,
  chevronRight: IconChevronRight,
  chevronLeft: IconChevronLeft,
  arrowRight: IconArrowRight,
  back: IconArrowLeft,
  cursor: IconPointer,
  lock: IconLock,
  copy: IconCopy,
  trash: IconTrash,
  download: IconDownload,
  upload: IconUpload,
  externalLink: IconExternalLink,
  maximize: IconMaximize,
  minimize: IconMinimize,
  more: IconDots,
  menu: IconMenu2,
  // 状态
  check: IconCheck,
  warning: IconAlertTriangle,
  info: IconInfoCircle,
  loading: IconLoader2,
  // 身份/内容
  robot: IconRobot,
  brain: IconBrain,
  user: IconUser,
  comment: IconMessage,
  chatPlus: IconMessagePlus,
  pin: IconPin,
  image: IconPhoto,
  link: IconLink,
  backlink: IconArrowBackUp,
  send: IconSend,
  stop: IconPlayerStop,
  at: IconAt,
  grid: IconLayoutGrid,
  list: IconList,
  history: IconHistory,
  eye: IconEye,
  eyeOff: IconEyeOff,
  shield: IconShieldCheck,
  shieldPlain: IconShield,
  star: IconStar,
  sun: IconSun,
  moon: IconMoon,
  sparkles: IconSparkles,
  cloud: IconCloud,
  bookmark: IconBookmark,
  filter: IconFilter,
  gear: IconSettings,
  book: IconBook,
  tool: IconTool,
  globe: IconWorld,
  terminal: IconTerminal2,
  code: IconCode,
  wrap: IconTextWrap,
  plug: IconPlug,
  package: IconPackage,
  edit: IconPencil,
};

// 兼容旧调用名：语义与 edit 重复，统一指向同一字形，不再新增重复映射。
const ICON_ALIASES = Object.freeze({ penTool: "edit" });

export const ICON_NAMES = Object.keys(ICONS);
const MISSING_ICON_WARNED = new Set();

export default function Icon({ name, size = 16, className = "", strokeWidth = 2 }) {
  const key = ICON_ALIASES[name] || name;
  const Component = ICONS[key];
  if (!Component) {
    // 未注册的名称过去静默返回 null，页面上只会“图标不见了”，很难定位。
    // 开发期每个名称只告警一次，指明补注册位置；生产构建不产生噪音。
    if (name && !MISSING_ICON_WARNED.has(name)) {
      MISSING_ICON_WARNED.add(name);
      if (typeof console !== "undefined" && import.meta?.env?.DEV) {
        console.warn(`[Icon] 未注册的图标名称 "${name}"：请在 Icon.jsx 的 ICONS 中补注册，或改用已有名称（现有 ${ICON_NAMES.length} 个）。`);
      }
    }
    return null;
  }
  return (
    <Component
      className={`icon icon-${name} ${className}`}
      size={size}
      stroke={strokeWidth}
      aria-hidden="true"
    />
  );
}

// 模型供应商标识使用项目已有的本地品牌 SVG 路径，不依赖 CDN 或远程图片请求。
// 路径对应 templates/opendesign/open-design-landing/assets/agents 下的矢量资源，
// 直接内联后仍由 CSS 统一控制尺寸和品牌色，避免模型列表出现空白图标。
const PROVIDER_GLYPHS = {
  anthropic: <path fill="currentColor" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />,
  deepseek: <path fill="currentColor" d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />,
  minimax: <g fill="currentColor"><rect x="2" y="10" width="1.7" height="4" rx="0.85" /><rect x="6" y="6.5" width="1.7" height="11" rx="0.85" /><rect x="10" y="3" width="1.7" height="18" rx="0.85" /><rect x="14" y="6.5" width="1.7" height="11" rx="0.85" /><rect x="18" y="9" width="1.7" height="6" rx="0.85" /></g>,
  openai: <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />,
  qwen: <path fill="currentColor" d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" />,
  gemini: <path fill="currentColor" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />,
  xiaomi: <path fill="currentColor" d="M3 6.4h6.7c1.55 0 2.5.42 3.1 1.05.6.62.95 1.55.95 2.95v7.2h-2.5v-7c0-.75-.15-1.2-.45-1.5-.3-.3-.78-.45-1.55-.45H5.5v8.95H3Zm15.5 0H21v11.2h-2.5Z" />,
  zhipu: <path fill="currentColor" d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm3.4 4.1v1.95h5.04L7.05 15.1v1.8h9.55v-1.95h-5.3l5.4-6.05V7.1H7.4Z" />,
  // Moonshot/Kimi、xAI、OpenCode 的真实品牌矢量来自下面的品牌图形集（simple-icons）；
  // 这里只留没有公开矢量的占位图形。
  commandcode: (<><rect x="3" y="5" width="18" height="14" rx="2.4" strokeWidth="1.6" /><path d="m7.6 10.4 2.4 2.2-2.4 2.2" strokeWidth="1.6" /><path d="M12.6 15.2h3.6" strokeWidth="1.6" /></>),
  custom: <circle cx="12" cy="12" r="5" />,
};

// 品牌矢量（simple-icons，CC0，见 供应商品牌图形.js）：key 是 ProviderIcon 用的图形名，
// 值是品牌数据文件里的 slug。同一 key 以品牌矢量为准（覆盖上面的占位图形）。
const 品牌图形键 = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "googlegemini",
  deepseek: "deepseek",
  xai: "x",
  mistral: "mistralai",
  moonshot: "moonshotai",
  kimi: "kimi",
  minimax: "minimax",
  qwen: "qwen",
  xiaomi: "xiaomi",
  meta: "meta",
  cloudflare: "cloudflare",
  vercel: "vercel",
  huggingface: "huggingface",
  nvidia: "nvidia",
  openrouter: "openrouter",
  googlecloud: "googlecloud",
  azure: "microsoftazure",
  bedrock: "amazonwebservices",
  ollama: "ollama",
  alibaba: "alibabacloud",
  opencode: "opencode",
};
for (const [key, slug] of Object.entries(品牌图形键)) {
  if (品牌图形[slug]) PROVIDER_GLYPHS[key] = <path fill="currentColor" d={品牌图形[slug]} />;
}

// 需要描边渲染的品牌图形：这些路径不填充，改由 stroke 勾线（fill/stroke 见 ProviderIcon）。
const STROKED_PROVIDER_GLYPHS = new Set(["commandcode"]);

export function ProviderIcon({ provider = "custom", size = 14, className = "" }) {
  const key = String(provider || "custom").toLowerCase();
  const glyph = PROVIDER_GLYPHS[key] || PROVIDER_GLYPHS.custom;
  const stroked = STROKED_PROVIDER_GLYPHS.has(key);
  return (
    <svg
      className={`provider-icon provider-icon-${key} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={stroked ? "none" : "currentColor"}
      stroke={stroked ? "currentColor" : "none"}
      strokeLinecap={stroked ? "round" : undefined}
      strokeLinejoin={stroked ? "round" : undefined}
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
