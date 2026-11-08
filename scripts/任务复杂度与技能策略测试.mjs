#!/usr/bin/env node
/**
 * 任务复杂度与技能策略测试（2026-11-03 / 计划 006 阶段 D）。
 *
 * 覆盖：
 *   A. 简单/复杂判定与路由：auto/always/off、显式 @技能、草稿钩子；
 *   B. 默认技能清单按项目校准；
 *   C. 提示词：简单任务不搜索、复杂任务才搜索；
 *   D. 技能草稿：只在复杂任务+开关开启时可用，写工作区不写技能库，安装需确认；
 *   E. 引用标记 @技能/#技能 归一。
 *
 * 用法: node scripts/任务复杂度与技能策略测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const { estimateTaskComplexity, resolveSkillsRouting, resolveSkillDraftRouting } = await import(pathToFileURL(path.join(ROOT, "server/任务复杂度.mjs")).href);
const { planTaskCapabilities, routeTaskIntent, stripAutoContextPrefix } = await import(pathToFileURL(path.join(ROOT, "server/task.mjs")).href);
const { buildSkillCatalog } = await import(pathToFileURL(path.join(ROOT, "server/Skill注入.mjs")).href);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

console.log("\n▶ 复杂度与路由");

test("短问答/单文件读取是 simple", () => {
  assert.equal(estimateTaskComplexity({ text: "这个文件讲了什么？" }).level, "simple");
  assert.equal(estimateTaskComplexity({ text: "读一下清单", task: { mode: "chat" } }).level, "simple");
});

test("单篇文档生成仍是 simple（只命中产出物 +2）", () => {
  const result = estimateTaskComplexity({ text: "写一份会议纪要 docx" });
  assert.equal(result.level, "simple");
  assert.equal(result.score, 2);
});

test("多材料/批量/工作流/审查升级为 complex", () => {
  const result = estimateTaskComplexity({
    text: "把这三份材料汇总成完整规划报告，并配图表",
    task: { workflowId: "wf-plan-doc", mode: "review" },
    attachments: [{ name: "a" }, { name: "b" }],
  });
  assert.equal(result.level, "complex");
  assert.ok(result.score >= 3);
  assert.ok(result.reasons.length >= 2);
});

test("on（默认，旧 auto/always 迁移为 on）：简单/复杂都注入 catalog；显式技能 preflight", () => {
  const simple = estimateTaskComplexity({ text: "读一下文件" });
  const complex = estimateTaskComplexity({ text: "汇总三份材料成完整报告" });
  assert.equal(resolveSkillsRouting({ complexity: simple, task: {} }), "catalog");
  assert.equal(resolveSkillsRouting({ complexity: complex, task: {} }), "catalog");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "on" } } }), "catalog");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "auto" } } }), "catalog");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "always" } } }), "catalog");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { workflowId: "wf" } }), "preflight");
  assert.equal(resolveSkillsRouting({ complexity: simple, text: "@技能[docx]" }), "preflight");
});

test("off 关闭目录注入；显式技能仍 preflight", () => {
  const simple = estimateTaskComplexity({ text: "读一下文件" });
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "off" } } }), "off");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "off" } }, text: "#技能[docx]" }), "preflight");
});

test("草稿默认允许；complex 仅复杂任务；off 关闭", () => {
  const simple = estimateTaskComplexity({ text: "读一下文件" });
  const complex = estimateTaskComplexity({ text: "汇总三份材料成完整报告" });
  assert.equal(resolveSkillDraftRouting({ complexity: simple, task: {} }), "enabled");
  assert.equal(resolveSkillDraftRouting({ complexity: simple, task: { projectSettings: { allowSkillDrafts: "complex" } } }), "off");
  assert.equal(resolveSkillDraftRouting({ complexity: complex, task: { projectSettings: { allowSkillDrafts: "complex" } } }), "enabled");
  assert.equal(resolveSkillDraftRouting({ complexity: complex, task: { projectSettings: { allowSkillDrafts: "off" } } }), "off");
});

console.log("\n▶ 默认清单与提示词");

test("每轮技能目录按 workspace/project 优先 + 预算截断", () => {
  const built = buildSkillCatalog({
    skills: [
      { name: "user-tool", description: "用户技能", sourceScope: "user" },
      { name: "proj-tool", description: "项目技能", sourceScope: "project" },
      { name: "ws-tool", description: "工作区技能", sourceScope: "workspace" },
    ],
    usage: { "user-tool": 9 },
    budgetBytes: 1024,
  });
  assert.ok(built.text.indexOf("ws-tool") < built.text.indexOf("proj-tool"), "workspace 应排在 project 前");
  assert.ok(built.text.indexOf("proj-tool") < built.text.indexOf("user-tool"), "project 应排在 user 前");
  assert.match(built.text, /skills_read\(name\)/);
});

const agent = read("server/agent.mjs");
const task = read("server/task.mjs");
test("提示词固定为每轮目录 + 模型判断，不再区分简单/复杂", () => {
  assert.match(agent, /每轮动态上下文会给出当前可用技能目录/);
  assert.match(agent, /buildSkillCatalog\(/);
  assert.doesNotMatch(agent, /技能策略（简单任务）.*不要调用 `skills_search`/);
  assert.doesNotMatch(agent, /技能发现（复杂任务）.*先调用一次 `skills_search`/);
});

test("task.mjs 输出 complexity 与 routing.skills/skillDrafts", () => {
  assert.match(task, /const complexity = estimateTaskComplexity/);
  assert.match(task, /skills: skillsRouting/);
  assert.match(task, /skillDrafts: skillDraftsRouting/);
  assert.match(task, /complexity,/);
});

console.log("\n▶ 草稿确认链路");

test("skill_draft 工具只写工作区草稿，未开启时拒绝", () => {
  assert.match(agent, /name: "skill_draft"/);
  assert.match(agent, /routing\?\.skillDrafts === "enabled"/);
  assert.match(agent, /\.oaw", "skill-drafts"/);
  assert.match(agent, /草稿不会进入技能库/);
  assert.doesNotMatch(agent, /skill_draft[\s\S]{0,1200}AGENT_DIR, "skills"/, "草稿工具不得直接写技能库");
});

test("安装接口需要显式确认，同名默认拒绝", () => {
  const index = read("server/index.mjs");
  assert.match(index, /app\.post\("\/api\/skills\/drafts\/:slug\/install"/);
  assert.match(index, /code: "SKILL_EXISTS"/);
  assert.match(index, /req\.body\?\.overwrite !== true/);
  assert.match(index, /type: "skill_installed"/);
});

test("SkillsManager 有草稿区与安装/丢弃；设置里有技能策略与草稿开关", () => {
  const skills = read("client/src/components/SkillsManager.jsx");
  const settings = read("client/src/components/SettingsPanel.jsx");
  assert.match(skills, /技能草稿（\{drafts\.length\}，待确认）/);
  assert.match(skills, /安装到技能库/);
  assert.match(skills, /handleInstallDraft/);
  assert.match(settings, /skillsPolicy/);
  assert.match(settings, /allowSkillDrafts/);
  assert.match(settings, /技能草稿只写工作区/);
});

test("D1：技能策略 UI 只有开/关，依赖状态与安装入口可见", () => {
  const skills = read("client/src/components/SkillsManager.jsx");
  const settings = read("client/src/components/SettingsPanel.jsx");
  assert.match(settings, /<option value="on">开启（每轮注入目录，由模型自行判断是否使用）<\/option>/);
  assert.match(settings, /<option value="off">关闭（不注入技能目录，显式点名仍预检）<\/option>/);
  assert.doesNotMatch(settings, /value="auto"/);
  assert.match(skills, /安装依赖/);
  assert.match(skills, /\/api\/skills\/\$\{encodeURIComponent\(skill\.name\)\}\/deps\/install/);
  assert.match(skills, /\.oaw\/skill-deps/);
});

test("@技能 与 #技能 两个解析器都归一", () => {
  const context = read("server/context.mjs");
  const index = read("server/index.mjs");
  assert.match(context, /\[@#\]技能/);
  assert.match(index, /\[@#\]技能/);
});

console.log("\n▶ 意图文本与 Office 路由");

const DOCX = "松阳/2浙西南公铁智慧多式联运枢纽港（物流基地）项目可行性研究（修改稿）.docx";

test("stripAutoContextPrefix 去掉当前文件/地图/附件/注入上下文，保留用户正文", () => {
  const raw = [
    "[当前打开文件: " + DOCX + "]",
    "[当前地图项目: zhejiang]",
    "[已上传附件: a.docx]",
    "## 当前检索上下文",
    "旧检索内容",
    "## 本轮任务",
    "读取一下这个文本做如下修改：1.1.名称改成新名称",
  ].join("\n");
  const text = stripAutoContextPrefix(raw);
  assert.equal(text.includes("当前打开文件"), false);
  assert.equal(text.includes("当前检索上下文"), false);
  assert.equal(text.includes("旧检索内容"), false);
  assert.match(text, /读取一下这个文本做如下修改/);
});

test("文件名含“可行性研究”不再把编辑意图判成 template", () => {
  const text = `[当前打开文件: ${DOCX}]\n读取一下这个文本做如下修改：1.1.名称改成新名称`;
  const plan = planTaskCapabilities({
    text: stripAutoContextPrefix(text),
    task: { mode: "agent", currentFile: DOCX },
  });
  assert.equal(plan.route, "edit");
  assert.equal(plan.clarification.shouldAsk, false);
});

test("既有 Office 文件 + 编辑意图优先于模板关键词", () => {
  const intent = routeTaskIntent({
    text: "按可行性研究报告模板修改这份报告",
    task: { mode: "agent", currentFile: DOCX },
  });
  assert.equal(intent.route, "edit");
});

test("没有既有文件时模板关键词仍走 template", () => {
  const intent = routeTaskIntent({
    text: "按可行性研究报告模板写一份新的可研报告",
    task: { mode: "agent", currentFile: null },
  });
  assert.equal(intent.route, "template");
});

test("短句“继续修改”沿用上一轮 edit 路由", () => {
  const intent = routeTaskIntent({
    text: "继续修改",
    task: { mode: "agent", currentFile: DOCX },
    previousRoute: "edit",
  });
  assert.equal(intent.route, "edit");
});

test("短句“继续”在上一轮 edit 时仍走 edit", () => {
  const intent = routeTaskIntent({
    text: "继续",
    task: { mode: "agent", currentFile: DOCX },
    previousRoute: "edit",
  });
  assert.equal(intent.route, "edit");
});

test("没有上一轮路由时“继续”不擅自写文件", () => {
  const intent = routeTaskIntent({
    text: "继续",
    task: { mode: "agent", currentFile: DOCX },
  });
  assert.equal(intent.route, "read");
});

console.log(failed ? "\n任务复杂度与技能策略测试：存在失败\n" : "\n任务复杂度与技能策略测试：全部通过\n");
process.exit(failed ? 1 : 0);
