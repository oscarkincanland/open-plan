#!/usr/bin/env node
/**
 * 会话流 Run 化契约：
 * - 列表摘要包含 duration/step/artifact/summary 来源；
 * - 历史首屏只拉 summary，不拉完整 events；
 * - 完成后中间小节收进过程，折叠行显示“运行了多久/多少步”；
 * - completion.summary 优先展示，覆盖 final 时不重复；
 * - 产物卡使用扁平文件图标。
 *
 * 用法: node scripts/run-summary-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSummaryView } from "../server/runs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const app = read("client/src/App.jsx");
const chat = read("client/src/components/ChatPanel.jsx");
const projection = read("client/src/运行展示投影.js");
const server = read("server/runs.mjs");

console.log("\n▶ 摘要数据契约");

test("runSummaryView 提供折叠行/总结所需字段", () => {
  const view = runSummaryView({
    id: "run_test",
    status: "completed",
    summary: "总结",
    finalText: "答复",
    startedAt: "2026-10-30T10:00:00.000Z",
    finishedAt: "2026-10-30T11:00:00.000Z",
    steps: [{}, {}, {}],
    artifacts: [{ path: "a.docx", after: { size: 120 }, confidence: "confirmed", autoDeliverable: true }],
  });
  assert.equal(view.durationMs, 3_600_000);
  assert.equal(view.stepCount, 3);
  assert.equal(view.artifactCount, 1);
  assert.equal(view.finalText, "答复");
  assert.equal(view.summarySource, "run");
  assert.equal(view.artifacts[0].path, "a.docx");
  assert.equal(view.artifacts[0].after.size, 120);
  assert.equal(view.artifacts[0].confidence, "confirmed");
});

test("App 历史首屏使用 fields=summary", () => {
  assert.match(app, /listRuns\("", 50, \{ sessionId: session\.id, fields: "summary" \}\)/);
  assert.match(app, /events: \[\]/);
  assert.match(app, /durationMs: Number\(run\.durationMs\)/);
  assert.match(app, /stepCount: Number\(run\.stepCount\)/);
});

console.log("\n▶ 渲染顺序与文案");

test("完成后中间小节收进过程折叠", () => {
  assert.match(chat, /foldIntermediateText/);
  assert.match(chat, /blockIndex !== finalAnswerBlockIndex/);
  assert.match(chat, /block\.type === "text"\) return \(/);
});

test("折叠行显示运行时长与步数", () => {
  assert.match(chat, /process-fold-meta/);
  assert.match(chat, /"已用" : "运行了"/);
  assert.match(chat, /formatDuration\(processDurationMs\)/);
  assert.match(chat, /processStepCount/);
});

test("completion.summary 优先且不因 final 隐藏", () => {
  const segment = chat.slice(chat.indexOf("const summaryText"), chat.indexOf("const showResultCard"));
  assert.match(segment, /completion\?\.summary/);
  assert.doesNotMatch(segment, /finalAnswer \? "" : String\(completion\?\.summary/);
  assert.match(chat, /Boolean\(fallbackSummary\)/);
  assert.match(chat, /<strong>本轮总结<\/strong>/);
  assert.match(chat, /summaryCoversFinal/);
});

test("产物卡使用扁平文件图标", () => {
  assert.match(chat, /import 文件类型图标 from "\.\/FileTypeIcon\.jsx"/);
  assert.match(chat, /<文件类型图标 file=\{item\.path\} size=\{15\} \/>/);
});

test("投影尊重摘要里的 deliverable 标记", () => {
  assert.match(projection, /input\.deliverable === true/);
});

console.log("\n▶ 服务端字段接线");

test("runSummaryView 保留紧凑 artifacts 与来源字段", () => {
  assert.match(server, /durationMs/);
  assert.match(server, /summarySource/);
  assert.match(server, /stepCount/);
  assert.match(server, /artifactCount/);
  assert.match(server, /artifacts: artifacts\.slice\(0, 50\)\.map/);
});

console.log(failed ? "\n✗ 运行流摘要测试存在失败" : "\n✓ 运行流摘要测试全部通过");
process.exitCode = failed ? 1 : 0;
