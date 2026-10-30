#!/usr/bin/env node
/**
 * 子代理 profile 测试
 * 覆盖：冻结字段 / 校验 / 变更检测
 */
import assert from "node:assert/strict";
import { SUBAGENT_ROLES } from "../server/子代理编排器.mjs";
import { buildSubagentProfile, profileDiff, validateSubagentProfile } from "../server/子代理配置.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("profile 冻结角色/工具/模型/预算", () => {
  const profile = buildSubagentProfile({
    childId: "subagent_1",
    role: "worker",
    roleSpec: SUBAGENT_ROLES.worker,
    model: "provider/model",
    budget: { timeoutMs: 1000, maxTurns: 5 },
    frozenAt: "2026-10-27T00:00:00.000Z",
  });
  assert.equal(profile.childId, "subagent_1");
  assert.equal(profile.role, "worker");
  assert.equal(profile.readOnly, false);
  assert.ok(profile.tools.includes("write"));
  assert.equal(profile.model, "provider/model");
  assert.equal(profile.budget.maxTurns, 5);
  assert.equal(profile.frozenAt, "2026-10-27T00:00:00.000Z");
});

test("profile 校验", () => {
  assert.equal(validateSubagentProfile(buildSubagentProfile({ role: "scout", roleSpec: SUBAGENT_ROLES.scout })).ok, true);
  assert.equal(validateSubagentProfile({}).ok, false);
});

test("profile 变更检测", () => {
  const a = buildSubagentProfile({ role: "scout", roleSpec: SUBAGENT_ROLES.scout });
  const b = { ...a, tools: [...a.tools, "write"] };
  assert.deepEqual(profileDiff(a, b), ["tools"]);
  assert.deepEqual(profileDiff(a, { ...a }), []);
});

process.exitCode = failed ? 1 : 0;
