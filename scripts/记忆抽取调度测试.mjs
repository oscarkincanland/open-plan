#!/usr/bin/env node
/**
 * 记忆抽取调度测试
 * 覆盖：触发条件 / 解析 / 候选提交 / 无效输出
 */
import assert from "node:assert/strict";
import { countProseWords, parseExtractionResult, runMemoryExtraction, shouldExtract } from "../server/记忆抽取调度.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("中英文词数统计", () => {
  assert.ok(countProseWords("请记住这个项目") >= 6);
  assert.ok(countProseWords("hello world") >= 2);
});

test("触发条件：Work + 散文≥3词 + 未直接写记忆", () => {
  assert.equal(shouldExtract({ userText: "请记住这个项目", mode: "agent" }).ok, true);
  assert.equal(shouldExtract({ userText: "短", mode: "agent" }).ok, false);
  assert.equal(shouldExtract({ userText: "请记住这个项目", mode: "chat" }).ok, false);
  assert.equal(shouldExtract({ userText: "请记住这个项目", mode: "agent", hadDirectMemoryWrite: true }).ok, false);
});

test("解析 save / nothing / invalid", () => {
  assert.deepEqual(parseExtractionResult('{"action":"save","category":"项目事实","content":"金东项目重点做 OD 分析"}'), {
    action: "save", category: "project_fact", content: "金东项目重点做 OD 分析",
  });
  assert.equal(parseExtractionResult("Nothing to save.").action, "nothing");
  assert.equal(parseExtractionResult("not json").action, "invalid");
  assert.equal(parseExtractionResult('{"action":"save","category":"未知","content":"x"}').action, "invalid");
});

test("执行抽取并提交候选", async () => {
  let captured = null;
  const result = await runMemoryExtraction({
    userText: "请记住这个项目重点做 OD 分析",
    assistantText: "好的",
    workspace: "C:/workspace",
    runId: "run1",
    runTask: async () => '{"action":"save","category":"项目事实","content":"项目重点做 OD 分析"}',
    createProposal: (candidate) => { captured = candidate; return { id: "memory_1" }; },
  });
  assert.equal(result.action, "save");
  assert.equal(captured.category, "project_fact");
  assert.equal(captured.runId, "run1");
  assert.equal(result.proposal.id, "memory_1");
});

test("Nothing to save 不提交候选", async () => {
  let called = false;
  const result = await runMemoryExtraction({
    userText: "随便聊聊",
    runTask: async () => "Nothing to save.",
    createProposal: () => { called = true; return {}; },
  });
  assert.equal(result.action, "nothing");
  assert.equal(called, false);
});

setTimeout(() => { process.exitCode = failed ? 1 : 0; }, 50);
