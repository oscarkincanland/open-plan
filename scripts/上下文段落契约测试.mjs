#!/usr/bin/env node
/**
 * 上下文段落契约测试
 * 覆盖：固定顺序 / 注入目标 / 预算 / 渲染 / 校验
 */
import assert from "node:assert/strict";
import { SECTION_ORDER, buildContextSections, renderContextSections, sectionSummary, validateContextSections } from "../server/上下文段落.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("段落顺序固定", () => {
  const sections = buildContextSections({ dynamicContext: "DYN", taskSummary: "TASK", referencesSummary: "REF", recoveredAnswers: [{ question: "Q", answer: "A" }], userText: "USER" });
  assert.deepEqual(sections.map((item) => item.id), SECTION_ORDER);
});

test("注入目标与缓存标记正确", () => {
  const sections = buildContextSections({});
  const byId = Object.fromEntries(sections.map((item) => [item.id, item]));
  assert.equal(byId.kernel.target, "system");
  assert.equal(byId["workspace-rules"].cacheHint, "stable");
  assert.equal(byId["dynamic-context"].cacheHint, "dynamic");
  assert.equal(byId["user-input"].target, "prompt");
});

test("渲染只包含非空段落且顺序正确", () => {
  const sections = buildContextSections({ dynamicContext: "DYN", taskSummary: "TASK", referencesSummary: "REF", recoveredAnswers: [{ question: "Q", answer: "A" }], userText: "USER" });
  const text = renderContextSections(sections);
  assert.ok(text.indexOf("DYN") < text.indexOf("TASK"));
  assert.ok(text.indexOf("TASK") < text.indexOf("REF"));
  assert.ok(text.indexOf("REF") < text.indexOf("恢复的用户回答"));
  assert.ok(text.indexOf("恢复的用户回答") < text.indexOf("USER"));
});

test("预算截断与校验", () => {
  const sections = buildContextSections({ dynamicContext: "X".repeat(10000) });
  const summary = sectionSummary(sections);
  const dynamic = summary.find((item) => item.id === "dynamic-context");
  assert.equal(dynamic.truncated, true);
  assert.ok(dynamic.bytes <= 6000);
  assert.equal(validateContextSections(sections).ok, true);
});

process.exitCode = failed ? 1 : 0;
