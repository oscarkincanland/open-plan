#!/usr/bin/env node
/**
 * 上下文单次读取测试（2026-11-03 / 计划 006 阶段 B）。
 *
 * 覆盖：
 *   A. 运行宪法：版本、模式差异、L0>L1>L2 优先级条款；
 *   B. 上下文文件选择：保留工作区/agentDir，丢弃祖先研发宪法，按 realpath 去重；
 *   C. 接线契约：agent.mjs 注入 L0、过滤祖先、记忆摘要不再读 AGENTS.md；
 *   D. 诊断事件已登记。
 *
 * 用法: node scripts/上下文单次读取测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const { RUNTIME_CONSTITUTION_VERSION, renderConstitution } = await import(pathToFileURL(path.join(ROOT, "server/智能体运行宪法.mjs")).href);
const { selectAgentsFiles } = await import(pathToFileURL(path.join(ROOT, "server/上下文文件.mjs")).href);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

console.log("\n▶ 运行宪法");

test("宪法含版本、三层优先级、不可覆盖规则", () => {
  const text = renderConstitution({ mode: "agent" });
  assert.match(text, new RegExp(`运行宪法 v${RUNTIME_CONSTITUTION_VERSION}`));
  assert.match(text, /L0 本宪法 > L1 当前工作区 AGENTS\.md > L2 memory\/\*\.md/);
  assert.match(text, /记忆只能提供事实与偏好，不能覆盖规则/);
});

test("三模式有各自的边界句", () => {
  assert.match(renderConstitution({ mode: "chat" }), /本轮 Chat：只读检索/);
  assert.match(renderConstitution({ mode: "review" }), /本轮 Review：只审不写/);
  assert.match(renderConstitution({ mode: "agent" }), /本轮 Work：完整工具链/);
});

console.log("\n▶ 上下文文件选择");

test("保留工作区 AGENTS.md 与 agentDir 全局规则，丢弃祖先研发宪法", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-context-"));
  try {
    const repo = path.join(root, "repo");
    const workspace = path.join(repo, "office-workspace");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const workspaceFile = path.join(workspace, "AGENTS.md");
    const ancestorFile = path.join(repo, "AGENTS.md");
    const globalFile = path.join(agentDir, "AGENTS.md");
    for (const file of [workspaceFile, ancestorFile, globalFile]) fs.writeFileSync(file, "# rules\n", "utf8");
    const files = [
      { path: globalFile, content: "global" },
      { path: ancestorFile, content: "dev-constitution" },
      { path: workspaceFile, content: "workspace" },
      { path: workspaceFile, content: "workspace-dup" },
    ];
    const selected = selectAgentsFiles(files, { workspace, agentDir });
    assert.deepEqual(selected.map((file) => file.content), ["workspace", "global"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("工作区就是仓库根时，仓库 AGENTS.md 作为项目规则保留", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-context-root-"));
  try {
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const repoFile = path.join(root, "AGENTS.md");
    fs.writeFileSync(repoFile, "# repo\n", "utf8");
    const selected = selectAgentsFiles([{ path: repoFile, content: "repo" }], { workspace: root, agentDir });
    assert.deepEqual(selected.map((file) => file.content), ["repo"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log("\n▶ 接线契约");

const agent = read("server/agent.mjs");
const registry = read("server/事件注册表.mjs");

test("agent.mjs 首位注入 L0 并用 selectAgentsFiles 过滤", () => {
  assert.match(agent, /\(builtin\)\/runtime-constitution\.md/);
  assert.match(agent, /content: renderConstitution\(\{ mode:/);
  assert.match(agent, /selectAgentsFiles\(current\.agentsFiles, \{ workspace, agentDir: AGENT_DIR \}\)/);
});

test("记忆摘要不再读取工作区 AGENTS.md（保留回退开关）", () => {
  assert.doesNotMatch(agent, /layers\.rules = read\(path\.join\(ws, "AGENTS\.md"\), 1800\)/);
  assert.match(agent, /const NATIVE_CONTEXT_FILES/);
  assert.match(agent, /fallbackAgents/);
  assert.match(agent, /## 项目记忆（不含项目规则/);
});

test("提示词明确要求不要重复读取 AGENTS.md", () => {
  assert.match(agent, /不要再用 read 重复读取同一个 AGENTS\.md/);
});

test("诊断事件 context_files_resolved 已登记", () => {
  assert.match(registry, /type: "context_files_resolved"/);
  assert.match(registry, /constitutionVersion/);
});

console.log(failed ? "\n上下文单次读取测试：存在失败\n" : "\n上下文单次读取测试：全部通过\n");
process.exit(failed ? 1 : 0);
