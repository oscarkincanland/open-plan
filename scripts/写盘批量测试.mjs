#!/usr/bin/env node
/**
 * P2 写盘批量回归测试：
 * 1. 合并窗口内的连续追加只做一次 fsync，其余延迟；
 * 2. 写入本身立即生效（读进程可见，不受 fsync 合并影响）；
 * 3. flushPendingFsync() 能把延迟部分补齐。
 *
 * 用法: node scripts/写盘批量测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.OAW_FSYNC_INTERVAL_MS = "10000";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-fsync-"));
const file = path.join(tmp, "事件.jsonl");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const mod = await import(pathToFileURL(path.resolve("server/持久化工具.mjs")).href);

console.log("\n▶ P2 fsync 合并");

test("连续 5 次追加：1 次立即 fsync + 4 次延迟", () => {
  for (let index = 0; index < 5; index += 1) mod.appendJsonLine(file, { index });
  const stats = mod.fsyncStatsSnapshot();
  assert.equal(stats.writes, 5);
  assert.equal(stats.syncs, 1, `期望 1 次立即 sync，实际 ${stats.syncs}`);
  assert.equal(stats.deferred, 4, `期望 4 次延迟，实际 ${stats.deferred}`);
  assert.equal(stats.pendingFiles, 1, "应有 1 个待 flush 文件");
});

test("延迟 fsync 不影响读取可见性", () => {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((line) => JSON.parse(line).index), [0, 1, 2, 3, 4]);
});

test("flushPendingFsync 补齐延迟部分", () => {
  mod.flushPendingFsync();
  const stats = mod.fsyncStatsSnapshot();
  assert.equal(stats.syncs, 2, `flush 后应为 2 次 sync，实际 ${stats.syncs}`);
  assert.equal(stats.pendingFiles, 0);
});

test("策略可通过 OAW_FSYNC_INTERVAL_MS 配置", () => {
  assert.equal(mod.fsyncStatsSnapshot().intervalMs, 10000);
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(failed ? "\n✗ 写盘批量测试存在失败" : "\n✓ 写盘批量测试全部通过");
process.exitCode = failed ? 1 : 0;
