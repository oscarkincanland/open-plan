#!/usr/bin/env node
/**
 * 权限决策审计测试
 * 覆盖：ruleId / 默认规则 / 敏感文件 deny / 共享图层 deny / 最后匹配生效 / 拒绝错误带 ruleId
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离：本测试必须只读默认规则，不能被用户真实「总是允许」规则污染。
// 2026-11-18 排查：`.oaw/permissions.json` 里的 `officecli set *` allow 让断言从 ask 变成 allow。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-perm-"));
const permFile = path.join(tmpDir, "permissions.json");
fs.writeFileSync(permFile, JSON.stringify({ rules: [], mode: "ask" }), "utf8");
process.env.OAW_PERMISSIONS_FILE = permFile;
process.env.OAW_PENDING_APPROVALS_FILE = path.join(tmpDir, "pending-approvals.json");

const { getApprovalMode, matchToolAction, matchToolDecision, requireToolApproval, setApprovalMode } = await import("../server/审批策略.mjs");

process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

const originalMode = getApprovalMode();
setApprovalMode("ask");

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

test("auto 模式只提升普通 ask，破坏性工具仍逐次确认", () => {
  setApprovalMode("auto");
  try {
    // 非破坏性的 ask（MCP）可被 auto 提升，并保留 originalAction 与 auto.* ruleId。
    const mcp = matchToolDecision("mcp", "tool_x {}");
    assert.equal(mcp.action, "allow");
    assert.equal(mcp.originalAction, "ask");
    assert.ok(mcp.ruleId.startsWith("auto."));

    // officecli 的元数据是 destructive=true（AGENTS §5：auto 不得放行破坏性操作，
    // 2026-11-07 审批边界 ADR-0025），因此不得被 auto 提升。
    const office = matchToolDecision("officecli", "set report.docx /body/p[1] --prop bold=true");
    assert.equal(office.action, "ask", "破坏性工具不得被 auto 自动放行");
    assert.equal(office.originalAction, undefined);
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
