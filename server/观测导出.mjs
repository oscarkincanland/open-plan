/**
 * 观测导出（H4-5）
 *
 * 把用量 JSONL 与首字延迟样本聚合为只读报表；不引入 OTel、不引入数据库。
 */
import { readUsageRecords, summarizeUsage, usageFilePath } from "./用量归集.mjs";
import { latencySummary, recentLatencySamples } from "./首字延迟.mjs";

export function buildObservabilityReport({ runId = "", usageFile = usageFilePath(), recent = 20 } = {}) {
  const records = readUsageRecords({ file: usageFile, runId, limit: 0 });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    runId: runId || null,
    usage: {
      file: usageFile,
      recordCount: records.length,
      summary: summarizeUsage(records),
    },
    latency: latencySummary(),
    recentLatency: recentLatencySamples(recent),
  };
}

export function exportObservabilityJson({ runId = "", usageFile = usageFilePath(), recent = 20, pretty = true } = {}) {
  const report = buildObservabilityReport({ runId, usageFile, recent });
  return pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
}

export function summarizeRunUsage({ runId = "", usageFile = usageFilePath() } = {}) {
  const records = readUsageRecords({ file: usageFile, runId, limit: 0 });
  return { runId, count: records.length, summary: summarizeUsage(records), records };
}
