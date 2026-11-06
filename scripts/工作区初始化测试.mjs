#!/usr/bin/env node
/**
 * 工作区初始化测试（2026-11-03 / 计划 006 阶段 C）。
 *
 * 覆盖：
 *   A. 种子内容：项目规则 + 记忆（偏好/经验）含交通规划硬约束；
 *   B. 幂等：只写缺失文件，重复调用不覆盖用户内容；
 *   C. 接线：/api/memory/init 与 /api/workspace/init 共用初始化器；
 *   D. 事件登记。
 *
 * 用法: node scripts/工作区初始化测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const { WORKSPACE_SEED_VERSION, buildWorkspaceSeed, initializeWorkspace } = await import(pathToFileURL(path.join(ROOT, "server/工作区初始化.mjs")).href);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

console.log("\n▶ 种子内容");

test("AGENTS.md 含三种模式、模板、坐标/OD/演示数据硬约束", () => {
  const { agentsMd } = buildWorkspaceSeed();
  assert.match(agentsMd, /三种模式：Chat 只读；Work 可写；Review 只审不写/);
  assert.match(agentsMd, /templates\/traffic-material/);
  assert.match(agentsMd, /经度 73–135°E、纬度 18–54°N/);
  assert.match(agentsMd, /expected vs actual/);
  assert.match(agentsMd, /演示数据/);
  assert.match(agentsMd, /不调用完成声明工具/);
  assert.match(agentsMd, /运行宪法由产品内置（L0），不要在此重复抄写/);
});

test("MEMORY.md 含项目信息、偏好与经验", () => {
  const { memoryMd } = buildWorkspaceSeed();
  assert.match(memoryMd, /## 项目信息/);
  assert.match(memoryMd, /## 用户偏好/);
  assert.match(memoryMd, /## 经验教训/);
  assert.match(memoryMd, /默认中文；结论先行/);
  assert.match(memoryMd, /Word 批注先 get\/query/);
});

console.log("\n▶ 幂等与安全");

test("首次初始化创建 AGENTS.md 与 memory/MEMORY.md", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-init-"));
  try {
    const result = initializeWorkspace(ws);
    assert.equal(result.ok, true);
    assert.equal(result.version, WORKSPACE_SEED_VERSION);
    assert.deepEqual(result.created.sort(), ["AGENTS.md", "memory/MEMORY.md"]);
    assert.ok(fs.existsSync(path.join(ws, "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(ws, "memory", "MEMORY.md")));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test("旧版通用占位升级为项目化种子，用户真实内容不覆盖", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-init-legacy-"));
  try {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# AGENTS.md\n\n## 项目说明\n\n在此添加项目指令和上下文信息。\n\n## 工作偏好\n\n在此添加工作偏好。\n", "utf8");
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# 记忆索引\n\n这是一个长期记忆文件，记录跨会话的上下文信息。\n\n## 项目信息\n\n## 工作规则\n\n## 用户偏好\n\n## 经验教训\n\n", "utf8");
    const result = initializeWorkspace(ws);
    assert.equal(result.ok, true);
    assert.deepEqual(result.upgraded.sort(), ["AGENTS.md", "memory/MEMORY.md"]);
    assert.match(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), /WGS84 中国范围/);
    assert.match(fs.readFileSync(path.join(ws, "memory", "MEMORY.md"), "utf8"), /默认中文；结论先行/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test("重复初始化不覆盖已有内容", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-init-keep-"));
  try {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# 用户自己的规则\n", "utf8");
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(path.join(ws, "memory", "MEMORY.md"), "# 用户自己的记忆\n", "utf8");
    const result = initializeWorkspace(ws);
    assert.equal(result.ok, true);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped.sort(), ["AGENTS.md", "memory/MEMORY.md"]);
    assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), "# 用户自己的规则\n");
    assert.equal(fs.readFileSync(path.join(ws, "memory", "MEMORY.md"), "utf8"), "# 用户自己的记忆\n");
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test("不存在的工作区返回可解释错误", () => {
  const result = initializeWorkspace(path.join(os.tmpdir(), "__oaw_missing_" + Date.now()), { create: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKSPACE_INVALID");
});

console.log("\n▶ 接线");

const index = read("server/index.mjs");
const registry = read("server/事件注册表.mjs");
test("两个初始化接口共用 initializeWorkspace", () => {
  assert.match(index, /import \{ initializeWorkspace \} from "\.\/工作区初始化\.mjs"/);
  assert.match(index, /app\.post\("\/api\/memory\/init", workspaceInitHandler\)/);
  assert.match(index, /app\.post\("\/api\/workspace\/init", workspaceInitHandler\)/);
  assert.match(index, /initializeWorkspace\(getWorkspace\(\), \{ create: false \}\)/);
});

test("workspace_initialized 事件已登记", () => {
  assert.match(registry, /type: "workspace_initialized"/);
  assert.match(registry, /AGENTS\.md \+ memory\/MEMORY\.md 种子/);
});

console.log(failed ? "\n工作区初始化测试：存在失败\n" : "\n工作区初始化测试：全部通过\n");
process.exit(failed ? 1 : 0);
