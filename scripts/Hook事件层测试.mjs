#!/usr/bin/env node
/**
 * Hook 事件层测试
 * 覆盖：配置加载 / 匹配 / deny 短路 / 超时 / 信任三态 / 真实 node 脚本
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dispatchHooks,
  hookDeclarationHash,
  hookMatches,
  hookTrustState,
  loadHookConfig,
  runHook,
  trustHook,
} from "../server/Hook事件层.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-hook-"));
fs.mkdirSync(path.join(workspace, ".oaw"), { recursive: true });
const allowScript = path.join(workspace, "hook-allow.mjs");
const denyScript = path.join(workspace, "hook-deny.mjs");
const slowScript = path.join(workspace, "hook-slow.mjs");
fs.writeFileSync(allowScript, 'process.stdout.write(JSON.stringify({behavior:"allow",message:"ok"}));\n');
fs.writeFileSync(denyScript, 'process.stdout.write(JSON.stringify({behavior:"deny",message:"blocked"}));\n');
fs.writeFileSync(slowScript, 'setTimeout(()=>process.stdout.write("{}"), 5000);\n');
const configFile = path.join(workspace, ".oaw", "hooks.json");
fs.writeFileSync(configFile, JSON.stringify({
  version: 1,
  hooks: [
    { id: "allow", event: "PreToolUse", script: "hook-allow.mjs", matcher: { tool: "write" } },
    { id: "deny", event: "PreToolUse", script: "hook-deny.mjs", matcher: { tool: "bash" } },
    { id: "slow", event: "Stop", script: "hook-slow.mjs", timeoutMs: 100 },
  ],
}));

test("配置加载与错误检测", () => {
  const config = loadHookConfig({ workspace, userFile: path.join(workspace, "no-user.json") });
  assert.equal(config.hooks.length, 3);
  assert.equal(config.errors.length, 0);
});

test("匹配器按工具过滤", () => {
  assert.equal(hookMatches({ matcher: { tool: "write" } }, { tool: "write" }), true);
  assert.equal(hookMatches({ matcher: { tool: "write" } }, { tool: "bash" }), false);
  assert.equal(hookMatches({ matcher: { input: "rm" } }, { inputText: "rm -rf x" }), true);
});

test("deny 短路并返回原因", async () => {
  const result = await dispatchHooks({ event: "PreToolUse", payload: { tool: "bash", inputText: "rm -rf x" }, workspace });
  assert.equal(result.behavior, "deny");
  assert.equal(result.hookId, "deny");
  assert.ok(result.reason.includes("blocked"));
});

test("allow 正常通过", async () => {
  const result = await dispatchHooks({ event: "PreToolUse", payload: { tool: "write", inputText: "a.txt" }, workspace });
  assert.equal(result.behavior, "allow");
  assert.deepEqual(result.messages, ["ok"]);
});

test("超时按 allow 处理且不挂死", async () => {
  const started = Date.now();
  const result = await runHook({ event: "Stop", script: "hook-slow.mjs" }, { event: "Stop" }, { workspace, timeoutMs: 100 });
  assert.equal(result.behavior, "allow");
  assert.ok(Date.now() - started < 2000);
  assert.ok(result.error === "hook_timeout" || result.error);
});

test("声明哈希与信任三态", () => {
  const hook = { id: "allow", event: "PreToolUse", script: "hook-allow.mjs", matcher: { tool: "write" } };
  assert.equal(hookDeclarationHash(hook), hookDeclarationHash({ ...hook }));
  assert.notEqual(hookDeclarationHash(hook), hookDeclarationHash({ ...hook, script: "hook-deny.mjs" }));
  assert.equal(hookTrustState(hook, workspace).state, "pending");
  const trusted = trustHook(hook, workspace);
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.state, "trusted");
  const changed = hookTrustState({ ...hook, script: "hook-deny.mjs" }, workspace);
  assert.equal(changed.trusted, false);
});

setTimeout(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}, 500);
