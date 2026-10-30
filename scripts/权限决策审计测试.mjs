#!/usr/bin/env node
/**
 * 权限决策审计测试
 * 覆盖：ruleId / 默认规则 / 敏感文件 deny / 共享图层 deny / 最后匹配生效 / 拒绝错误带 ruleId
 */
import assert from "node:assert/strict";
import { getApprovalMode, matchToolAction, matchToolDecision, requireToolApproval, setApprovalMode } from "../server/审批策略.mjs";

const originalMode = getApprovalMode();
setApprovalMode("ask");
process.on("exit", () => { try { setApprovalMode(originalMode); } catch {} });

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("Office 写入默认 ask 且返回 ruleId", () => {
  const decision = matchToolDecision("officecli", "set report.docx /body/p[1] --prop bold=true");
  assert.equal(decision.action, "ask");
  assert.ok(decision.ruleId.startsWith("default."));
  assert.equal(decision.ruleSource, "default");
  assert.equal(decision.matchedPattern, "set *");
});

test("bash 删除默认 ask", () => {
  const decision = matchToolDecision("bash", "rm -rf build");
  assert.equal(decision.action, "ask");
  assert.ok(decision.ruleId.includes("bash"));
});

test("敏感文件写入 deny", () => {
  const decision = matchToolDecision("write", "C:/workspace/.env");
  assert.equal(decision.action, "deny");
  assert.equal(matchToolAction("write", "C:/workspace/.env"), "deny");
});

test("共享图层导入 deny，workspace 编辑 allow", () => {
  assert.equal(matchToolAction("map_import", "shared/highway.geojson"), "deny");
  assert.equal(matchToolAction("map_edit", "workspace/own.geojson"), "allow");
});

test("MCP 默认 ask", () => {
  const decision = matchToolDecision("mcp", "weather/get");
  assert.equal(decision.action, "ask");
});

test("auto 模式只提升 ask，保留 originalAction 与 ruleId", () => {
  setApprovalMode("auto");
  try {
    const decision = matchToolDecision("officecli", "set report.docx /body/p[1] --prop bold=true");
    assert.equal(decision.action, "allow");
    assert.equal(decision.originalAction, "ask");
    assert.ok(decision.ruleId.startsWith("auto."));
  } finally {
    setApprovalMode("ask");
  }
});

test("拒绝错误带 ruleId", async () => {
  let error = null;
  try {
    await requireToolApproval({ entry: null, tool: "write", input: "C:/workspace/.env" });
  } catch (value) {
    error = value;
  }
  assert.ok(error, "应当拒绝");
  assert.equal(error.code, "APPROVAL_DENIED");
  assert.ok(error.ruleId);
  assert.equal(error.action, "deny");
});

process.exitCode = 0;
setTimeout(() => { process.exitCode = failed ? 1 : 0; }, 50);
