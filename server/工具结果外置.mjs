/**
 * 工具结果外置（H1-3）
 *
 * 目的：超过阈值的工具输出落盘，模型只拿预览，完整内容可回溯。
 * 与“用户产物”严格区分：这些文件位于 .oaw/runs/<runId>/tool-results/，
 * 不进入产物面板，也不参与产物验收。
 *
 * 设计约束：
 *   - 纯函数 + 原子写；不依赖 Pi 内核；
 *   - 默认关闭（OAW_TOOL_RESULT_ARTIFACT），关闭时调用方不应调用本模块；
 *   - 预览按 UTF-8 字节截断，避免多字节字符把大小算错。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR } from "./workspace.mjs";
import { atomicWriteFile, ensureDirectory } from "./持久化工具.mjs";

export const DEFAULT_MAX_INLINE_BYTES = 30 * 1024;

export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function safeSegment(value, fallback = "item") {
  const clean = String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return clean || fallback;
}

/** 按 UTF-8 字节截断；head 保留开头，tail 保留末尾。 */
export function previewText(text, maxBytes = DEFAULT_MAX_INLINE_BYTES, direction = "head") {
  const source = String(text ?? "");
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_MAX_INLINE_BYTES);
  const buffer = Buffer.from(source, "utf8");
  if (buffer.length <= limit) return source;
  const slice = direction === "tail" ? buffer.subarray(buffer.length - limit) : buffer.subarray(0, limit);
  // 去掉可能被截断的半截多字节字符（U+FFFD）。
  return slice.toString("utf8").replace(/\uFFFD+$/u, "");
}

export function toolResultsDir(runId, baseDir = null) {
  const root = baseDir || process.env.OAW_RUNS_DIR || path.join(PROJECT_DIR, ".oaw", "runs");
  return path.join(root, safeSegment(runId, "run"), "tool-results");
}

/**
 * 外置一段文本。
 * @returns {{externalized:boolean,text:string,path:string|null,bytes:number,previewBytes:number,direction:string}}
 */
export function externalizeText({
  text,
  toolName = "tool",
  toolCallId = null,
  runId,
  baseDir = null,
  maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
  direction = "head",
} = {}) {
  const source = String(text ?? "");
  const bytes = byteLength(source);
  const limit = Math.max(1, Number(maxInlineBytes) || DEFAULT_MAX_INLINE_BYTES);
  if (!runId || bytes <= limit) {
    return { externalized: false, text: source, path: null, bytes, previewBytes: bytes, direction };
  }
  const dir = toolResultsDir(runId, baseDir);
  ensureDirectory(dir);
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const file = path.join(dir, `${safeSegment(toolCallId, "tool")}-${safeSegment(toolName, "tool")}-${stamp}.txt`);
  atomicWriteFile(file, source, "utf8");
  const preview = previewText(source, limit, direction);
  const relative = path.relative(PROJECT_DIR, file).replace(/\\/g, "/");
  const marker = `\n\n[工具结果已外置：${relative}（${bytes} 字节；预览为${direction === "tail" ? "末尾" : "开头"} ${limit} 字节）]`;
  return {
    externalized: true,
    text: preview + marker,
    path: file,
    relativePath: relative,
    bytes,
    previewBytes: byteLength(preview),
    direction,
  };
}

/**
 * 处理 Pi 工具返回形状：{ content: [{type:"text",text}], details }。
 * 只处理文本 part；图片/结构化 part 原样保留。
 */
export function externalizeToolResultPayload(result, options = {}) {
  if (!result || typeof result !== "object") return result;
  const content = Array.isArray(result.content) ? result.content : null;
  if (!content?.length) return result;
  const direction = options.direction || "head";
  let externalized = 0;
  let totalBytes = 0;
  const artifacts = [];
  const nextContent = content.map((part, index) => {
    if (!part || part.type !== "text" || typeof part.text !== "string") return part;
    const outcome = externalizeText({
      ...options,
      text: part.text,
      toolCallId: options.toolCallId ? `${options.toolCallId}-${index}` : `part-${index}`,
      direction,
    });
    if (!outcome.externalized) return part;
    externalized += 1;
    totalBytes += outcome.bytes;
    artifacts.push({ path: outcome.path, relativePath: outcome.relativePath, bytes: outcome.bytes });
    return { ...part, text: outcome.text };
  });
  if (!externalized) return result;
  return {
    ...result,
    content: nextContent,
    details: {
      ...(result.details && typeof result.details === "object" ? result.details : {}),
      externalizedResults: artifacts,
      externalizedBytes: totalBytes,
    },
  };
}

/** Run 结束时清理外置结果；失败不抛错。 */
export function cleanupToolResults(runId, baseDir = null) {
  if (!runId) return { ok: false, removed: false };
  const dir = toolResultsDir(runId, baseDir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, removed: true, dir };
  } catch (error) {
    return { ok: false, removed: false, dir, error: error.message };
  }
}

export function listToolResults(runId, baseDir = null) {
  const dir = toolResultsDir(runId, baseDir);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".txt")).map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { name, path: file, bytes: stat.size, mtime: stat.mtimeMs };
    });
  } catch {
    return [];
  }
}
