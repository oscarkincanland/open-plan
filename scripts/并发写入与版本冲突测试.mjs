#!/usr/bin/env node
/**
 * 并发写入与版本冲突测试（2026-11-04，对标 DSH 的 fs 版本 CAS）。
 *
 * 覆盖：
 *   A. stage 写完立即释放锁，不再持有到 Run 结束；
 *   B. 发布前目标被外部修改 → 不覆盖，写 `.conflict-<run>` 副本；
 *   C. 同一 Run 多次暂存保留最初 baseRevision；
 *   D. materializeStagedReferences 在目标变化时跳过；
 *   E. revisionOf / conflictCopyPath 基础语义。
 *
 * 用法: node scripts/并发写入与版本冲突测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-version-cas-"));
process.env.OAW_RUNS_DIR = path.join(workspace, ".runs");
process.env.OAW_WRITE_LOCK_DIR = path.join(workspace, ".locks");

const {
  stageWrite,
  publishStagedRun,
  listStagedFiles,
  materializeStagedReferences,
  releaseRunLocks,
  acquireWriteLock,
  releaseWriteLock,
} = await import(pathToFileURL(path.join(ROOT, "server", "写入协调.mjs")).href);
const { revisionOf, sameRevision, conflictCopyPath } = await import(pathToFileURL(path.join(ROOT, "server", "文件版本.mjs")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};

console.log("\n▶ A. 版本指纹与冲突路径");

test("revisionOf：不存在为 null，存在后随内容变化", () => {
  const file = path.join(workspace, "rev.txt");
  assert.equal(revisionOf(file), null);
  fs.writeFileSync(file, "one");
  const first = revisionOf(file);
  assert.ok(first);
  fs.writeFileSync(file, "two");
  const second = revisionOf(file);
  assert.ok(second);
  assert.equal(sameRevision(first, second), false);
  assert.equal(sameRevision(second, second), true);
});

test("conflictCopyPath：同目录、同扩展名，重名递增", () => {
  const target = path.join(workspace, "报告.docx");
  const first = conflictCopyPath(target, "run_abcdef123456");
  assert.match(first, /报告\.conflict-[a-z0-9_]+\.docx$/);
  fs.writeFileSync(first, "x");
  const second = conflictCopyPath(target, "run_abcdef123456");
  assert.match(second, /报告\.conflict-[a-z0-9_]+-2\.docx$/);
});

console.log("\n▶ B. 暂存短锁与发布 CAS");

test("stageWrite 写完立即释放锁，其他 Run 可立即取同一文件", () => {
  const target = path.join(workspace, "short-lock.md");
  const staged = stageWrite({ runId: "run_short_a", workspace, targetPath: target, content: "a" });
  assert.equal(staged.ok, true);
  const lock = acquireWriteLock({ workspace, targetPath: target, runId: "run_short_b", kind: "write" });
  releaseWriteLock(lock);
  releaseRunLocks("run_short_a");
});

test("发布时目标被外部修改：保留外部版本，写冲突副本", () => {
  const target = path.join(workspace, "conflict.md");
  const runId = "run_conflict_0001";
  fs.writeFileSync(target, "base");
  stageWrite({ runId, workspace, targetPath: target, content: "mine" });
  fs.writeFileSync(target, "external");
  const files = publishStagedRun(runId, workspace);
  const entry = files.find((item) => item.path === "conflict.md");
  assert.equal(entry.status, "conflict");
  assert.ok(entry.conflictPath, "应记录 conflictPath");
  assert.equal(fs.readFileSync(target, "utf8"), "external", "不得覆盖外部版本");
  assert.equal(fs.readFileSync(path.join(workspace, entry.conflictPath), "utf8"), "mine");
  releaseRunLocks(runId);
});

test("发布时目标未变：正常发布并更新正式文件", () => {
  const target = path.join(workspace, "normal.md");
  const runId = "run_normal_0001";
  fs.writeFileSync(target, "base");
  stageWrite({ runId, workspace, targetPath: target, content: "next" });
  const files = publishStagedRun(runId, workspace);
  const entry = files.find((item) => item.path === "normal.md");
  assert.equal(entry.status, "published");
  assert.equal(fs.readFileSync(target, "utf8"), "next");
  releaseRunLocks(runId);
});

test("同一 Run 多次暂存保留最初 baseRevision", () => {
  const target = path.join(workspace, "twice.md");
  const runId = "run_twice_0001";
  fs.writeFileSync(target, "base");
  stageWrite({ runId, workspace, targetPath: target, content: "first" });
  const base = listStagedFiles(runId).find((item) => item.path === "twice.md").baseRevision;
  stageWrite({ runId, workspace, targetPath: target, content: "second" });
  const entry = listStagedFiles(runId).find((item) => item.path === "twice.md");
  assert.equal(entry.baseRevision, base, "baseRevision 不应被第二次暂存刷新");
  assert.equal(entry.writes, 2);
  releaseRunLocks(runId);
});

console.log("\n▶ C. 物化版本守卫");

test("目标在暂存后变化：materialize 跳过并提示", () => {
  const target = path.join(workspace, "materialize.md");
  const runId = "run_materialize_0001";
  stageWrite({ runId, workspace, targetPath: target, content: "staged" });
  fs.writeFileSync(target, "external");
  const events = [];
  const materialized = materializeStagedReferences({
    runId,
    workspace,
    paths: ["materialize.md"],
    onEvent: (type, data) => events.push({ type, data }),
  });
  assert.deepEqual(materialized, []);
  assert.equal(fs.readFileSync(target, "utf8"), "external");
  assert.ok(events.some((item) => item.type === "artifact_materialize_skipped"));
  releaseRunLocks(runId);
});

try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
console.log(failed ? "\n✗ 并发写入与版本冲突测试存在失败" : "\n✓ 并发写入与版本冲突测试全部通过");
process.exit(failed ? 1 : 0);
