#!/usr/bin/env node
/**
 * 服务响应性回归（2026-11-16-008 B/C）。
 *
 * 背景：静默 Run 回收器每 30 秒用 `listRuns({limit:50, includeEvents:"latest"})`
 * 构造 50 条完整 Run 视图，实测同步阻塞约 1976ms；与导出/快照等重活撞上后
 * `/api/status` 连续 3 次超时（10s），监督器判定"进程卡死"并重启服务，
 * 前端正在轮询的导出任务号随之丢失 —— 用户看到的是"导不出来 + 服务崩溃"。
 *
 * 本测试锁定三件事：
 *   1. 回收候选查询是异步且分批让出事件循环的（单次占用不得回到秒级）；
 *   2. 回收器不再构造完整 Run 列表（禁止 includeEvents:"latest"）；
 *   3. `/api/status` 暴露 eventLoopLagMs、after 快照有总量预算。
 *
 * 用法：node scripts/服务响应性回归测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = async (名, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名}`); }
  catch (错误) { failed = 1; console.error(`  ✗ ${名}: ${错误.message}`); }
};

const runs = await import(pathToFileURL(path.join(ROOT, "server/runs.mjs")).href);
const runsSrc = read("server/runs.mjs").replace(/\r\n/g, "\n");
const indexSrc = read("server/index.mjs").replace(/\r\n/g, "\n");

await test("listRunStallCandidates 是异步接口（可分批让出事件循环）", async () => {
  const 结果 = runs.listRunStallCandidates({ limit: 50 });
  assert.ok(结果 && typeof 结果.then === "function", "必须是 async（否则无法分批让出，只能同步阻塞）");
  const 列表 = await 结果;
  assert.ok(Array.isArray(列表), "应返回数组");
  for (const 项 of 列表) {
    assert.ok(["running", "queued", "recovering"].includes(项.status), `候选状态应为活动态，实际 ${项.status}`);
  }
});

await test("扫描期间事件循环不被长时间独占（单次滞后 < 250ms）", async () => {
  let 最大滞后 = 0;
  let 上次 = Date.now();
  const 采样 = setInterval(() => {
    const 滞后 = Date.now() - 上次 - 5;
    if (滞后 > 最大滞后) 最大滞后 = 滞后;
    上次 = Date.now();
  }, 5);
  const 开始 = Date.now();
  await runs.listRunStallCandidates({ limit: 200, olderThanMs: 0 });
  const 耗时 = Date.now() - 开始;
  clearInterval(采样);
  assert.ok(最大滞后 < 250, `扫描期间事件循环滞后 ${最大滞后}ms（应 < 250ms；旧实现为秒级）`);
  assert.ok(耗时 < 5000, `扫描总耗时 ${耗时}ms 过长`);
});

await test("回收器不再构造完整 Run 列表（禁止 includeEvents:\"latest\"）", async () => {
  const 起点 = indexSrc.indexOf("async function reapStalledRunsOnce");
  assert.ok(起点 > 0, "找不到 reapStalledRunsOnce");
  const 段 = indexSrc.slice(起点, indexSrc.indexOf("const runReaperTimer", 起点));
  assert.doesNotMatch(段, /includeEvents/, "回收器不得再用 includeEvents 构造完整列表（实测同步 1976ms）");
  assert.match(段, /listRunStallCandidates\(/, "回收器必须走轻量候选查询");
  assert.match(段, /olderThanMs:\s*RUN_STALL_MS/, "应按停滞阈值在 stat 阶段预筛，减少扫描量");
  assert.match(indexSrc, /let reaperRunning = false;/, "回收器应有防重入门闸");
});

await test("/api/status 暴露事件循环延迟（区分卡死与阻塞）", async () => {
  assert.match(indexSrc, /eventLoopLagMs/, "/api/status 应返回 eventLoopLagMs");
  assert.match(indexSrc, /eventLoopLagMs = Math\.max\(0, Math\.max\(late/, "应有周期性延迟采样");
});

await test("after 快照复制有总量预算（避免 finishRun 连续同步拷贝几百 MB）", async () => {
  const 起点 = runsSrc.indexOf("function copyAfterBlobs");
  assert.ok(起点 > 0, "找不到 copyAfterBlobs");
  const 段 = runsSrc.slice(起点, runsSrc.indexOf("\n}", 起点) + 2);
  assert.match(段, /let remaining = MAX_BLOB_TOTAL;/, "应复用 MAX_BLOB_TOTAL 预算");
  assert.match(段, /remaining -= /, "应按实际复制量扣减预算");
  assert.match(段, /if \(remaining <= 0\) break;/, "预算耗尽应停止复制");
});

if (failed) {
  console.error("\n服务响应性回归：存在失败");
  process.exit(1);
}
console.log("\n服务响应性回归：全部通过");
