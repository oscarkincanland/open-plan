import fs from "node:fs";

/**
 * 预览类型与源码语言映射（单一来源，供 /api/doc 分派与测试共用）。
 *
 * 只负责“扩展名 → 类型/语言”的纯判断；文件读取与截断在这里统一，
 * 避免大文件一次性读入内存（源码预览上限 2MB）。
 */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export const CODE_LANGUAGES = Object.freeze({
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  bat: "shell",
  ps1: "powershell",
  java: "java",
  kt: "kotlin",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  markdown: "markdown",
});

// 这些扩展仍走 Markdown/文本预览（不进入只读源码视图）
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv"]);

export function isTextExt(ext) {
  return TEXT_EXTENSIONS.has(String(ext || "").toLowerCase());
}

export function codeLanguageFor(ext) {
  return CODE_LANGUAGES[String(ext || "").toLowerCase()] || "text";
}

export function isCodeExt(ext) {
  const value = String(ext || "").toLowerCase();
  return Boolean(CODE_LANGUAGES[value]) && !TEXT_EXTENSIONS.has(value) && value !== "html" && value !== "htm" && value !== "svg";
}

/**
 * 读取文本预览（最多 2MB）。返回 { text, size, truncated }；
 * 二进制文件（含 NUL 字节）返回 { binary: true }，由调用方回退到系统打开。
 */
export function readTextPreview(file, maxBytes = PREVIEW_TEXT_MAX_BYTES) {
  const stat = fs.statSync(file);
  const limit = Math.max(1024, Math.min(Number(maxBytes) || PREVIEW_TEXT_MAX_BYTES, stat.size));
  let text = "";
  const buffer = Buffer.alloc(limit);
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, buffer, 0, limit, 0);
    text = buffer.subarray(0, read).toString("utf8");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  if (text.includes("\u0000")) return { binary: true, size: stat.size };
  return { text, size: stat.size, truncated: stat.size > limit };
}
