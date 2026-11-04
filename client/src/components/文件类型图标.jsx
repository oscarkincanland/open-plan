import React from "react";
import {
  IconArchive,
  IconCode,
  IconFile,
  IconFileTypeDocx,
  IconFileTypeHtml,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeXls,
  IconFolder,
  IconMap2,
  IconMarkdown,
  IconPhoto,
} from "@tabler/icons-react";
import { artifactTypeInfo } from "../产物类型.js";

/**
 * 扁平化文件类型图标（DESIGN §5.8 文件类型例外）。
 *
 * 2026-11-04：保留彩色底（--file-* 令牌），字形切到 Tabler Icons；
 * 文件树、产物卡片、预览页文件树共用同一组件，避免各处图标漂移。
 */
const GLYPHS = {
  doc: IconFileTypeDocx,
  sheet: IconFileTypeXls,
  slides: IconFileTypePpt,
  pdf: IconFileTypePdf,
  html: IconFileTypeHtml,
  md: IconMarkdown,
  code: IconCode,
  image: IconPhoto,
  map: IconMap2,
  archive: IconArchive,
  text: IconFile,
  folder: IconFolder,
  other: IconFile,
};

export default function 文件类型图标({ file, size = 20, className = "" }) {
  const isDir = file?.isDir === true;
  const info = isDir
    ? { kind: "folder", label: "文件夹", ext: "" }
    : artifactTypeInfo(file?.name || file?.path || "");
  const px = typeof size === "number" ? size : size === "small" ? 16 : 20;
  const glyph = Math.max(10, Math.round(px * 0.72));
  const title = isDir ? "文件夹" : `${info.label}${info.ext ? ` · ${info.ext.toUpperCase()}` : ""}`;
  const Glyph = GLYPHS[info.kind] || GLYPHS.other;
  return (
    <span
      className={`file-type-icon ${className}`.trim()}
      data-kind={info.kind}
      style={{ width: px, height: px, flexBasis: px }}
      title={title}
      aria-hidden="true"
    >
      <Glyph size={glyph} stroke={1.8} aria-hidden="true" />
    </span>
  );
}
