#!/usr/bin/env node
/**
 * Harness 接口冒烟测试
 * 覆盖：新诊断路由可访问 / 返回结构稳定 / 服务可启动
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += String(chunk); });
server.stderr.on("data", (chunk) => { output += String(chunk); });

async function waitForServer() {
  for (let i = 0; i < 400; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务未在预期时间内启动：${output.slice(-1000)}`);
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

try {
  await waitForServer();

  await test("GET /api/status 可访问且下发 harness 开关", async () => {
    const res = await fetch(`${BASE}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.runtimeFlags?.toolMetadata, "boolean");
    assert.equal(typeof data.runtimeFlags?.memoryRecall, "boolean");
  });

  await test("GET /api/harness/tools 返回元数据与覆盖报告", async () => {
    const res = await fetch(`${BASE}/api/harness/tools`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.tools));
    assert.ok(data.tools.some((tool) => tool.name === "write" && tool.needsApproval === true));
    assert.equal(typeof data.coverage.total, "number");
  });

  await test("GET /api/harness/usage 返回聚合结构", async () => {
    const res = await fetch(`${BASE}/api/harness/usage?runId=none`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.summary);
    assert.equal(data.count, 0);
  });

  await test("GET /api/harness/observability 返回报表", async () => {
    const res = await fetch(`${BASE}/api/harness/observability?runId=none`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.report);
    assert.equal(data.report.usage.recordCount, 0);
  });

  await test("GET /api/harness/plans 返回数组", async () => {
    const res = await fetch(`${BASE}/api/harness/plans`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.plans));
  });

  await test("POST /api/harness/plans 写入计划", async () => {
    const res = await fetch(`${BASE}/api/harness/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "接口冒烟计划", content: "- [ ] 验证", runId: "smoke" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(fs.existsSync(data.path));
    const list = await (await fetch(`${BASE}/api/harness/plans`)).json();
    assert.ok(list.plans.some((plan) => plan.name === path.basename(data.path)));
    fs.rmSync(data.path, { force: true });
  });

  await test("GET /api/harness/hooks 返回四事件与配置", async () => {
    const res = await fetch(`${BASE}/api/harness/hooks`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.events, ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
    assert.ok(Array.isArray(data.hooks));
  });
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { server.kill("SIGKILL"); } catch {}
}

process.exitCode = failed ? 1 : 0;
