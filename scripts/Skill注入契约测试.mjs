#!/usr/bin/env node
/**
 * Skill 注入契约测试
 * 覆盖：<skill_content> 块 / 20KB 预算 / 哈希 / 截断标记
 *      以及常用技能短清单：计数、排序、冷启动回退
 */
import assert from "node:assert/strict";
import {
  DEFAULT_SKILL_MAX_BYTES,
  buildSkillCatalog,
  buildSkillInjection,
  normalizeSkillUsage,
  bumpSkillUsage,
  rankSkillsByUsage,
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

test("buildSkillCatalog：workspace/project 优先，同 scope 按频次", () => {
  const out = buildSkillCatalog({
    skills: [
      { name: "user-hot", description: "用户常用", sourceScope: "user" },
      { name: "proj", description: "项目", sourceScope: "project" },
      { name: "ws", description: "工作区", sourceScope: "workspace" },
    ],
    usage: { "user-hot": 99 },
  });
  assert.ok(out.text.indexOf("`ws`") < out.text.indexOf("`proj`"));
  assert.ok(out.text.indexOf("`proj`") < out.text.indexOf("`user-hot`"));
  assert.equal(out.count, 3);
  assert.equal(out.included, 3);
});

test("buildSkillCatalog：预算不足时截断但保留合法闭合", () => {
  const skills = Array.from({ length: 40 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, "0")}`,
    description: "很长的描述".repeat(30),
    sourceScope: "user",
  }));
  const out = buildSkillCatalog({ skills, budgetBytes: 800 });
  assert.equal(out.truncated, true);
  assert.ok(out.bytes <= 900, `预算附近，实际 ${out.bytes}`);
  assert.ok(out.text.includes("</available_skills>"));
});

test("buildSkillCatalog：空目录返回合法空清单", () => {
  const out = buildSkillCatalog({ skills: [] });
  assert.equal(out.count, 0);
  assert.equal(out.included, 0);
  assert.ok(out.text.includes("<available_skills>"));
});

process.exitCode = failed ? 1 : 0;
