#!/usr/bin/env node
/**
 * 写作性能与上下文测试（D5，2026-11-08）
 *
 * 覆盖计划 2026-11-08-001 D5：
 *   - 写作路由技能目录裁剪（只注入写作/文档/排版/图表类，预算 4KB，不足 3 个命中回退全量）；
 *   - 写作路由回合预算（软 30/硬 60）与周期播报关闭的开关仍在；
 *   - 写作 thinking=medium 默认（D4）与工具输出上限存在；
 *   - 静态接线守护（agent/运行开关）。
 *
 * 用法：node scripts/写作性能与上下文测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { selectWritingSkills, WRITING_SKILL_RE, DEFAULT_WRITING_SKILL_LIMIT } = await import("../server/写作技能筛选.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const SKILLS = [
  { name: "humanizer", description: "中文写作润色，去除 AI 腔" },
  { name: "docx", description: "Word 文档创建与编辑" },
  { name: "pptx", description: "PowerPoint 演示文稿" },
  { name: "baoyu-echarts", description: "ECharts 图表生成" },
  { name: "frontend-design", description: "前端界面设计" },
  { name: "cad-parser", description: "CAD 图纸解析" },
  { name: "map-gis", description: "地图空间分析" },
  { name: "whisper", description: "音频转写" },
];

test("写作路由只保留写作/文档/排版/图表类技能", () => {
  const result = selectWritingSkills(SKILLS);
  assert.equal(result.filtered, true);
  const names = result.skills.map((item) => item.name);
  assert.ok(names.includes("humanizer"));
  assert.ok(names.includes("docx"));
  assert.ok(names.includes("pptx"));
  assert.ok(!names.includes("cad-parser"));
  assert.ok(!names.includes("map-gis"));
});

test("命中不足 3 个时回退全量（避免误裁）", () => {
  const sparse = [{ name: "cad-parser", description: "CAD" }, { name: "map-gis", description: "地图" }];
  const result = selectWritingSkills(sparse);
  assert.equal(result.filtered, false);
  assert.equal(result.skills.length, sparse.length);
});

test("裁剪结果受 limit 上限约束且保持原顺序", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ name: `doc-${index}`, description: "文档写作" }));
  const result = selectWritingSkills(many, { limit: 5 });
  assert.equal(result.filtered, true);
  assert.equal(result.skills.length, 5);
  assert.deepEqual(result.skills.map((item) => item.name), ["doc-0", "doc-1", "doc-2", "doc-3", "doc-4"]);
  assert.equal(DEFAULT_WRITING_SKILL_LIMIT, 12);
  assert.ok(WRITING_SKILL_RE.test("PPT 演示"));
});

test("agent.mjs：写作路由使用精简目录 + 4KB 预算 + 事件标记", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /selectWritingSkills\(/);
  assert.match(agent, /RUNTIME_FLAGS\.writingLeanContext/);
  assert.match(agent, /budgetBytes: 4 \* 1024/);
  assert.match(agent, /catalog-writing-lean/);
});

test("运行开关：writingLeanContext / writingBudget / writingOneShot 均存在且默认关", () => {
  const flags = read("server/运行开关.mjs");
  assert.match(flags, /writingLeanContext: readFlag\("OAW_WRITING_LEAN_CONTEXT"\)/);
  assert.match(flags, /writingOneShot: readFlag\("OAW_WRITING_ONESHOT"\)/);
  assert.match(flags, /writingBudget: readFlag\("OAW_WRITING_BUDGET"\)/);
});

test("写作路由预算/播报/思考档位仍按 D0/D4 接好", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /soft: 30, hard: 60, interval: 0/);
  assert.match(agent, /interval: writingBudget \? 0 : TURN_PROGRESS_INTERVAL/);
  const task = read("server/task.mjs");
  assert.match(task, /resolveWritingThinkingLevel/);
  const pipeline = read("server/编辑流水线.mjs");
  assert.match(pipeline, /writingOneShot/);
});

test("工具输出仍有上限（避免单次大输出吃满上下文）", () => {
  const agent = read("server/agent.mjs");
  assert.match(agent, /const TOOL_OUTPUT_MAX_CHARS = 16000/);
});

console.log(failed ? "\n写作性能与上下文测试：存在失败" : "\n写作性能与上下文测试：全部通过");
process.exit(failed ? 1 : 0);
