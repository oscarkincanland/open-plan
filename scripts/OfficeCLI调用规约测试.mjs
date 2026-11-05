#!/usr/bin/env node
/**
 * Office CLI 调用规约测试（计划 2026-11-05-017）。
 * 用法: node scripts/OfficeCLI调用规约测试.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { officeCliPolicy, isMutatingOfficecli } = await import(pathToFileURL(path.join(ROOT, "server/office规范/OfficeCLI调用规约.mjs")).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};
const policy = (over = {}) => officeCliPolicy({ mode: "agent", route: "read", command: "set", args: "set a.docx", ...over });

console.log("\n▶ 模式");
test("Chat 不可见且拒绝", () => {
  const r = policy({ mode: "chat", route: "read", command: "view", args: "view a.docx text" });
  assert.equal(r.visible, false);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "OFFICE_TOOL_UNAVAILABLE");
});
test("Review 放行（原文保护在别处）", () => {
  const r = policy({ mode: "review", route: "read", command: "set", args: "set a.docx /body/p[1] --prop bold=true" });
  assert.equal(r.allowed, true);
});

console.log("\n▶ 路由");
test("read + set → 拒绝", () => {
  const r = policy({ route: "read", command: "set", args: "set a.docx" });
  assert.equal(r.allowed, false);
  assert.equal(r.code, "OFFICE_READONLY_ONLY");
});
test("read + view → 放行", () => {
  const r = policy({ route: "read", command: "view", args: "view a.docx text" });
  assert.equal(r.allowed, true);
});
test("edit + set → 放行，阻塞预检", () => {
  const r = policy({ route: "edit", command: "set", args: "set a.docx" });
  assert.equal(r.allowed, true);
  assert.equal(r.preflight, "blocking");
});
test("template + set + 未产出 → 拒绝", () => {
  const r = policy({ route: "template", command: "set", args: "set a.docx", pipelineProduced: false });
  assert.equal(r.allowed, false);
  assert.equal(r.code, "OFFICE_PIPELINE_REQUIRED");
});
test("template + set + 已产出 → 放行", () => {
  const r = policy({ route: "template", command: "set", args: "set a.docx", pipelineProduced: true });
  assert.equal(r.allowed, true);
  assert.equal(r.preflight, "lazy");
});
test("template + 澄清待回答 + set → 澄清优先", () => {
  const r = policy({
    route: "template",
    command: "set",
    args: "set a.docx",
    clarificationPending: { question: { text: "篇幅？", options: ["1-3 页"] } },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.code, "CLARIFICATION_REQUIRED");
});
test("template + add --type markdown → 始终拒绝", () => {
  const r = policy({ route: "template", command: "add", args: "add a.docx / --type markdown --prop src=a.md", pipelineProduced: true });
  assert.equal(r.allowed, false);
  assert.equal(r.code, "OFFICE_PIPELINE_REQUIRED");
});

console.log("\n▶ 命令分级");
test("save/close 按写处理", () => {
  assert.equal(isMutatingOfficecli("save a.docx"), true);
  assert.equal(isMutatingOfficecli("close a.docx"), true);
});
test("未知命令按写处理", () => {
  assert.equal(isMutatingOfficecli("merge a.docx b.docx"), true);
});
test("只读命令", () => {
  for (const cmd of ["view", "get", "query", "validate", "dump", "help", "watch", "unwatch"]) {
    assert.equal(isMutatingOfficecli(`${cmd} a.docx`), false, cmd);
  }
});

console.log(failed ? "\nOffice CLI 调用规约测试：存在失败\n" : "\nOffice CLI 调用规约测试：全部通过\n");
process.exit(failed ? 1 : 0);
