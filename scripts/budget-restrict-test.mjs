#!/usr/bin/env node
/**
 * budget-restrict-test（计划 2026-10-31-003 / N-07）。
 *
 * 覆盖：
 *   1. 硬预算触发 → restricted=true；
 *   2. restricted 后：变更类工具被拦（TOOL_RESTRICTED）；
 *   3. restricted 后：只读与收尾交互工具放行；
 *   4. 用户显式"继续"（grantBudget）解除 restricted；
 *   5. 未触发硬预算时 restricted 恒为 false（不误伤正常任务）。
 *
 * 用法: node scripts/budget-restrict-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const {
  createRunBudget,
  evaluateTurnGate,
  evaluateRestrictedTool,
  enterRestrictedMode,
  grantBudget,
  noteTurn,
  budgetSnapshot,
  TURN_BUDGET_SOFT,
  TURN_BUDGET_HARD,
} = await load("server/运行预算.mjs");

console.log("\n▶ 硬预算触发受限模式");

await test("回落到硬预算时 evaluateTurnGate 返回 hard", () => {
  const state = createRunBudget({ runId: "r1" });
  for (let i = 0; i < TURN_BUDGET_HARD; i += 1) noteTurn(state);
  const gate = evaluateTurnGate(state);
  assert.equal(gate.level, "hard");
  assert.equal(gate.code, "TURN_BUDGET_HARD");
  assert.ok(gate.reason.includes("受限收尾"), "原因文案应说明进入受限收尾");
});

await test("软预算仍是 soft（不进入受限模式）", () => {
  const state = createRunBudget({ runId: "r2" });
  for (let i = 0; i < TURN_BUDGET_SOFT; i += 1) noteTurn(state);
  const gate = evaluateTurnGate(state);
  assert.equal(gate.level, "soft");
  assert.equal(state.restricted, false, "软预算不应限制工具");
});

await test("未到预算时 restricted 恒为 false（不误伤正常任务）", () => {
  const state = createRunBudget({ runId: "r3" });
  for (let i = 0; i < 10; i += 1) noteTurn(state);
  evaluateTurnGate(state);
  assert.equal(state.restricted, false);
  assert.equal(evaluateRestrictedTool(state, { toolName: "write", mutating: true }).allow, true);
});

await test("进入受限模式后 restricted=true 且快照可见", () => {
  const state = createRunBudget({ runId: "r4" });
  enterRestrictedMode(state);
  assert.equal(state.restricted, true);
  assert.equal(budgetSnapshot(state).restricted, true, "诊断快照应带 restricted 位");
});

console.log("\n▶ 受限模式下的工具判定");

await test("变更类工具被拦（write / edit / bash / officecli / editorial_pipeline）", () => {
  const state = createRunBudget({ runId: "r5" });
  enterRestrictedMode(state);
  for (const tool of ["write", "edit", "bash", "officecli", "editorial_pipeline"]) {
    const gate = evaluateRestrictedTool(state, { toolName: tool, mutating: true });
    assert.equal(gate.allow, false, `${tool} 应被拦`);
    assert.equal(gate.code, "TOOL_RESTRICTED");
    assert.ok(gate.reason.includes("complete_task"), "拒绝原因应指向 complete_task");
  }
});

await test("只读与收尾交互工具放行", () => {
  const state = createRunBudget({ runId: "r6" });
  enterRestrictedMode(state);
  for (const tool of ["read", "ls", "find", "grep", "todo", "ask_user", "complete_task"]) {
    const gate = evaluateRestrictedTool(state, { toolName: tool, mutating: false });
    assert.equal(gate.allow, true, `${tool} 应放行`);
    assert.equal(gate.code, null);
  }
});

await test("未受限时一切放行", () => {
  const state = createRunBudget({ runId: "r7" });
  const gate = evaluateRestrictedTool(state, { toolName: "write", mutating: true });
  assert.equal(gate.allow, true);
  assert.equal(gate.code, null);
});

await test("用户显式「继续」解除受限", () => {
  const state = createRunBudget({ runId: "r8" });
  enterRestrictedMode(state);
  assert.equal(state.restricted, true);
  grantBudget(state, { turns: 10, tools: 10 });
  assert.equal(state.restricted, false, "显式继续应解除受限");
  assert.equal(evaluateRestrictedTool(state, { toolName: "write", mutating: true }).allow, true);
});

await test("受限状态下重复失败门禁仍可判定（不受影响）", () => {
  const state = createRunBudget({ runId: "r9" });
  enterRestrictedMode(state);
  const gate = evaluateRestrictedTool(state, { toolName: "read", mutating: false });
  assert.equal(gate.allow, true);
  assert.equal(state.lastCall, null, "受限判定不应污染工具调用指纹");
});

console.log(failed ? "\n✗ budget-restrict-test存在失败项\n" : "\n✓ budget-restrict-test全部通过\n");
process.exit(failed ? 1 : 0);
