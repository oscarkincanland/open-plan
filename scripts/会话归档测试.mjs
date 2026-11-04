#!/usr/bin/env node
/**
 * 会话归档测试（2026-11-03 / 计划 006 阶段 A）。
 *
 * 覆盖：
 *   A. 纯逻辑：运行态保护、header patch、默认/only/all 过滤、归档排序；
 *   B. 服务端契约：字段白名单、列表过滤、单条/批量接口；
 *   C. 前端契约：⋮ 菜单、批量归档、设置「归档历史」tab、批量恢复/删除；
 *   D. 回归：归档不移动/删除文件，不关闭当前会话。
 *
 * 用法: node scripts/会话归档测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const {
  ACTIVE_SESSION_STATUSES,
  isArchivableRunStatus,
  archiveHeaderPatch,
  shouldIncludeArchived,
  sortArchivedSessions,
} = await import(pathToFileURL(path.join(ROOT, "server/会话归档.mjs")).href);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

console.log("\n▶ 纯逻辑");

test("运行中的 5 类状态不可归档，其余可归档", () => {
  for (const status of ACTIVE_SESSION_STATUSES) assert.equal(isArchivableRunStatus(status), false, status);
  for (const status of ["idle", "completed", "failed", "aborted", ""]) assert.equal(isArchivableRunStatus(status), true, status);
});

test("归档写 archived/archivedAt，恢复清空 archivedAt", () => {
  const now = new Date("2026-11-03T08:12:00.000Z");
  assert.deepEqual(archiveHeaderPatch(true, now), { archived: true, archivedAt: "2026-11-03T08:12:00.000Z" });
  assert.deepEqual(archiveHeaderPatch(false, now), { archived: false, archivedAt: "" });
});

test("默认排除归档，only 只返回归档，all 全量", () => {
  const list = [{ id: "a", archived: false }, { id: "b", archived: true }, { id: "c", archived: false }];
  assert.deepEqual(list.filter((item) => shouldIncludeArchived(item.archived)).map((item) => item.id), ["a", "c"]);
  assert.deepEqual(list.filter((item) => shouldIncludeArchived(item.archived, "only")).map((item) => item.id), ["b"]);
  assert.deepEqual(list.filter((item) => shouldIncludeArchived(item.archived, "all")).map((item) => item.id), ["a", "b", "c"]);
});

test("归档历史按 archivedAt 倒序，缺失时退回 modified", () => {
  const sorted = sortArchivedSessions([
    { id: "old", archivedAt: "2026-11-01T00:00:00.000Z" },
    { id: "new", archivedAt: "2026-11-03T00:00:00.000Z" },
    { id: "fallback", modified: Date.parse("2026-11-02T00:00:00.000Z") },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["new", "fallback", "old"]);
});

console.log("\n▶ 服务端");

const server = read("server/index.mjs");
test("header 字段白名单与元数据包含 archived/archivedAt", () => {
  assert.match(server, /const SESSION_LIST_FIELDS = new Set\(\[[^\]]*"archived", "archivedAt"/);
  assert.match(server, /archived: Boolean\(h\.archived\),\s*\n\s*archivedAt: h\.archivedAt \|\| ""/);
});

test("列表支持 archived=only/all，默认排除且不命中热缓存", () => {
  assert.match(server, /const archivedFilter = \["only", "all"\]/);
  assert.match(server, /shouldIncludeArchived\(meta\.archived, archivedFilter\)/);
  assert.match(server, /archivedFilter === "default"/);
  assert.match(server, /sortArchivedSessions\(sessions\)/);
});

test("单条归档与批量归档接口存在，归档时保护运行中会话", () => {
  assert.match(server, /app\.post\("\/api\/sessions\/:id\/archive"/);
  assert.match(server, /app\.post\("\/api\/sessions\/batch-archive"/);
  assert.match(server, /code: "SESSION_RUNNING"/);
  assert.match(server, /activeSessionIdSet\(\)/);
  assert.match(server, /archiveHeaderPatch\(archived\)/);
});

test("归档只改 header，不调用 unlink/rename/move", () => {
  const start = server.indexOf('app.post("/api/sessions/:id/archive"');
  const end = server.indexOf('app.post("/api/sessions/batch-archive"');
  const block = server.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(block, /unlinkSync|renameSync|copyFileSync|move/);
  assert.match(block, /updateSessionHeader/);
});

console.log("\n▶ 前端");

const api = read("client/src/api.js");
const sidebar = read("client/src/components/SessionSidebar.jsx");
const settings = read("client/src/components/SettingsPanel.jsx");
const app = read("client/src/App.jsx");
const chat = read("client/src/components/ChatPanel.jsx");
const styles = read("client/src/styles.css");

test("前端 API 支持归档、批量归档与 archived 查询", () => {
  assert.match(api, /export const archiveSession = \(id, archived = true\)/);
  assert.match(api, /export const archiveSessions = \(ids, archived = true\)/);
  assert.match(api, /"archived"/);
});

test("会话行操作收敛为 ⋮ 菜单，包含归档/恢复/永久删除", () => {
  assert.match(sidebar, /session-menu-btn/);
  assert.match(sidebar, /aria-haspopup="menu"/);
  assert.match(sidebar, /label: running \? "运行中不可归档" : "归档"/);
  assert.match(sidebar, /label: "恢复会话"/);
  assert.match(sidebar, /label: "永久删除"/);
  assert.match(sidebar, /onBatchArchive\(\[\.\.\.selectedIds\], true\)/);
  assert.match(sidebar, /批量归档/);
  assert.doesNotMatch(sidebar, /<div className="session-actions"[\s\S]{0,900}提示气泡 label="重命名"/, "不应保留 5 个悬停图标");
});

test("设置面板有独立「归档历史」tab 与批量恢复/删除", () => {
  assert.match(settings, /\["archive", "归档历史"\]/);
  assert.match(settings, /function ArchiveSettingsSection/);
  assert.match(settings, /listSessions\(\{ archived: "only" \}\)/);
  assert.match(settings, /批量恢复/);
  assert.match(settings, /批量永久删除/);
  assert.match(settings, /archiveSession\(id, false\)/);
  assert.match(settings, /settingsSection === "archive"/);
});

test("App 接线：归档不清空当前会话，并把回调传给侧栏/对话栏/设置", () => {
  assert.match(app, /const handleArchiveSession = useCallback/);
  assert.match(app, /const handleBatchArchiveSessions = useCallback/);
  assert.match(app, /onArchiveSession=\{handleArchiveSession\}/);
  assert.match(app, /onBatchArchiveSession=\{handleBatchArchiveSessions\}/);
  const handler = app.slice(app.indexOf("const handleArchiveSession"), app.indexOf("const handleBatchArchiveSessions"));
  assert.doesNotMatch(handler, /setCurrentSessionId\(null\)/, "归档当前会话不应关闭对话");
  assert.match(app, /onSessionsChanged=\{refreshSessions\}/);
});

test("对话栏历史抽屉也接到归档回调", () => {
  assert.match(chat, /onArchiveSession, onBatchArchiveSession/);
  assert.match(chat, /onArchive=\{onArchiveSession/);
  assert.match(chat, /onBatchArchive=\{onBatchArchiveSession/);
});

test("项目卡「最近会话」行也有 ⋮（重命名/归档/删除）", () => {
  assert.match(sidebar, /openProjectSessionMenu/);
  assert.match(sidebar, /project-session-more/);
  assert.match(sidebar, /setHistoryEditSessionId\(session\.id\)/);
  assert.match(styles, /\.project-session-more \{/);
});

test("⋮ 菜单与归档历史有样式", () => {
  assert.match(styles, /\.session-menu-btn \{/);
  assert.match(styles, /\.archive-settings-section \{/);
  assert.match(styles, /\.archive-item \{/);
});

console.log(failed ? "\n会话归档测试：存在失败\n" : "\n会话归档测试：全部通过\n");
process.exit(failed ? 1 : 0);
