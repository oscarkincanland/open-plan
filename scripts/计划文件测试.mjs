#!/usr/bin/env node
/**
 * 计划文件持久化测试
 * 覆盖：写入/读取/列表 / todo 转计划 / 路径安全
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPlans, persistPlanFromTodo, readPlan, writePlan } from "../server/计划文件.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-plan-"));

test("写入计划并读取", () => {
  const out = writePlan({ workspace, title: "Harness 改造", content: "- [ ] 元数据\n- [ ] 权限", runId: "run1" });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(out.path));
  const plan = readPlan(workspace, path.basename(out.path));
  assert.ok(plan.content.includes("Harness 改造"));
});

test("计划列表", () => {
  const plans = listPlans(workspace);
  assert.equal(plans.length, 1);
  assert.ok(plans[0].name.endsWith(".md"));
  assert.equal(plans[0].source, "workspace.plans");
});

test("从 todo 生成计划", () => {
  const out = persistPlanFromTodo({
    workspace,
    title: "任务计划",
    goal: "完成 Harness",
    runId: "run2",
    todoItems: [
      { content: "元数据", status: "completed" },
      { content: "权限", status: "pending" },
    ],
  });
  assert.equal(out.ok, true);
  const plan = readPlan(workspace, path.basename(out.path));
  assert.ok(plan.content.includes("- [x] 元数据"));
  assert.ok(plan.content.includes("- [ ] 权限"));
});

test("文件名中的非法字符被替换", () => {
  const out = writePlan({ workspace, title: "a/b:c*?", content: "x" });
  assert.equal(out.ok, true);
  assert.ok(!path.basename(out.path).includes(":"));
  assert.ok(!path.basename(out.path).includes("*"));
});

fs.rmSync(workspace, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
