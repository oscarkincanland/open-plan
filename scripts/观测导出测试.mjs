#!/usr/bin/env node
/**
 * 观测导出测试
 * 覆盖：usage 聚合 / 报表结构 / 空数据不报错
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-observability-"));
const usageFile = path.join(dir, "用量.jsonl");
process.env.OAW_USAGE_FILE = usageFile;

const { appendUsageRecord } = await import("../server/用量归集.mjs");
const { buildObservabilityReport, exportObservabilityJson, summarizeRunUsage } = await import("../server/观测导出.mjs");

appendUsageRecord({ runId: "run1", actorKind: "main", querySource: "agent_step", usage: { inputTokens: 100, outputTokens: 10 } }, { file: usageFile });
appendUsageRecord({ runId: "run1", actorKind: "subagent", querySource: "agent_step", usage: { inputTokens: 50, outputTokens: 5 } }, { file: usageFile });

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("按 Run 汇总", () => {
  const summary = summarizeRunUsage({ runId: "run1", usageFile });
  assert.equal(summary.count, 2);
  assert.equal(summary.summary.total.inputTokens, 150);
  assert.equal(summary.summary.byActor.length, 2);
});

test("报表包含 usage 与延迟结构", () => {
  const report = buildObservabilityReport({ runId: "run1", usageFile });
  assert.equal(report.runId, "run1");
  assert.equal(report.usage.recordCount, 2);
  assert.ok(report.usage.summary);
  assert.ok(report.latency);
  assert.ok(Array.isArray(report.recentLatency));
});

test("导出 JSON 可解析", () => {
  const text = exportObservabilityJson({ runId: "run1", usageFile });
  const parsed = JSON.parse(text);
  assert.equal(parsed.usage.recordCount, 2);
});

test("空 Run 不报错", () => {
  const report = buildObservabilityReport({ runId: "missing", usageFile });
  assert.equal(report.usage.recordCount, 0);
  assert.equal(report.usage.summary.total.count, 0);
});

fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
