#!/usr/bin/env node
/**
 * complete_task 契约测试（D1：只改工具层，不动最终答复策略）。
 *
 * 锁定四件事：
 * 1. 工具描述不再有「纯问答一句话 / 一两句 / ≤800 字」软上限；
 * 2. summary 改为完整结论契约（4000 字符硬上限 + 五要素 + 去重规则）；
 * 3. 工具返回不再回显 summary 全文；
 * 4. 范围守卫：buildOutputPolicyLines 的 Chat/Work/Review 措辞保持原样。
 *
 * 用法: node scripts/complete_task契约测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (error) {
    bad(`${name}: ${error.message}`);
  }
}

const agent源 = read("server/agent.mjs");
const 轨迹源 = read("server/运行轨迹.mjs");

console.log("\n▶ complete_task 契约");

test("工具描述不再限制一句话/一两句/800 字", () => {
  assert.doesNotMatch(agent源, /纯问答一句话即可/, "不得再要求一句话");
  assert.doesNotMatch(agent源, /一两句/, "不得再要求一两句");
  assert.doesNotMatch(agent源, /建议 ≤800 字/, "不得再限制 800 字");
});

test("summary 改为完整结论并覆盖五要素", () => {
  assert.match(agent源, /summary 是给用户看的完整结论/);
  assert.match(agent源, /关键数字/);
  assert.match(agent源, /产物路径/);
  assert.match(agent源, /如何验证/);
  assert.match(agent源, /未完成项或风险/);
});

test("summary 参数写明 4000 字符硬上限与去重规则", () => {
  assert.match(agent源, /不设字数上限（服务端上限 4000 字符）/);
  assert.match(agent源, /同一事实只写一次/);
  assert.match(agent源, /不复述工具流水/);
  assert.match(agent源, /不与进度句重复/);
});

test("工具返回不再回显 summary 全文", () => {
  assert.ok(
    agent源.includes("已记录完成状态：${label}。请直接给用户最终答复。"),
    "返回应为短确认",
  );
  assert.ok(!agent源.includes("已记录任务完成状态"), "旧版回显文案不得残留");
  assert.ok(
    !agent源.includes("已记录完成状态：${label}。${completion.summary}"),
    "返回不得拼接 summary",
  );
});

test("服务端仍以 4000 字符截断 summary（与提示词上限一致）", () => {
  assert.match(轨迹源, /String\(raw\?\.summary \|\| ""\)\.trim\(\)\.slice\(0, 4000\)/);
});

console.log("\n▶ 范围守卫（D1：只改 complete_task）");

{
  const { buildOutputPolicyLines } = await import("../server/agent.mjs");
  const chat = buildOutputPolicyLines({ mode: "chat" }).join("\n");
  const review = buildOutputPolicyLines({ mode: "review" }).join("\n");
  const work = buildOutputPolicyLines({ mode: "work" }).join("\n");
  test("Chat/Review 的最终答复仍保持短结论（本次未改）", () => {
    assert.match(chat, /1-3 句/, "Chat 策略不得被本次改动影响");
    assert.match(review, /1-3 句/, "Review 策略不得被本次改动影响");
  });
  test("Work 的最终答复仍要求结构化成果（本次未改）", () => {
    assert.match(work, /简洁但完整的 Markdown/, "Work 策略不得被本次改动影响");
  });
  test("进度句仍保留简短约束（D2）", () => {
    for (const [name, text] of [["chat", chat], ["review", review], ["work", work]]) {
      assert.match(text, /进度结论（重要）/, `${name} 模式应保留进度策略`);
    }
  });
}

console.log("\n▶ normalizeCompletion 边界");

{
  const { normalizeCompletion } = await import("../server/运行轨迹.mjs");
  test("3999 字符原样保留", () => {
    const summary = "字".repeat(3999);
    const result = normalizeCompletion({ status: "success", summary });
    assert.equal(result?.summary.length, 3999);
  });
  test("4001 字符截断到 4000", () => {
    const summary = "字".repeat(4001);
    const result = normalizeCompletion({ status: "success", summary });
    assert.equal(result?.summary.length, 4000);
  });
  test("空 summary 仍然无效", () => {
    assert.equal(normalizeCompletion({ status: "success", summary: "   " }), null);
  });
}

console.log(failed ? "\n✗ complete_task 契约测试存在失败" : "\n✓ complete_task 契约测试全部通过");
process.exitCode = failed ? 1 : 0;
