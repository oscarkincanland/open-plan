#!/usr/bin/env node
/**
 * 工具元数据契约测试
 * 覆盖：白名单覆盖（正向+反向）/ 五维字段 / 结果预算 / 未知工具保守默认
 *
 * 反向断言是 2026-11-01 收敛时补的：2026-10-29 之后陆续加入白名单的
 * map_layer_info/map_reset/map_project_create/browser_wait_for/browser_act/
 * browser_extract/browser_select_option 七个工具没有同步元数据表，
 * 而本测试当时只做正向覆盖（白名单 → 元数据），因此一直"绿"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TOOL_NAMES, getToolMetadata, metadataCoverageReport, validateToolMetadata } from "../server/工具元数据.mjs";
import { toolPolicyForMode } from "../server/task.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const allModeTools = [...new Set(["chat", "office", "agent", "review"].flatMap((mode) => toolPolicyForMode(mode).tools))];
// 内部工具：不对模型暴露，但仍需在元数据表里可追溯（AGENTS.md §5）。
// run_subagent 由会话按 hasSubagent 动态注入（AGENTS.md §5 明文允许），不进静态白名单。
const INTERNAL_TOOLS = new Set(["editorial_pipeline", "review_copy", "review_source_apply", "run_subagent"]);

test("所有模式白名单工具都有元数据", () => {
  const report = validateToolMetadata(allModeTools);
  assert.deepEqual(report.missing, [], `缺少元数据：${report.missing.join(", ")}`);
  assert.equal(report.errors.length, 0);
});

test("反向：元数据表里的工具都在白名单或显式内部工具集中", () => {
  // 防止"定义了工具却没进任何白名单"（Work 模式调不到）。
  const orphans = TOOL_NAMES.filter((name) => !allModeTools.includes(name) && !INTERNAL_TOOLS.has(name));
  assert.deepEqual(orphans, [], `以下工具有元数据但不在任何白名单：${orphans.join(", ")}`);
});

test("白名单与 agent.mjs 的会话工具全集一致（不得有第二份清单）", () => {
  const agent源 = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.ok(
    !/tools:\s*\[\s*"read"\s*,/.test(agent源),
    "agent.mjs 不得再维护硬编码的工具名清单，应从 server/task.mjs 派生",
  );
  assert.match(agent源, /allModeToolNames\(\)/, "agent.mjs 应通过 allModeToolNames() 取得工具全集");
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
