#!/usr/bin/env node
/**
 * 工具错误 envelope 测试
 * 覆盖：稳定 code / suggestion / retryable / 异常包装
 */
import assert from "node:assert/strict";
import { normalizeToolError, toolError, withToolErrorEnvelope } from "../server/工具错误.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("toolError 提供可执行建议", () => {
  const error = toolError("invalid_value", "bad value");
  assert.equal(error.code, "invalid_value");
  assert.ok(error.suggestion.length > 0);
  assert.equal(error.retryable, false);
});

test("可重试 code 自动标记", () => {
  assert.equal(toolError("timeout", "slow").retryable, true);
  assert.equal(toolError("permission_denied", "no").retryable, false);
});

test("normalizeToolError 保留已有 envelope", () => {
  const error = normalizeToolError({ code: "not_found", message: "missing" });
  assert.equal(error.code, "not_found");
  assert.ok(error.suggestion);
});

test("包装 execute 后异常变成统一返回", async () => {
  const execute = withToolErrorEnvelope("demo", async () => { throw Object.assign(new Error("boom"), { code: "invalid_value" }); });
  const result = await execute();
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "invalid_value");
  assert.ok(result.content[0].text.includes("建议"));
});

process.exitCode = failed ? 1 : 0;
setTimeout(() => { process.exitCode = failed ? 1 : 0; }, 50);
