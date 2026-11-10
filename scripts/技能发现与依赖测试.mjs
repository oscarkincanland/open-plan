#!/usr/bin/env node
/**
 * 技能发现与依赖（D0）回归测试
 *
 * 覆盖 2026-11-08 D0 的四类硬缺陷（计划 2026-11-08-001）：
 *   1) frontmatter 块标量解析（`description: >` / `|`）——旧实现只得到 `>`；
 *   2) 技能目录预算——旧实现整条丢弃 11/66 个技能；
 *   3) 自然语言检索——旧实现空格 AND 词面匹配，中文查询 0 命中；
 *   4) skills_read 全文——旧实现 16000 字符截断，切掉 PPT master 的 Step 2–6。
 *
 * 用法：node scripts/技能发现与依赖测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../server/技能目录.mjs";
import { parseRequires } from "../server/技能依赖.mjs";
import { buildSkillCatalog, buildSkillReadPayload } from "../server/Skill注入.mjs";
import { searchSkills, rankSkills, scoreSkill } from "../server/技能检索.mjs";
import { expandToken, tokenizeQuery } from "../server/技能别名.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

// ---------- 1. frontmatter ----------
test("块标量 > 折叠为单行描述", () => {
  const fields = parseFrontmatter([
    "---",
    "name: ultimate-ppt-master",
    "description: >",
    "  终极融合PPT大师 / Ultimate Fusion PPT Master:",
    "  AI-driven presentation generation system.",
    "  支持 生成PPT 与 做PPT。",
    "---",
    "# 正文",
  ].join("\n"));
  assert.equal(fields.name, "ultimate-ppt-master");
  assert.match(fields.description, /终极融合PPT大师/);
  assert.match(fields.description, /生成PPT/);
  assert.equal(fields.description.includes("\n"), false, "折叠块不应保留换行");
  assert.equal(fields.description.startsWith(">"), false);
});

test("块标量 | 保留换行描述", () => {
  const fields = parseFrontmatter(["---", "name: x", "description: |", "  第一行", "  第二行", "---"].join("\n"));
  assert.equal(fields.description, "第一行\n第二行");
});

test("普通键值与引号值", () => {
  const fields = parseFrontmatter(["---", "name: \"quoted-name\"", "description: plain text", "---"].join("\n"));
  assert.equal(fields.name, "quoted-name");
  assert.equal(fields.description, "plain text");
});

test("requires 嵌套块原样保留，供依赖模块解析", () => {
  const fields = parseFrontmatter([
    "---",
    "name: ppt-master",
    "requires:",
    "  runtime: [{ kind: python, version: \">=3.10\" }]",
    "  python: [python-pptx, cairosvg]",
    "  network: true",
    "---",
  ].join("\n"));
  assert.match(fields.requires, /python-pptx/);
  assert.match(fields.requires, /network: true/);
});

// ---------- 2. 目录预算 ----------
function makeSkills(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `skill-${String(index).padStart(2, "0")}`,
    description: `用于测试的技能 ${index}，描述较长：生成图表、审查文档、撰写报告等场景都适用，用于验证预算分配。`.repeat(2),
    sourceScope: index % 3 === 0 ? "workspace" : "project",
  }));
}

test("预算不足时所有技能名至少出现一次", () => {
  const built = buildSkillCatalog({ skills: makeSkills(66), budgetBytes: 8 * 1024 });
  assert.equal(built.count, 66);
  assert.equal(built.included, 66, "66 个技能名应全部出现");
  const missing = [];
  for (let index = 0; index < 66; index += 1) {
    const name = `skill-${String(index).padStart(2, "0")}`;
    if (!built.text.includes(name)) missing.push(name);
  }
  assert.deepEqual(missing, []);
  assert.equal(built.truncated, true);
  assert.ok(built.bytes <= 8 * 1024);
});

test("预算充足时保留完整描述", () => {
  const built = buildSkillCatalog({ skills: makeSkills(3), budgetBytes: 64 * 1024 });
  assert.equal(built.included, 3);
  assert.equal(built.truncated, false);
  assert.match(built.text, /描述较长/);
});

// ---------- 3. 自然语言检索 ----------
const PPT_SKILL = { name: "ultimate-ppt-master", description: "生成可编辑 PPTX 或杂志风网页幻灯片", sourceScope: "project" };
const CHART_SKILL = { name: "baoyu-echarts", description: "ECharts 图表生成，柱状图/折线图/饼图", sourceScope: "project" };
const REVIEW_SKILL = { name: "review", description: "文档审查与质量检查", sourceScope: "user" };
const DOCX_SKILL = { name: "pptx", description: "PowerPoint 演示文稿编辑与创建", sourceScope: "project" };
const CATALOG = [PPT_SKILL, CHART_SKILL, REVIEW_SKILL, DOCX_SKILL];

test("中文自然语言查询能命中技能（旧实现 0 命中）", () => {
  const cases = [
    ["PPT 演示", ["ultimate-ppt-master", "pptx"]],
    ["制作演示文稿", ["ultimate-ppt-master", "pptx"]],
    ["生成PPT", ["ultimate-ppt-master", "pptx"]],
    ["生成图表", ["baoyu-echarts"]],
    ["柱状图", ["baoyu-echarts"]],
    ["文档审查", ["review"]],
    ["设计评审", ["review"]],
  ];
  for (const [query, expected] of cases) {
    const hits = searchSkills(CATALOG, query, { limit: 5 });
    assert.ok(hits.length > 0, `查询「${query}」应至少命中 1 个`);
    const names = hits.map((item) => item.name);
    assert.ok(expected.some((name) => names.includes(name)), `查询「${query}」应命中 ${expected.join("/")}，实际 ${names.join(",")}`);
    assert.ok(hits[0].matchReason, "结果应带命中理由");
  }
});

test("OR 检索：多词查询只要有一个词命中也能返回", () => {
  const hits = searchSkills(CATALOG, "PPT 完全不存在词", { limit: 5 });
  assert.ok(hits.some((item) => item.name === "ultimate-ppt-master"));
});

test("名称命中优先于描述命中", () => {
  const expanded = [{ token: "review", variants: ["review"] }];
  const byName = scoreSkill(REVIEW_SKILL, expanded);
  const byDescription = scoreSkill({ name: "some-skill", description: "review 文档" }, expanded);
  assert.ok(byName.score > byDescription.score);
});

test("空查询不返回全量，rankSkills 按使用频次排序", () => {
  assert.deepEqual(searchSkills(CATALOG, ""), []);
  const ranked = rankSkills(CATALOG, { pptx: 5, review: 2 }, 3);
  assert.equal(ranked[0].name, "pptx");
  assert.equal(ranked.length, 3);
});

test("别名扩展与噪声词过滤", () => {
  assert.ok(expandToken("演示文稿").includes("ppt"));
  assert.ok(expandToken("pptx").includes("幻灯片"));
  assert.deepEqual(tokenizeQuery("帮我 做一个 PPT"), ["ppt"]);
});

// ---------- 4. skills_read 全文 ----------
test("26KB 技能说明返回全文（不截断核心步骤）", () => {
  const raw = Array.from({ length: 440 }, (_, index) => `## Step ${index + 1}\n内容 ${"填充".repeat(18)} ${index}`).join("\n");
  assert.ok(raw.length > 20000 && raw.length < 64 * 1024, `样本长度 ${raw.length}`);
  const payload = buildSkillReadPayload({ name: "ultimate-ppt-master", raw });
  assert.equal(payload.truncated, false);
  assert.match(payload.text, /## Step 5/);
  assert.match(payload.text, /## Step 440/);
  assert.equal(payload.chars, raw.length);
});

test("超长技能说明降级为章节目录 + 分段提示", () => {
  const raw = `## 章节 1\n${"内容".repeat(40000)}\n## 章节 2\n结尾`;
  assert.ok(raw.length > 64 * 1024, `样本长度 ${raw.length}`);
  const payload = buildSkillReadPayload({ name: "huge-skill", raw });
  assert.equal(payload.truncated, true);
  assert.ok(Array.isArray(payload.outline) && payload.outline.length > 0);
  assert.match(payload.text, /分段获取/);
});

// ---------- 5. 接线守护 ----------
test("agent.mjs 使用新模块接线（别名为准、后台提示为 Buffer、搜索带事件）", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(agent, /findLocalSkill\(/, "skills_read 应支持别名查找");
  assert.match(agent, /backgroundNotice\(job\.jobId\)/, "后台化提示应使用 Buffer 版本");
  assert.match(agent, /writeEvent\("skill_search"/, "skills_search 应写事件");
  assert.match(agent, /writeEvent\("skill_read"/, "skills_read 应写事件");
  assert.match(agent, /skillSearchAttempts/, "应有同 Run 搜索次数上限");
});

// ---------- 6. 真实技能 requires 声明守护（2026-11-10，计划 2026-11-10-001 V1） ----------
// 核心技能必须在 frontmatter 声明 requires；未声明会得到"假绿灯"（SKILL_DEPS_NONE/ready），
// 预检无法发现真实缺失（见 docs/plans/2026-11-10-001）。以磁盘文件为准（.claude/skills 不入 git）。
const PPT_SKILL_FILE = path.join(ROOT, ".claude", "skills", "ultimate-ppt-master-skill", "SKILL.md");
const REQUIREMENTS_FILE = path.join(ROOT, ".claude", "skills", "ultimate-ppt-master-skill", "requirements.txt");

test("ultimate-ppt-master 声明 Python>=3.10 与 requirements.txt 全部 15 包", () => {
  const frontmatter = parseFrontmatter(fs.readFileSync(PPT_SKILL_FILE, "utf8"));
  const parsed = parseRequires(frontmatter.requires || "", frontmatter.install || "");
  assert.ok(parsed, "frontmatter 必须声明 requires");
  assert.equal(parsed.runtime[0]?.kind, "python");
  assert.match(parsed.runtime[0]?.version || "", />=3\.10/);
  const expected = fs.readFileSync(REQUIREMENTS_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/[><=~!].*$/, "").trim());
  assert.deepEqual(parsed.python, expected, "requires.python 应与 requirements.txt 一致");
  assert.equal(parsed.python.length, 15);
  assert.equal(parsed.network, true);
  assert.deepEqual(parsed.platform, ["win32", "darwin", "linux"]);
});

test("pptx/docx/powerpoint 技能已声明 requires（防假绿灯回归）", () => {
  const files = [
    path.join(ROOT, ".claude", "skills", "pptx", "SKILL.md"),
    path.join(ROOT, ".claude", "skills", "docx", "SKILL.md"),
    path.join(process.env.USERPROFILE || "", ".claude", "skills", "powerpoint", "SKILL.md"),
  ];
  for (const file of files) {
    const frontmatter = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const parsed = parseRequires(frontmatter.requires || "", frontmatter.install || "");
    assert.ok(parsed, `${path.basename(path.dirname(file))} 必须声明 requires`);
    assert.ok(parsed.python.length || parsed.npm.length || parsed.exec.length, `${file} 声明不能为空`);
  }
});

console.log(failed ? "\n技能发现与依赖测试：存在失败" : "\n技能发现与依赖测试：全部通过");
process.exit(failed);
