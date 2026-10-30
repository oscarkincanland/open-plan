#!/usr/bin/env node
/**
 * Office 澄清闸门测试（O-23 / O-24 / O-25 / O-26）。
 * 覆盖：最小信息集、授权默认值、编辑追问、流水线回传、单槽位保护。
 *
 * 用法: node scripts/Office澄清闸门测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessClarification, missingInfoFields, routeTaskIntent } from "../server/task.mjs";
import { runEditorialPipeline } from "../server/编辑流水线.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AGENT_SOURCE = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
const CHAT_SOURCE = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8");
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (error) => { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); },
);

const assess = (text, extra = {}) => assessClarification({ text, route: "generate", template: null, scene: null, ...extra });

console.log("\n▶ 最小信息集（8 例）");
await test("信息齐全 → 不问", () => {
  const r = assess("写一份5页的报告，给主管部门看，使用工作区已有数据，风格正式严谨");
  assert.equal(r.shouldAsk, false);
  assert.deepEqual(r.missing, []);
});
await test("只缺 1 项 → 不问，给出假设", () => {
  const r = assess("写一份5页的报告，给主管部门看，使用工作区已有数据");
  assert.equal(r.shouldAsk, false);
  assert.ok(r.assumption.includes("风格"));
});
await test("缺 3 项 → 只问第一个（篇幅）", () => {
  const r = assess("写一份报告，给主管部门看");
  assert.equal(r.shouldAsk, true);
  assert.equal(r.question.field, "length");
  assert.equal(r.missing.length, 3);
});
await test("缺 4 项 → 只问 1 个", () => {
  const r = assess("帮我写个文档");
  assert.equal(r.shouldAsk, true);
  assert.equal(r.question.field, "length");
  assert.ok(r.question.options.length >= 3);
});
await test("类型不明确 → 先问类型，选项来自场景", () => {
  const r = assess("帮我写点东西");
  assert.equal(r.shouldAsk, true);
  assert.equal(r.question.field, "type");
  assert.ok(r.question.options.includes("研究报告"));
});
await test("用户说“你看着办” → 不问，按默认值", () => {
  const r = assess("帮我写个文档，你看着办");
  assert.equal(r.shouldAsk, false);
  assert.ok(r.assumption.includes("默认值"));
});
await test("模板已确定类型 → 不问类型", () => {
  const template = { file: "04_工程可行性研究报告模板.md", relPath: "templates/traffic-material/04_工程可行性研究报告模板.md", title: "工可" };
  const r = assessClarification({ text: "写一个工可材料", route: "template", template, scene: null });
  assert.equal(r.question?.field === "type", false);
});
await test("编辑路由 → 不进入写作澄清", () => {
  assert.deepEqual(missingInfoFields({ text: "改一下", route: "edit" }), []);
});

console.log("\n▶ 编辑追问与流水线回传（6 例）");
await test("编辑意图 + 有文件 → edit", () => {
  assert.equal(routeTaskIntent({ text: "改一下", task: { mode: "agent", currentFile: "a.docx" } }).route, "edit");
});
await test("提示词包含“改哪一段/改成什么/是否保留原格式”", () => {
  assert.ok(AGENT_SOURCE.includes("改哪一段"));
  assert.ok(AGENT_SOURCE.includes("改成什么"));
  assert.ok(AGENT_SOURCE.includes("是否保留原格式"));
});
await test("流水线缺信息 → needs_clarification，不产成品", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-clarify-"));
  try {
    const r = await runEditorialPipeline({
      format: "docx", goal: "写个文档", workspace, autoClarify: true,
      runModelTask: async () => { throw new Error("不应调用模型"); },
    });
    assert.equal(r.status, "needs_clarification");
    assert.equal(r.deliverable, null);
    assert.ok(r.clarification.question.text.length > 4);
  } finally {
    cleanup(workspace);
  }
});
await test("澄清问题带快捷选项", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-clarify-"));
  try {
    const r = await runEditorialPipeline({ format: "docx", goal: "写个文档", workspace, autoClarify: true, runModelTask: async () => "" });
    assert.ok(Array.isArray(r.clarification.question.options));
    assert.ok(r.clarification.question.options.length >= 3);
  } finally {
    cleanup(workspace);
  }
});
await test("带上澄清答案 → 继续执行并完成", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-clarify-"));
  try {
    const planner = JSON.stringify({ title: "测试报告", sections: [{ title: "执行摘要", summary: "要点" }] });
    const writer = JSON.stringify({ sections: [{ title: "执行摘要", blocks: [{ type: "paragraph", text: "这是正文内容，长度足够用于中文首行缩进检查。" }] }] });
    const r = await runEditorialPipeline({
      format: "docx", goal: "写一份5页的报告，给主管部门看，使用工作区已有数据，风格正式严谨",
      workspace, autoClarify: true, clarificationAnswers: ["报告"], scene: "report", qa: true, modelReview: false,
      runModelTask: async (_prompt, { stage }) => (stage === "planner" ? planner : writer),
    });
    assert.equal(r.status, "completed");
    assert.ok(r.deliverable);
    assert.equal(r.scene.id, "report");
  } finally {
    cleanup(workspace);
  }
});
await test("autoClarify 关闭 → 行为与旧版一致（不问）", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-clarify-"));
  try {
    const planner = JSON.stringify({ title: "测试", sections: [{ title: "执行摘要", summary: "x" }] });
    const writer = JSON.stringify({ sections: [{ title: "执行摘要", blocks: [{ type: "paragraph", text: "这是正文内容，长度足够用于中文首行缩进检查。" }] }] });
    const r = await runEditorialPipeline({
      format: "docx", goal: "写个文档", workspace, autoClarify: false, modelReview: false,
      runModelTask: async (_prompt, { stage }) => (stage === "planner" ? planner : writer),
    });
    assert.notEqual(r.status, "needs_clarification");
  } finally {
    cleanup(workspace);
  }
});

console.log("\n▶ 单槽位与超时（6 例）");
await test("ask_user 有单槽位保护", () => assert.ok(AGENT_SOURCE.includes("单槽位保护（O-26）")));
await test("已有待回答时拒绝第二个", () => assert.ok(AGENT_SOURCE.includes("this.pendingAsks.has(clientId)")));
await test("拒绝文案明确", () => assert.ok(AGENT_SOURCE.includes("同一会话同时只能有一个问题")));
await test("保留 5 分钟超时", () => assert.ok(AGENT_SOURCE.includes("ASK_TIMEOUT_MS = 300_000")));
await test("超时后按专业判断继续并注明假设", () => assert.ok(AGENT_SOURCE.includes("按专业判断继续")));
await test("取消时回填已取消提醒", () => assert.ok(AGENT_SOURCE.includes("本轮任务已被用户取消")));

await test("sourceMarkdown + 澄清 → 生成 draft.md 预览", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-preview-"));
  try {
    const r = await runEditorialPipeline({
      format: "docx", goal: "写个文档", workspace, autoClarify: true,
      sourceMarkdown: "# 草稿标题\n\n正文内容", runModelTask: async () => { throw new Error("不应调用模型"); },
    });
    assert.equal(r.status, "needs_clarification");
    assert.ok(r.clarification.previewPath, "应返回 previewPath");
    const file = path.resolve(workspace, r.clarification.previewPath);
    assert.ok(fs.existsSync(file), "草稿文件应存在");
    assert.ok(fs.readFileSync(file, "utf8").includes("草稿标题"));
  } finally {
    cleanup(workspace);
  }
});

console.log("\n▶ 草稿预览（1 例）");
await test("ask_user 带 previewFile 时前端自动打开", () => {
  assert.ok(CHAT_SOURCE.includes("data.previewFile"));
  assert.ok(CHAT_SOURCE.includes("onOpenFile?.(data.previewFile)"));
});

process.exitCode = failed ? 1 : 0;
