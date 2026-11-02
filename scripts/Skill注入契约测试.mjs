#!/usr/bin/env node
/**
 * Skill 注入契约测试
 * 覆盖：<skill_content> 块 / 20KB 预算 / 哈希 / 截断标记
 *      以及常用技能短清单：计数、排序、冷启动回退
 */
import assert from "node:assert/strict";
import {
  DEFAULT_SKILL_MAX_BYTES,
  TOP_SKILLS_IN_PROMPT,
  buildSkillInjection,
  normalizeSkillUsage,
  bumpSkillUsage,
  rankSkillsByUsage,
  pickTopSkills,
} from "../server/Skill注入.mjs";

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

// ---- 常用技能短清单 ----

test("normalizeSkillUsage 过滤非法计数", () => {
  const out = normalizeSkillUsage({ a: 3, b: "5", c: 0, d: -1, e: "x", "": 2, f: 2.9 });
  assert.deepEqual(out, { a: 3, b: 5, f: 2 });
});

test("bumpSkillUsage 递增且不改入参", () => {
  const base = { docx: 2 };
  const next = bumpSkillUsage(base, "docx");
  assert.equal(next.docx, 3);
  assert.equal(base.docx, 2);
  assert.deepEqual(bumpSkillUsage({}, "pptx"), { pptx: 1 });
  assert.deepEqual(bumpSkillUsage({}, "  "), {});
});

test("rankSkillsByUsage 按频次降序、同频次按名称升序", () => {
  const skills = [
    { name: "aaa" }, { name: "zzz" }, { name: "mmm" }, { name: "unused" },
  ];
  const ranked = rankSkillsByUsage(skills, { zzz: 5, aaa: 2, mmm: 2 }).map((s) => s.name);
  assert.deepEqual(ranked, ["zzz", "aaa", "mmm", "unused"]);
});

test("pickTopSkills 有使用记录时按频次取前 N", () => {
  const skills = Array.from({ length: 12 }, (_, i) => ({ name: `s${String(i).padStart(2, "0")}` }));
  const usage = { s03: 9, s01: 5, s11: 2 };
  const top = pickTopSkills(skills, usage, { limit: 3 }).map((s) => s.name);
  assert.deepEqual(top, ["s03", "s01", "s11"]);
});

test("pickTopSkills 冷启动回退默认优先级且只取目录中存在的", () => {
  const skills = [{ name: "pptx" }, { name: "docx" }, { name: "unknown-skill" }];
  const top = pickTopSkills(skills, {}, { limit: 2 }).map((s) => s.name);
  assert.deepEqual(top, ["docx", "pptx"]);
  assert.equal(pickTopSkills([], {}).length, 0);
});

test("TOP_SKILLS_IN_PROMPT 保持小清单", () => {
  assert.ok(TOP_SKILLS_IN_PROMPT <= 8);
});

process.exitCode = failed ? 1 : 0;
