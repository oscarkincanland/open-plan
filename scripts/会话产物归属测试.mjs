/**
 * 会话产物归属回归（test:session-artifact-truth，计划 007 块 B）。
 *
 * 事故背景（2026-11-10）：docx 已写入并登记，但
 *   1) run_216ad847 被取消，产物卡挂在“已取消”轮；
 *   2) 该轮还有 `.work/汇报稿-….md` 因 staging 后目标被改（target_changed_since_stage）
 *      跳过落盘，事件只写进 Run JSONL，界面完全看不到；
 *   3) 最新回答轮只读不写，artifactCount=0，用户因此判断“本轮产物丢了”。
 *
 * 本测试锁定服务端投影与前端摘要消息两条链路的字段契约：
 *  - runSummaryView / run_finished 都带 materializeSkipped（去重、路径统一为正斜杠）；
 *  - 前端 upsertRunSummaryMessage 保留该字段，后续事件不会把它抹掉；
 *  - 没有跳过记录时字段为空数组，不能臆造告警。
 *
 * 运行：node scripts/会话产物归属测试.mjs
 */
import assert from "node:assert/strict";
import { runSummaryView } from "../server/runs.mjs";
import { upsertRunSummaryMessage } from "../client/src/运行展示投影.js";

const passed = [];
function check(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

const skippedEvents = [
  { type: "artifact_materialize_skipped", data: { path: ".work/汇报稿-综合交通专项规划编制进展.md", reason: "target_changed_since_stage" } },
  { type: "artifact_materialize_skipped", data: { path: ".work\\汇报稿-综合交通专项规划编制进展.md", reason: "target_changed_since_stage" } },
  { type: "artifact_materialize_skipped", data: { path: "汇报材料/说明书.md", reason: "target_changed_since_stage" } },
  { type: "run_finished", data: {} },
];

console.log("▶ 服务端摘要投影");

check("runSummaryView 暴露 materializeSkipped 且按路径去重", () => {
  const view = runSummaryView({ id: "run_test", events: skippedEvents });
  assert.ok(Array.isArray(view.materializeSkipped), "materializeSkipped 必须是数组");
  assert.equal(view.materializeSkipped.length, 2, `去重后应为 2 条，实际 ${view.materializeSkipped.length}`);
  assert.deepEqual(view.materializeSkipped.map((item) => item.path), [
    ".work/汇报稿-综合交通专项规划编制进展.md",
    "汇报材料/说明书.md",
  ]);
  assert.equal(view.materializeSkipped[0].reason, "target_changed_since_stage");
});

check("没有跳过事件时为空数组（不臆造告警）", () => {
  const view = runSummaryView({ id: "run_test", events: [{ type: "run_finished", data: {} }] });
  assert.deepEqual(view.materializeSkipped, []);
  assert.deepEqual(runSummaryView({ id: "run_test" }).materializeSkipped, []);
});

check("artifacts 投影不受影响：路径/大小/归属仍在", () => {
  const view = runSummaryView({
    id: "run_test",
    events: skippedEvents,
    artifacts: [{
      path: "汇报材料/报告.docx",
      relativePath: "汇报材料/报告.docx",
      after: { size: 19979 },
      source: "write-ledger",
      confidence: "confirmed",
      autoDeliverable: true,
      acceptanceStatus: "manual_review",
    }],
  });
  assert.equal(view.artifactCount, 1);
  assert.equal(view.artifacts[0].path, "汇报材料/报告.docx");
  assert.equal(view.artifacts[0].size, 19979);
  assert.equal(view.artifacts[0].confirmed, true);
  assert.equal(view.artifacts[0].deliverable, true);
});

console.log("▶ 前端摘要消息");

check("upsertRunSummaryMessage 保留 materializeSkipped", () => {
  const list = upsertRunSummaryMessage([], {
    runId: "run_test",
    status: "cancelled",
    artifacts: [{ path: "汇报材料/报告.docx" }],
    materializeSkipped: [{ path: ".work/汇报稿.md", reason: "target_changed_since_stage" }],
  });
  const summary = list.find((item) => item.summary && item.runId === "run_test");
  assert.ok(summary, "应生成一条摘要消息");
  assert.equal(summary.materializeSkipped.length, 1);
  assert.equal(summary.materializeSkipped[0].path, ".work/汇报稿.md");
});

check("后续事件缺少该字段时不清空已记录的跳过项", () => {
  const first = upsertRunSummaryMessage([], {
    runId: "run_test2",
    status: "running",
    materializeSkipped: [{ path: ".work/汇报稿.md", reason: "target_changed_since_stage" }],
  });
  const second = upsertRunSummaryMessage(first, { runId: "run_test2", status: "cancelled" });
  const summary = second.find((item) => item.summary && item.runId === "run_test2");
  assert.equal(summary.materializeSkipped.length, 1, "终态事件没带字段时必须沿用已有记录");
});

check("没有跳过项时字段为空数组（前端渲染条件为 length>0）", () => {
  const list = upsertRunSummaryMessage([], { runId: "run_test3", status: "completed" });
  const summary = list.find((item) => item.summary && item.runId === "run_test3");
  assert.deepEqual(summary.materializeSkipped, []);
});

if (!process.exitCode) {
  console.log(`\n会话产物归属回归：通过（${passed.length} 项）`);
}
