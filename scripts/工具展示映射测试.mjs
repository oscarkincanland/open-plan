#!/usr/bin/env node
/**
 * 工具展示映射单一来源测试（2026-11-06）
 *
 * 背景：工具卡的「动词 + 图标」此前由前端两处各维护（ChatPanel.toolPhrase /
 * 事件展示.toolIdentity），与服务端 工具元数据.mjs 的能力事实不同源，新增工具会
 * 退化成「调用 xxx」或通用图标。现在事实源在服务端 metadata.presentation，
 * 前端经 /api/harness/tools → client/src/工具展示.js 缓存后取用。
 *
 * 用法：node scripts/工具展示映射测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { TOOL_NAMES, getToolMetadata, listToolMetadata } = await import("../server/工具元数据.mjs");
const { applyToolMetadata, toolPresentationOf, toolPresentationNames } = await import("../client/src/工具展示.js");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

console.log("▶ 服务端：presentation 覆盖");

test("每个已登记工具都有 presentation.icon", () => {
  const missing = TOOL_NAMES.filter((name) => !getToolMetadata(name)?.presentation?.icon);
  assert.deepEqual(missing, [], `缺少图标：${missing.join(", ")}`);
});

test("核心工具都有可读动词", () => {
  for (const name of ["read", "write", "edit", "bash", "officecli", "grep", "kb_search", "run_subagent", "todo"]) {
    const verb = getToolMetadata(name)?.presentation?.verb;
    assert.ok(verb && verb.length >= 2, `${name} 应有中文动词，实际 ${verb}`);
  }
});

test("未知工具回落通用图标且不编造动词", () => {
  const presentation = getToolMetadata("__not_a_tool__")?.presentation;
  assert.equal(presentation, undefined, "未登记工具不应有元数据");
});

test("map_/browser_/job_ 前缀有归类动词", () => {
  const sample = listToolMetadata().filter((item) => /^(map_|browser_|job_)/.test(item.name));
  assert.ok(sample.length > 0, "应有前缀工具可检查");
  for (const item of sample) {
    assert.ok(item.presentation?.verb, `${item.name} 应有归类动词`);
    assert.ok(item.presentation?.icon, `${item.name} 应有图标`);
  }
});

console.log("▶ 客户端：缓存与查询");

test("applyToolMetadata 接收服务端列表并可查询", () => {
  const count = applyToolMetadata(listToolMetadata());
  assert.equal(count, TOOL_NAMES.length);
  assert.equal(toolPresentationOf("bash").verb, "执行命令");
  assert.equal(toolPresentationOf("bash").icon, "terminal");
  assert.equal(toolPresentationOf("map_edit").icon, "map");
});

test("未下发时返回 null（调用方回落内置映射）", () => {
  assert.equal(toolPresentationOf("__not_a_tool__"), null);
  assert.equal(toolPresentationOf(""), null);
});

test("脏数据不入缓存", () => {
  applyToolMetadata([{ name: "" }, { name: "x" }, { name: "y", presentation: {} }, null]);
  assert.deepEqual(toolPresentationNames(), []);
});

console.log("▶ 前端接入");

test("ChatPanel 先读服务端展示、再回落内置 switch", () => {
  const source = fs.readFileSync(path.join(ROOT, "client/src/components/ChatPanel.jsx"), "utf8");
  const serverRead = source.indexOf("toolPresentationOf(name)");
  const fallbackSwitch = source.indexOf("switch (name) {", serverRead);
  assert.ok(serverRead > 0, "toolPhrase 应读取服务端 presentation");
  assert.ok(fallbackSwitch > serverRead, "服务端未下发时应回落到内置 switch");
});

test("事件展示.toolIdentity 先读服务端图标", () => {
  const source = fs.readFileSync(path.join(ROOT, "client/src/事件展示.js"), "utf8");
  assert.match(source, /toolPresentationOf\(value\)/, "toolIdentity 应优先用服务端图标");
});

test("App 挂载时拉取 /api/harness/tools 并写入缓存", () => {
  const source = fs.readFileSync(path.join(ROOT, "client/src/App.jsx"), "utf8");
  assert.match(source, /fetch\("\/api\/harness\/tools"\)/);
  assert.match(source, /applyToolMetadata\(data\.tools\)/);
});

if (failed) {
  console.error("\n✗ 工具展示映射存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 工具展示映射全部通过\n");
