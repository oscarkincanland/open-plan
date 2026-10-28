#!/usr/bin/env node
/**
 * WP-T1 收尾等待快路径回归测试：
 * 1. 工作区没有变化时，waitForFlush 立即返回（不再固定等 1.5s）；
 * 2. 有变化时仍会等待写入稳定并返回变更集合；
 * 3. 源码契约：最多 4 轮、首轮是即时快照。
 *
 * 用法: node scripts/首字延迟修复测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-waitflush-"));

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const { waitForFlush } = await import(pathToFileURL(path.resolve(ROOT, "server/执行句柄.mjs")).href);
const before = { root: tmp, files: {}, size: 0, truncated: false };

console.log("\n▶ T1 waitForFlush 快路径");

await test("工作区无变化：立即返回（< 400ms）", async () => {
  const started = Date.now();
  const changes = await waitForFlush(before, tmp);
  const elapsed = Date.now() - started;
  assert.deepEqual(changes, []);
  assert.ok(elapsed < 400, `实际耗时 ${elapsed}ms，仍像固定等待`);
});

await test("有新增文件：等待稳定后返回该文件（< 4s）", async () => {
  fs.writeFileSync(path.join(tmp, "新增.md"), "# 内容\n");
  const started = Date.now();
  const changes = await waitForFlush(before, tmp);
  const elapsed = Date.now() - started;
  assert.ok(changes.includes("新增.md"), `变更集合应包含新增.md，实际 ${JSON.stringify(changes)}`);
  assert.ok(elapsed < 4000, `实际耗时 ${elapsed}ms`);
});

console.log("\n▶ T1 源码契约");

await test("轮询上限 4 轮，首轮为即时快照", async () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "执行句柄.mjs"), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /for \(let i = 0; i < 4; i\+\+\) \{\n\s*const snapshot = snapshotWorkspace\(workspace\);/);
  assert.doesNotMatch(source, /for \(let i = 0; i < 6; i\+\+\)/);
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(failed ? "\n✗ 首字延迟修复测试存在失败" : "\n✓ 首字延迟修复测试全部通过");
process.exitCode = failed ? 1 : 0;
