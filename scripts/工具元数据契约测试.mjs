#!/usr/bin/env node
/**
 * 工具元数据契约测试
 * 覆盖：白名单覆盖 / 五维字段 / 结果预算 / 未知工具保守默认
 */
import assert from "node:assert/strict";
import { TOOL_NAMES, getToolMetadata, metadataCoverageReport, validateToolMetadata } from "../server/工具元数据.mjs";
import { toolPolicyForMode } from "../server/task.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const allModeTools = [...new Set(["chat", "office", "agent", "review"].flatMap((mode) => toolPolicyForMode(mode).tools))];

test("所有模式白名单工具都有元数据", () => {
  const report = validateToolMetadata(allModeTools);
  assert.deepEqual(report.missing, [], `缺少元数据：${report.missing.join(", ")}`);
  assert.equal(report.errors.length, 0);
});

test("元数据覆盖报告计数有效", () => {
  const report = metadataCoverageReport(allModeTools);
  assert.ok(report.total >= TOOL_NAMES.length);
  assert.equal(report.covered, allModeTools.filter((name) => TOOL_NAMES.includes(name)).length);
});

test("只读/写/命令的关键属性正确", () => {
  assert.equal(getToolMetadata("read").readOnly, true);
  assert.equal(getToolMetadata("write").needsApproval, true);
  assert.equal(getToolMetadata("bash").permission.patternSource, "command");
  assert.equal(getToolMetadata("bash").resultBudget.preview.direction, "tail");
  assert.equal(getToolMetadata("officecli").riskLevel, "high");
  assert.equal(getToolMetadata("map_template").sideEffectScope, "session");
});

test("Chat 白名单不包含破坏性或需审批工具", () => {
  const chatTools = toolPolicyForMode("chat").tools.map((name) => getToolMetadata(name));
  assert.ok(chatTools.every((tool) => !tool.destructive && !tool.needsApproval), "Chat 不应暴露破坏性/需审批工具");
});

test("未知工具使用保守默认值", () => {
  const unknown = getToolMetadata("not_a_real_tool");
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.needsApproval, true);
  assert.equal(unknown.riskLevel, "high");
});

process.exitCode = failed ? 1 : 0;
