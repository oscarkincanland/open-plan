/**
 * Chat 讨论记录归档（2026-11-08，ADR 0030）。
 *
 * 背景：用户希望 Chat 也能留下可复用的讨论记录，但 **Chat 模型仍不持有任何写工具**
 * （AGENTS §5 / PRD Chat 能力边界）。因此由服务端在每轮 Chat 收尾时把该轮最终答复
 * 追加到工作区 `回报/讨论-<会话标题>.md`，属于「系统归档」而非「模型写文件」。
 *
 * 设计约束：
 *   - 只归档终稿（不抓思考/工具流水），一份会话一个文件、按时间追加，避免每轮一个新文件；
 *   - 失败不影响 Run 终态（best-effort）；
 *   - 目录固定在当前工作区 `回报/` 下，与 Work 的结论文档同目录，便于用户集中查找。
 */
import fs from "node:fs";
import path from "node:path";

export const REPORT_DIR = "回报";

/** 文件名安全化：去掉路径分隔符与 Windows 保留字符，压缩空白，限长。 */
export function safeSlug(value, { maxLength = 40 } = {}) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|#\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || "讨论";
  return base.length > maxLength ? base.slice(0, maxLength).trim() : base;
}

/** 讨论记录文件相对工作区路径：回报/讨论-<会话标题>.md */
export function discussionRelativePath({ title = "" } = {}) {
  return `${REPORT_DIR}/讨论-${safeSlug(title)}.md`;
}

function formatStamp(at) {
  const date = at ? new Date(at) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (n) => String(n).padStart(2, "0");
  return `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())} ${pad(valid.getHours())}:${pad(valid.getMinutes())}`;
}

/**
 * 追加一轮 Chat 讨论记录。
 * @returns {{ path: string, created: boolean } | null} 写入结果；工作区缺失时返回 null
 */
export function appendChatDiscussion(workspace, { title = "", question = "", answer = "", runId = "", at = null } = {}) {
  const root = String(workspace || "").trim();
  const text = String(answer || "").trim();
  if (!root || !text) return null;
  const relative = discussionRelativePath({ title });
  const absolute = path.join(root, ...relative.split("/"));
  const created = !fs.existsSync(absolute);
  const blocks = [];
  if (created) {
    const heading = safeSlug(title);
    blocks.push(`# 讨论记录 · ${heading}`, "", `> 由规聚自动归档（每轮 Chat 收尾追加，模型不写文件）。`, "");
  }
  const ask = String(question || "").trim();
  blocks.push(`## ${formatStamp(at)}${runId ? ` · ${runId}` : ""}`);
  if (ask) blocks.push("", `**问**：${ask.replace(/\s+/g, " ").slice(0, 300)}`);
  blocks.push("", text, "");
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, `${blocks.join("\n")}\n`, "utf8");
  return { path: relative, created };
}
