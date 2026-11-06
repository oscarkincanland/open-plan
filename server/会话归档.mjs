/**
 * 会话归档的纯逻辑（2026-11-03）。
 *
 * 口径：
 * - 归档只改 header（archived/archivedAt），不移动、不删除会话文件；
 * - 运行中的会话不能归档（与批量删除的活跃状态集合一致）；
 * - 默认列表排除归档，`only` 只看归档，`all` 包含归档；
 * - 归档历史按 archivedAt 倒序，缺失时退回文件修改时间。
 */
export const ACTIVE_SESSION_STATUSES = Object.freeze([
  "running",
  "queued",
  "waiting_user",
  "recovering",
  "cancel_requested",
]);

export function isArchivableRunStatus(status = "") {
  return !ACTIVE_SESSION_STATUSES.includes(String(status || ""));
}

export function archiveHeaderPatch(archived, now = new Date()) {
  const on = archived !== false;
  const at = now instanceof Date ? now : new Date(now);
  return {
    archived: on,
    archivedAt: on && Number.isFinite(at.getTime()) ? at.toISOString() : "",
  };
}

export function shouldIncludeArchived(archived, mode = "default") {
  if (mode === "only") return Boolean(archived);
  if (mode === "all") return true;
  return !archived;
}

export function sortArchivedSessions(sessions = []) {
  return [...sessions].sort((a, b) => (
    (Date.parse(b?.archivedAt || "") || Number(b?.modified) || 0)
    - (Date.parse(a?.archivedAt || "") || Number(a?.modified) || 0)
  ));
}
