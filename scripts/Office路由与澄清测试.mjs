#!/usr/bin/env node
/**
 * Office 四路由与触发词测试（O-01 / O-02 / O-05）。
 * 覆盖：14 条自然说法、12 条四路由、8 条能力计划/注入契约。
 *
 * 用法: node scripts/Office路由与澄清测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planTaskCapabilities, routeTaskIntent, taskSummary } from "../server/task.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
};

const route = (text, task = {}) => routeTaskIntent({ text, task: { mode: "agent", ...task } });
const plan = (text, task = {}, references = []) => planTaskCapabilities({ text, task: { mode: "agent", ...task }, references });

console.log("\n▶ 触发词与路由（14 例）");
test("帮我写个文档 → generate", () => assert.equal(route("帮我写个文档").route, "generate"));
test("帮我写一份汇报 → template(08)", () => {
  const r = route("帮我写一份汇报");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /08_汇报材料/);
});
test("写一个工可材料 → template(04)", () => {
  const r = route("写一个工可材料");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /04_工程可行性/);
});
test("帮我写份工程可行性研究报告 → template(04)", () => {
  const r = route("帮我写份工程可行性研究报告");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /04_工程可行性/);
});
test("按模板写一份汇报材料 → template(08)", () => {
  const r = route("按模板写一份汇报材料");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /08_汇报材料/);
});
test("起草一份交评报告 → template(07)", () => {
  const r = route("起草一份交评报告");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /07_交通影响评价/);
});
test("编制五年发展规划 → template(02)", () => {
  const r = route("编制五年发展规划");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /02_五年发展规划/);
});
test("写个方案 → generate（不误命中模板）", () => {
  const r = route("写个方案");
  assert.equal(r.route, "generate");
  assert.equal(r.template, null);
});
test("做个 PPT → template(11)", () => {
  const r = route("做个 PPT");
  assert.equal(r.route, "template");
  assert.match(r.template.file, /11_PPT汇报/);
});
test("改一下这份报告（有文件）→ edit", () => assert.equal(route("改一下这份报告", { currentFile: "报告.docx" }).route, "edit"));
test("把第三段改短一点（有文件）→ edit", () => assert.equal(route("把第三段改短一点", { currentFile: "报告.docx" }).route, "edit"));
test("看看这份文档 → read", () => assert.equal(route("看看这份文档").route, "read"));
test("这份材料有什么问题 → read", () => assert.equal(route("这份材料有什么问题").route, "read"));
test("帮我整理一下会议纪要 → generate", () => assert.equal(route("帮我整理一下会议纪要").route, "generate"));

console.log("\n▶ 四路由判定（12 例）");
test("显式 @模板 优先", () => {
  const r = route("@模板[04_工程可行性研究报告模板.md] 帮我写");
  assert.equal(r.route, "template");
  assert.equal(r.template.source, "explicit");
});
test("既有文件 + 修改 → edit", () => assert.equal(route("修改第三段", { currentFile: "a.docx" }).route, "edit"));
test("无文件 + 写 → generate", () => assert.equal(route("写一份说明文档").route, "generate"));
test("无文件 + 看 → read", () => assert.equal(route("看一下").route, "read"));
test("有文件 + 写一份新的 → generate", () => assert.equal(route("基于这份写一份新的", { currentFile: "a.docx" }).route, "generate"));
test("附件 xlsx + 改 → edit", () => {
  const r = routeTaskIntent({ text: "改一下", task: { mode: "agent" }, attachments: [{ name: "数据.xlsx" }] });
  assert.equal(r.route, "edit");
});
test("结构化模板引用 → template", () => {
  const r = routeTaskIntent({ text: "帮我写", task: { mode: "agent" }, references: [{ kind: "template", target: "08_汇报材料模板.md" }] });
  assert.equal(r.route, "template");
});
test("Chat 模式 + docx → read", () => {
  const r = routeTaskIntent({ text: "生成一份 word 报告", task: { mode: "chat" } });
  assert.equal(r.route, "read");
});
test("Review 模式 → read", () => {
  const r = routeTaskIntent({ text: "生成一份 word 报告", task: { mode: "review" } });
  assert.equal(r.route, "read");
});
test("空文本 + currentFile → read", () => assert.equal(route("", { currentFile: "a.docx" }).route, "read"));
test("officecli + 修改 + 文件 → edit", () => assert.equal(route("用 officecli 修改这份文档", { currentFile: "a.docx" }).route, "edit"));
test("多文件引用 + 修改 → edit", () => {
  const r = routeTaskIntent({ text: "修改一下", task: { mode: "agent" }, references: [{ kind: "file", target: "a.docx" }, { kind: "file", target: "b.xlsx" }] });
  assert.equal(r.route, "edit");
});

console.log("\n▶ 能力计划与注入（8 例）");
test("模板路由声明 template 能力", () => {
  const p = plan("写一个工可材料");
  assert.equal(p.routing.template, "preferred");
  assert.ok(p.capabilities.some((c) => c.id === "template"));
});
test("模板路由 officecli 为 lazy", () => assert.equal(plan("写一个工可材料").routing.officecli, "lazy"));
test("生成路由声明 office_generate", () => {
  const p = plan("帮我写个文档");
  assert.ok(p.capabilities.some((c) => c.id === "office_generate"));
});
test("编辑路由 officecli 为 preferred", () => {
  const p = plan("改一下这份报告", { currentFile: "报告.docx" });
  assert.equal(p.routing.officecli, "preferred");
  assert.ok(p.capabilities.some((c) => c.id === "officecli" && c.status === "preferred"));
});
test("只读路由不声明 officecli", () => {
  const p = plan("看看这份文档");
  assert.equal(p.routing.officecli, "not_needed");
  assert.equal(p.capabilities.some((c) => c.id === "officecli"), false);
});
test("officeFormat 默认 off", () => assert.equal(plan("写一个工可材料").routing.officeFormat, "off"));
test("routeReason 非空", () => assert.ok(plan("写一个工可材料").routeReason.length > 4));
test("澄清结果随计划下发", () => assert.equal(typeof plan("帮我写个文档").clarification.shouldAsk, "boolean"));

console.log("\n▶ 提示词单一来源与一致性（3 例）");
test("taskSummary 注入模板路由提示（O-05）", () => {
  const p = plan("写一个工可材料");
  const summary = taskSummary({ goal: "写一个工可材料", mode: "agent", capabilityPlan: p });
  assert.ok(summary.includes("写作路由：模板优先"));
});
test("只读任务不注入写作路由", () => {
  const p = plan("看看这份文档");
  const summary = taskSummary({ goal: "看看这份文档", mode: "agent", capabilityPlan: p });
  assert.equal(summary.includes("写作路由"), false);
});
test("技能计数与 OfficeCLI 约束单一来源（O-28）", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.equal(source.includes("67 个办公"), false);
  assert.ok(source.includes("localSkillCatalog().length"));
  assert.equal((source.match(/ALWAYS operate on office documents/g) || []).length, 1);
});

console.log("\n▶ Chat 模式提示（2 例）");
test("Chat 写作意图 → MODE_SWITCH_REQUIRED", () => {
  const p = planTaskCapabilities({ text: "帮我写一篇汇报材料", task: { mode: "chat" } });
  assert.equal(p.hint?.code, "MODE_SWITCH_REQUIRED");
});
test("Work 模式不返回提示", () => {
  const p = planTaskCapabilities({ text: "帮我写一篇汇报材料", task: { mode: "agent" } });
  assert.equal(p.hint, null);
});

process.exitCode = failed ? 1 : 0;
