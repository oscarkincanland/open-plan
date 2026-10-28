#!/usr/bin/env node
/**
 * Harness 开关对照测试
 * 覆盖：开关齐备 / 类型正确 / 快照下发 / 默认关闭（无环境变量时）
 */
import assert from "node:assert/strict";
import { RUNTIME_FLAGS, runtimeFlagsSnapshot } from "../server/运行开关.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const booleanFlags = [
  "harnessAlign", "toolMetadata", "permissionAudit", "permissionAuditAllow", "toolResultArtifact",
  "usageLedger", "memoryRecall", "memoryExtract", "contextSections", "skillInjection",
  "hookEvents", "subagentProfile", "toolErrorEnvelope", "configSource",
  "workflowJournal", "pluginManifest", "planPersistence", "observabilityExport",
];

test("所有 H 线布尔开关存在且为布尔值", () => {
  for (const key of booleanFlags) {
    assert.equal(typeof RUNTIME_FLAGS[key], "boolean", `${key} 不是布尔值`);
  }
});

test("数值开关有效", () => {
  assert.ok(RUNTIME_FLAGS.toolResultMaxBytes >= 1024);
  assert.ok(RUNTIME_FLAGS.memoryRecallMaxBytes >= 1024);
  assert.ok(RUNTIME_FLAGS.skillInjectionMaxBytes >= 1024);
  assert.ok(RUNTIME_FLAGS.hookTimeoutMs >= 100);
});

test("快照包含全部 H 线开关", () => {
  const snapshot = runtimeFlagsSnapshot();
  for (const key of booleanFlags) assert.equal(typeof snapshot[key], "boolean", `快照缺少 ${key}`);
});

test("未设置 OAW_HARNESS_ALIGN 时单开关默认关闭", () => {
  if (String(process.env.OAW_HARNESS_ALIGN || "").trim()) return; // 环境显式开启时跳过
  for (const key of booleanFlags.filter((item) => item !== "harnessAlign")) {
    assert.equal(RUNTIME_FLAGS[key], false, `${key} 默认应为 false`);
  }
});

process.exitCode = failed ? 1 : 0;
