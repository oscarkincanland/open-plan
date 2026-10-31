import fs from "node:fs";

/**
 * 预览类型与源码语言映射（单一来源，供 /api/doc 分派与测试共用）。
 *
 * 只负责“扩展名 → 类型/语言”的纯判断；文件读取与截断在这里统一，
 * 避免大文件一次性读入内存（源码预览上限 2MB）。
 */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
// Markdown/HTML 预览是阅读主路径，保留完整内容；源码视图仍用 2MB 性能边界。
export const PREVIEW_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

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
 * 读取文本预览。默认 2MB（源码视图）；Markdown/HTML 预览传 10MB。
 * 返回 { text, size, truncated, encoding }；
 * 二进制文件（含 NUL 字节）返回 { binary: true }，由调用方回退到系统打开。
 */
export function readTextPreview(file, maxBytes = PREVIEW_TEXT_MAX_BYTES) {
  const stat = fs.statSync(file);
  const limit = Math.max(1024, Math.min(Number(maxBytes) || PREVIEW_TEXT_MAX_BYTES, stat.size));
  const buffer = Buffer.alloc(limit);
  let read = 0;
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    read = fs.readSync(fd, buffer, 0, limit, 0);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  const decoded = decodePreviewBuffer(buffer.subarray(0, read));
  if (decoded.binary) return { binary: true, size: stat.size };
  return { text: decoded.text, encoding: decoded.encoding, size: stat.size, truncated: stat.size > limit };
}

function decodeUtf16be(bytes) {
  const swapped = Buffer.from(bytes);
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const value = swapped[i];
    swapped[i] = swapped[i + 1];
    swapped[i + 1] = value;
  }
  return swapped.toString("utf16le");
}

function countReplacementChars(text) {
  let count = 0;
  for (const char of String(text || "")) if (char === "\uFFFD") count += 1;
  return count;
}

function decodePreviewBuffer(bytes) {
  if (!bytes.length) return { text: "", encoding: "utf-8" };
  // BOM 优先：UTF-16 LE/BE 文本天然含 NUL，不能再用“含 NUL 即二进制”判断。
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)).toString("utf16le"), encoding: "utf-16le" };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: decodeUtf16be(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2))), encoding: "utf-16be" };
    }
  }
  // 无 BOM 的 UTF-16 常见于 Windows 导出：按 NUL 位置比例做保守识别。
  const sample = Math.min(bytes.length, 4096);
  let zerosAtOdd = 0;
  let zerosAtEven = 0;
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) zerosAtEven += 1;
      else zerosAtOdd += 1;
    }
  }
  const samplePairs = Math.max(1, Math.floor(sample / 2));
  if (bytes.length >= 8 && zerosAtOdd > samplePairs * 0.3 && zerosAtEven < samplePairs * 0.05) {
    return { text: bytes.subarray(0, bytes.length - (bytes.length % 2)).toString("utf16le"), encoding: "utf-16le" };
  }
  if (bytes.length >= 8 && zerosAtEven > samplePairs * 0.3 && zerosAtOdd < samplePairs * 0.05) {
    return { text: decodeUtf16be(bytes.subarray(0, bytes.length - (bytes.length % 2))), encoding: "utf-16be" };
  }
  if (bytes.includes(0)) return { binary: true };
  // 截断可能切断多字节字符：先回退到最后一个完整 UTF-8 字符边界。
  let end = bytes.length;
  let back = 0;
  while (end > 0 && back < 4 && (bytes[end - 1] & 0xc0) === 0x80) {
    end -= 1;
    back += 1;
  }
  if (end > 0 && back >= 3) end = bytes.length;
  const utf8 = bytes.subarray(0, end).toString("utf8");
  if (!utf8.includes("\uFFFD")) return { text: utf8, encoding: "utf-8" };
  // 中文 Windows 常见的 GBK/GB18030：UTF-8 解码失败时回退，不把整份文件判成二进制。
  try {
    const gb = new TextDecoder("gb18030", { fatal: false }).decode(bytes);
    if (countReplacementChars(gb) < countReplacementChars(utf8)) {
      return { text: gb, encoding: "gb18030" };
    }
  } catch {}
  return { text: utf8, encoding: "utf-8" };
}
