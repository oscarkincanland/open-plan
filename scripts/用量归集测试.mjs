#!/usr/bin/env node
/**
 * 用量归集测试
 * 覆盖：JSONL 追加 / 归因聚合 / 读取过滤 / 未知字段不估算
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendUsageRecord, readUsageRecords, summarizeUsage, usageSnapshotForRun } from "../server/用量归集.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-usage-"));
const file = path.join(dir, "用量.jsonl");

test("主会话记录写入并读取", () => {
  const out = appendUsageRecord({
    runId: "run1", turnId: 1, actorKind: "main", querySource: "agent_step",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 },
    model: "provider/model", cost: 0.01,
  }, { file });
  assert.equal(out.ok, true);
  const records = readUsageRecords({ file, runId: "run1" });
  assert.equal(records.length, 1);
  assert.equal(records[0].inputTokens, 100);
  assert.equal(records[0].cacheReadTokens, 300);
});

test("子代理与压缩归因", () => {
  appendUsageRecord({ runId: "run1", actorKind: "subagent", actorId: "child1", querySource: "agent_step", usage: { inputTokens: 50, outputTokens: 5 } }, { file });
  appendUsageRecord({ runId: "run1", actorKind: "compaction", querySource: "compact" }, { file });
  const summary = summarizeUsage(readUsageRecords({ file, runId: "run1" }));
  assert.equal(summary.total.count, 3);
  const actors = Object.fromEntries(summary.byActor.map((item) => [item.key, item.count]));
  assert.equal(actors.main, 1);
  assert.equal(actors.subagent, 1);
  assert.equal(actors.compaction, 1);
  assert.ok(summary.byQuerySource.some((item) => item.key === "compact"));
});

test("缺失字段保持 null，不估算", () => {
  const records = readUsageRecords({ file, runId: "run1" });
  const compaction = records.find((item) => item.actorKind === "compaction");
  assert.equal(compaction.inputTokens, null);
  assert.equal(compaction.outputTokens, null);
});

test("按 Run 过滤", () => {
  appendUsageRecord({ runId: "run2", actorKind: "main", usage: { inputTokens: 1 } }, { file });
  assert.equal(readUsageRecords({ file, runId: "run1" }).length, 3);
  assert.equal(usageSnapshotForRun("run2", { file }).records.length, 1);
});

fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
