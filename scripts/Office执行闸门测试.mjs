#!/usr/bin/env node
/**
 * Office 执行闸门测试（计划 008 / P0-1、P0-2）。
 * 覆盖：写作路由拦截、只读放行、澄清前置、逃逸阀、非写作路由放行。
 *
 * 用法: node scripts/Office执行闸门测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToolCall, isDocxGenerationCommand, isReadonlyBash } from "../server/office规范/执行闸门.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AGENT_SOURCE = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const ctx = (over = {}) => ({
  route: "template",
  officeFormat: true,
  pipelineProduced: false,
  clarificationPending: null,
  mode: "agent",
  ...over,
});
const call = (tool, input = {}, over = {}) => classifyToolCall({ tool, input, context: ctx(over) });

console.log("\n▶ 开关与路由放行（5 例）");
test("开关关闭 → 全部放行", () => {
  assert.equal(call("bash", { command: "node build/build.mjs" }, { officeFormat: false }).blocked, false);
});
test("只读路由 → 放行", () => assert.equal(call("bash", { command: "node build/build.mjs" }, { route: "read" }).blocked, false));
test("编辑路由 → officecli 写放行", () => assert.equal(call("officecli", { args: "set a.docx /body/p[1] --prop bold=true" }, { route: "edit" }).blocked, false));
test("Chat 模式 → 放行", () => assert.equal(call("bash", { command: "node build/build.mjs" }, { mode: "chat" }).blocked, false));
test("Review 模式 → 放行", () => assert.equal(call("bash", { command: "node build/build.mjs" }, { mode: "review" }).blocked, false));

console.log("\n▶ bash 生成拦截（8 例）");
test("node 生成脚本 → 拦截", () => {
  const r = call("bash", { command: "node build/build.mjs" });
  assert.equal(r.blocked, true);
  assert.equal(r.code, "OFFICE_PIPELINE_REQUIRED");
});
test("python-docx → 拦截", () => assert.equal(call("bash", { command: "python build.py # docx" }).blocked, true));
test("pandoc 转 docx → 拦截", () => assert.equal(call("bash", { command: "pandoc a.md -o a.docx" }).blocked, true));
test("重定向写 docx → 拦截", () => assert.equal(call("bash", { command: "echo x > 报告.docx" }).blocked, true));
test("officecli via bash → 拦截", () => assert.equal(call("bash", { command: "officecli create a.docx --type docx" }).blocked, true));
test("unzip -p 只读 → 放行", () => assert.equal(call("bash", { command: "unzip -p a.docx word/document.xml" }).blocked, false));
test("grep 只读 → 放行", () => assert.equal(call("bash", { command: "grep -n 标题 a.docx" }).blocked, false));
test("node -e 只读检查 → 放行", () => {
  assert.equal(call("bash", { command: "node -e \"const fs=require('fs');console.log(fs.readFileSync('a.docx'))\"" }).blocked, false);
});

console.log("\n▶ officecli 拦截（7 例）");
test("view → 放行", () => assert.equal(call("officecli", { args: "view a.docx text" }).blocked, false));
test("get → 放行", () => assert.equal(call("officecli", { args: "get a.docx /body --depth 2 --json" }).blocked, false));
test("create 在管线前 → 拦截", () => assert.equal(call("officecli", { args: "create a.docx --type docx" }).blocked, true));
test("set 在管线前 → 拦截", () => assert.equal(call("officecli", { args: "set a.docx /body/p[1] --prop bold=true" }).blocked, true));
test("add markdown → 始终拦截", () => assert.equal(call("officecli", { args: "add a.docx / --type markdown --prop src=a.md" }, { pipelineProduced: true }).blocked, true));
test("管线产出后 set → 放行", () => assert.equal(call("officecli", { args: "set a.docx /body/p[1] --prop bold=true" }, { pipelineProduced: true }).blocked, false));
test("save/close 放行", () => {
  assert.equal(call("officecli", { args: "save a.docx" }).blocked, false);
  assert.equal(call("officecli", { args: "close a.docx" }).blocked, false);
});

console.log("\n▶ write/edit 与澄清前置（7 例）");
test("write .docx → 拦截", () => assert.equal(call("write", { path: "/ws/a.docx" }).blocked, true));
test("write .md → 放行", () => assert.equal(call("write", { path: "/ws/a.md" }).blocked, false));
test("澄清待回答 + write → 拦截", () => {
  const r = call("write", { path: "/ws/a.md" }, { clarificationPending: { question: { text: "篇幅？", options: ["1-3 页"] } } });
  assert.equal(r.blocked, true);
  assert.equal(r.code, "CLARIFICATION_REQUIRED");
});
test("澄清待回答 + ask_user → 放行", () => assert.equal(call("ask_user", { question: "篇幅？" }, { clarificationPending: { question: { text: "篇幅？" } } }).blocked, false));
test("澄清待回答 + bash 只读 → 放行", () => assert.equal(call("bash", { command: "ls -la" }, { clarificationPending: { question: { text: "篇幅？" } } }).blocked, false));
test("澄清待回答 + pipeline → 拦截", () => assert.equal(call("editorial_pipeline", {}, { clarificationPending: { question: { text: "篇幅？" } } }).blocked, true));
test("澄清待回答 + officecli view → 放行", () => assert.equal(call("officecli", { args: "view a.docx text" }, { clarificationPending: { question: { text: "篇幅？" } } }).blocked, false));

console.log("\n▶ 脚本绕过拦截（6 例）");
test("node .cjs 生成脚本 → 拦截", () => assert.equal(call("bash", { command: "node build_ppt_demo.cjs" }).blocked, true));
test("python .py 生成脚本 → 拦截", () => assert.equal(call("bash", { command: "python build_ppt.py" }).blocked, true));
test("node -e pptxgenjs → 拦截", () => assert.equal(call("bash", { command: "node -e \"const P=require('pptxgenjs')\"" }).blocked, true));
test("python -c import pptx → 拦截", () => assert.equal(call("bash", { command: "python -c \"import pptx\"" }).blocked, true));
test("write .cjs → 拦截", () => assert.equal(call("write", { path: "/ws/build.cjs" }).blocked, true));
test("用户明确要脚本（manualAllowed）→ 放行", () => assert.equal(call("bash", { command: "node build.cjs" }, { manualAllowed: true }).blocked, false));

console.log("\n▶ 逃逸阀与判定函数（4 例）");
test("bash --allow-manual → 放行并剥离标记", () => {
  const r = call("bash", { command: "node build/build.mjs --allow-manual" });
  assert.equal(r.blocked, false);
  assert.equal(r.sanitizedInput.command.includes("--allow-manual"), false);
});
test("officecli --allow-manual → 放行并剥离", () => {
  const r = call("officecli", { args: "create a.docx --type docx --allow-manual" });
  assert.equal(r.blocked, false);
  assert.equal(r.sanitizedInput.args.includes("--allow-manual"), false);
});
test("isDocxGenerationCommand 识别生成、放过只读", () => {
  assert.equal(isDocxGenerationCommand("node build/build.mjs"), true);
  assert.equal(isDocxGenerationCommand("unzip -p a.docx word/document.xml"), false);
});
test("isReadonlyBash 识别只读", () => {
  assert.equal(isReadonlyBash("ls -la"), true);
  assert.equal(isReadonlyBash("node build/build.mjs"), false);
});

console.log("\n▶ agent 接线（3 例）");
test("bash/officecli/write/edit 均调用执行闸门", () => {
  for (const tool of ["bash", "officecli", "write", "edit"]) {
    assert.ok(AGENT_SOURCE.includes(`enforceOfficeGate("${tool}"`), `${tool} 未接入执行闸门`);
  }
});
test("Run 级状态重置与 pipeline 置位", () => {
  assert.ok(AGENT_SOURCE.includes("entry.pipelineProduced = false"));
  assert.ok(AGENT_SOURCE.includes("entry.pipelineProduced = true"));
  assert.ok(AGENT_SOURCE.includes("entry.clarificationPending"));
});
test("ask_user 解除澄清闸门", () => {
  assert.ok(AGENT_SOURCE.includes("entry.clarificationPending = null"));
});

process.exitCode = failed ? 1 : 0;
