#!/usr/bin/env node
/**
 * Skill 注入契约测试
 * 覆盖：<skill_content> 块 / 20KB 预算 / 哈希 / 截断标记
 */
import assert from "node:assert/strict";
import { DEFAULT_SKILL_MAX_BYTES, buildSkillInjection } from "../server/Skill注入.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("小技能完整注入", () => {
  const out = buildSkillInjection({ name: "demo", raw: "# Demo\n步骤", source: "project" });
  assert.ok(out.text.startsWith('<skill_content name="demo"'));
  assert.ok(out.text.includes("步骤"));
  assert.equal(out.truncated, false);
  assert.equal(out.hash.length, 12);
});

test("大技能按预算截断", () => {
  const out = buildSkillInjection({ name: "big", raw: "A".repeat(DEFAULT_SKILL_MAX_BYTES + 1000) });
  assert.equal(out.truncated, true);
  assert.ok(out.bytes <= DEFAULT_SKILL_MAX_BYTES);
  assert.ok(out.text.includes('truncated="true"'));
});

test("空内容仍可注入且哈希稳定", () => {
  const a = buildSkillInjection({ name: "empty", raw: "" });
  const b = buildSkillInjection({ name: "empty", raw: "" });
  assert.equal(a.hash, b.hash);
  assert.ok(a.text.includes("<skill_content"));
});

process.exitCode = failed ? 1 : 0;
