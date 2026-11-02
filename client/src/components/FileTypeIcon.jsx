import { artifactTypeInfo } from "../产物类型.js";

/**
 * 扁平化文件类型图标（DESIGN §5.8 文件类型例外）。
 *
 * - 实色底 + 白色字形，靠颜色和字形双重区分 Word / Excel / PPT / PDF / 网页 / 代码等；
 * - 颜色全部走 styles.css 的 --file-* 令牌，明暗主题各一套；
 * - 文件树、产物卡片、预览页文件树共用同一组件，避免各处图标漂移。
 */
const MARK = "var(--file-icon-fg)";
const PAGE = "M6 2.6h7.1L17.8 7.3V21.4H6z";
const FOLD = "M13.1 2.6v4.7h4.7";

const GLYPHS = {
  doc: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <path d="M8.8 11.4h6M8.8 14.4h6M8.8 17.4h3.6" stroke={MARK} strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  sheet: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <rect x="8.4" y="10.4" width="7.2" height="7.2" rx=".8" stroke={MARK} strokeWidth="1.3" />
      <path d="M8.4 13.8h7.2M12 10.4v7.2" stroke={MARK} strokeWidth="1.1" />
    </>
  ),
  slides: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <rect x="8.2" y="10.6" width="7.6" height="5" rx=".8" stroke={MARK} strokeWidth="1.3" />
      <path d="M11 11.9l2.8 1.6-2.8 1.6z" fill={MARK} />
      <path d="M12 15.6v2M10.4 17.6h3.2" stroke={MARK} strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  pdf: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <text x="11.9" y="17" textAnchor="middle" fontSize="5.6" fontWeight="700" fill={MARK} fontFamily="inherit">PDF</text>
    </>
  ),
  html: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <path d="M9.5 11.8L7.8 13.8l1.7 2M14.5 11.8l1.7 2-1.7 2M13.2 10.8l-2.4 6" stroke={MARK} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  md: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <path d="M8.6 17.2v-5.4l1.8 2 1.8-2v5.4M14.6 12v4.2M13.2 15l1.4 1.5 1.4-1.5" stroke={MARK} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  code: (
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3.4" fill="currentColor" />
      <path d="M9.6 9.6L7.4 12l2.2 2.4M14.4 9.6L16.6 12l-2.2 2.4M13 8.8l-2 6.4" stroke={MARK} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  image: (
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3.4" fill="currentColor" />
      <circle cx="15.2" cy="9.6" r="1.3" fill={MARK} />
      <path d="M6.6 17.4l3.4-4 2.5 2.7 1.9-2.2 3 3.5" stroke={MARK} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  map: (
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3.4" fill="currentColor" />
      <path d="M6.4 8l3.8-1.4 3.6 1.4 3.8-1.4v9.8l-3.8 1.4-3.6-1.4-3.8 1.4z" fill={MARK} />
      <path d="M10.2 6.8v9.6M13.8 8v9.6" stroke="currentColor" strokeWidth=".9" opacity=".7" />
    </>
  ),
  archive: (
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3.4" fill="currentColor" />
      <path d="M7.2 9.4h9.6v8H7.2zM9.4 9.4V7.8h5.2v1.6M12 9.4v8" stroke={MARK} strokeWidth="1.3" strokeLinejoin="round" />
    </>
  ),
  text: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <path d="M8.8 10.6h6M8.8 13.4h6M8.8 16.2h6M8.8 19h3.2" stroke={MARK} strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  folder: (
    <>
      <path d="M3.4 7.2h6l1.8 2h9.4v9.4a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6z" fill="currentColor" />
      <path d="M3.4 9.4h17.2" stroke={MARK} strokeWidth="1.1" opacity=".35" />
    </>
  ),
  other: (
    <>
      <path d={PAGE} fill="currentColor" />
      <path d={FOLD} fill={MARK} opacity=".32" />
      <path d="M8.8 12h6M8.8 15h6M8.8 18h4" stroke={MARK} strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
};

export default function 文件类型图标({ file, size = 20, className = "" }) {
  const isDir = file?.isDir === true;
  const info = isDir
    ? { kind: "folder", label: "文件夹", ext: "" }
    : artifactTypeInfo(file?.name || file?.path || "");
  const px = typeof size === "number" ? size : size === "small" ? 16 : 20;
  const glyph = Math.max(10, Math.round(px * 0.78));
  const title = isDir ? "文件夹" : `${info.label}${info.ext ? ` · ${info.ext.toUpperCase()}` : ""}`;
  return (
    <span
      className={`file-type-icon ${className}`.trim()}
      data-kind={info.kind}
      style={{ width: px, height: px, flexBasis: px }}
      title={title}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill="none" aria-hidden="true" focusable="false">
        {GLYPHS[info.kind] || GLYPHS.other}
      </svg>
    </span>
  );
}
