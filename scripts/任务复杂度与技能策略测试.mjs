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
const { DEFAULT_SKILL_PRIORITIES } = await import(pathToFileURL(path.join(ROOT, "server/Skill注入.mjs")).href);

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

test("auto：简单 default，复杂 discover；显式技能 preflight", () => {
  const simple = estimateTaskComplexity({ text: "读一下文件" });
  const complex = estimateTaskComplexity({ text: "汇总三份材料成完整报告" });
  assert.equal(resolveSkillsRouting({ complexity: simple, task: {} }), "default");
  assert.equal(resolveSkillsRouting({ complexity: complex, task: {} }), "discover");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { workflowId: "wf" } }), "preflight");
  assert.equal(resolveSkillsRouting({ complexity: simple, text: "@技能[docx]" }), "preflight");
});

test("off 关闭自动检索，always 总是检索", () => {
  const simple = estimateTaskComplexity({ text: "读一下文件" });
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "off" } } }), "off");
  assert.equal(resolveSkillsRouting({ complexity: simple, task: { projectSettings: { skillsPolicy: "always" } } }), "discover");
});

test("草稿钩子只在复杂任务且 allowSkillDrafts=complex 时开启", () => {
  const simple = estimateTaskComplexity({ text: "读一下文件" });
  const complex = estimateTaskComplexity({ text: "汇总三份材料成完整报告" });
  assert.equal(resolveSkillDraftRouting({ complexity: simple, task: { projectSettings: { allowSkillDrafts: "complex" } } }), "off");
  assert.equal(resolveSkillDraftRouting({ complexity: complex, task: { projectSettings: { allowSkillDrafts: "complex" } } }), "enabled");
  assert.equal(resolveSkillDraftRouting({ complexity: complex, task: { projectSettings: { allowSkillDrafts: "off" } } }), "off");
});

console.log("\n▶ 默认清单与提示词");

test("默认 8 个技能按项目校准，不再含 lark-*", () => {
  assert.deepEqual(DEFAULT_SKILL_PRIORITIES, ["docx", "pptx", "xlsx", "pdf", "officecli", "baoyu-echarts", "frontend-design", "ultimate-ppt-master-skill"]);
  assert.equal(DEFAULT_SKILL_PRIORITIES.length, 8);
  assert.ok(!DEFAULT_SKILL_PRIORITIES.some((name) => name.startsWith("lark-")));
});

const agent = read("server/agent.mjs");
const task = read("server/task.mjs");
test("提示词区分简单/复杂；简单任务禁止 skills_search", () => {
  assert.match(agent, /技能策略（简单任务）.*不要调用 `skills_search`/);
  assert.match(agent, /技能发现（复杂任务）.*先调用一次 `skills_search`/);
  assert.match(agent, /每轮最多 2 次/);
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

test("@技能 与 #技能 两个解析器都归一", () => {
  const context = read("server/context.mjs");
  const index = read("server/index.mjs");
  assert.match(context, /\[@#\]技能/);
  assert.match(index, /\[@#\]技能/);
});

console.log(failed ? "\n任务复杂度与技能策略测试：存在失败\n" : "\n任务复杂度与技能策略测试：全部通过\n");
process.exit(failed ? 1 : 0);
