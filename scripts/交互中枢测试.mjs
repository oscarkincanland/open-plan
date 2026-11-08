#!/usr/bin/env node
/**
 * 人机协作中枢测试（D2，2026-11-08）
 *
 * 覆盖计划 2026-11-08-001 §11 / ADR-0026：
 *   - Interaction 创建、优先级排序、同 Run 单 clarify；
 *   - 状态机：open → editing/submitting → settled(answered/skipped/assumed) | expired | cancelled；
 *   - 幂等结算、超时假设（confirm 不自动继续）、假设修改；
 *   - legacy pending-asks 迁移（只迁 pending、过期跳过、去重）；
 *   - agent/index 接线与事件登记。
 *
 * 用法：node scripts/交互中枢测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-interactions-"));
process.env.OAW_INTERACTIONS_FILE = path.join(tempDir, "interactions.json");

const {
  createInteraction,
  listActiveInteractions,
  getInteraction,
  settleInteraction,
  expireInteraction,
  assumeInteraction,
  cancelClientInteractions,
  migrateLegacyAsks,
  expireStaleInteractions,
  resetInteractions,
  priorityOf,
} = await import("../server/交互中枢.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

resetInteractions();

test("创建交互并按优先级排序（approval > confirm > clarify > review）", () => {
  const review = createInteraction({ kind: "review", clientId: "c1", payload: { question: "预览确认" } });
  const clarify = createInteraction({ kind: "clarify", clientId: "c1", payload: { question: "补充信息" } });
  const confirm = createInteraction({ kind: "confirm", clientId: "c1", payload: { question: "高风险确认" } });
  const approval = createInteraction({ kind: "approval", clientId: "c1", payload: { tool: "bash" } });
  assert.equal([review, clarify, confirm, approval].every((item) => item.ok), true);
  const list = listActiveInteractions({ clientId: "c1" });
  assert.deepEqual(list.map((item) => item.kind), ["approval", "confirm", "clarify", "review"]);
  assert.equal(priorityOf("approval") > priorityOf("confirm"), true);
});

test("同一 runId 同时最多 1 个 clarify", () => {
  resetInteractions();
  const first = createInteraction({ kind: "clarify", clientId: "c2", runId: "run_1", payload: { question: "a" } });
  assert.equal(first.ok, true);
  const second = createInteraction({ kind: "clarify", clientId: "c2", runId: "run_1", payload: { question: "b" } });
  assert.equal(second.ok, false);
  assert.equal(second.code, "INTERACTION_CLARIFY_EXISTS");
  // 结算后可以再问
  settleInteraction(first.interaction.interactionId, { reason: "answered", answer: "ok" });
  const third = createInteraction({ kind: "clarify", clientId: "c2", runId: "run_1", payload: { question: "c" } });
  assert.equal(third.ok, true);
});

test("状态机：editing/submitting 只对活动记录生效", () => {
  resetInteractions();
  const created = createInteraction({ kind: "clarify", clientId: "c3", payload: { question: "?" } });
  const id = created.interaction.interactionId;
  assert.equal(getInteraction(id).status, "open");
  assert.equal(settleInteraction(id, { reason: "answered", answer: "x" }).ok, true);
  assert.equal(getInteraction(id).status, "settled");
});

test("结算幂等：重复 settle 返回第一次结果", () => {
  resetInteractions();
  const created = createInteraction({ kind: "clarify", clientId: "c4", payload: {} });
  const id = created.interaction.interactionId;
  const first = settleInteraction(id, { reason: "answered", answer: "A" });
  const second = settleInteraction(id, { reason: "answered", answer: "B" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(getInteraction(id).answer, "A");
});

test("超时：clarify/review 有假设 → assumed；confirm 不自动继续 → expired", () => {
  resetInteractions();
  const clarify = createInteraction({ kind: "clarify", clientId: "c5", payload: {}, assumption: "默认按 3000 字" });
  const review = createInteraction({ kind: "review", clientId: "c5", payload: {}, assumption: "视为未反对" });
  const confirm = createInteraction({ kind: "confirm", clientId: "c5", payload: {} });
  expireInteraction(clarify.interaction.interactionId, {});
  expireInteraction(review.interaction.interactionId, {});
  expireInteraction(confirm.interaction.interactionId, {});
  assert.equal(getInteraction(clarify.interaction.interactionId).settledReason, "assumed");
  assert.equal(getInteraction(review.interaction.interactionId).settledReason, "assumed");
  assert.equal(getInteraction(confirm.interaction.interactionId).status, "expired");
  assert.equal(getInteraction(confirm.interaction.interactionId).settledReason, "expired");
});

test("假设可修改/撤销（assumeInteraction）并留痕", () => {
  resetInteractions();
  const created = createInteraction({ kind: "clarify", clientId: "c6", payload: {}, assumption: "假设 A" });
  const id = created.interaction.interactionId;
  expireInteraction(id, {});
  const updated = assumeInteraction(id, "改成假设 B");
  assert.equal(updated.ok, true);
  assert.equal(getInteraction(id).assumption, "改成假设 B");
  assert.equal(assumeInteraction(id, "   ").ok, false);
});

test("取消客户端所有活动交互", () => {
  resetInteractions();
  createInteraction({ kind: "clarify", clientId: "c7", payload: {} });
  createInteraction({ kind: "review", clientId: "c7", payload: {} });
  const settled = createInteraction({ kind: "clarify", clientId: "c7", payload: {} });
  settleInteraction(settled.interaction.interactionId, { reason: "answered", answer: "done" });
  const result = cancelClientInteractions("c7");
  assert.equal(result.updated, 2);
  assert.equal(listActiveInteractions({ clientId: "c7" }).length, 0);
});

test("过期清理：超过 expiresAt 的活动交互被结算", () => {
  resetInteractions();
  const stale = createInteraction({ kind: "clarify", clientId: "c8", payload: {}, expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const fresh = createInteraction({ kind: "clarify", clientId: "c8", payload: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const result = expireStaleInteractions();
  assert.equal(result.updated, 1);
  assert.equal(getInteraction(stale.interaction.interactionId).status, "expired");
  assert.equal(getInteraction(fresh.interaction.interactionId).status, "open");
});

test("legacy pending-asks 迁移：只迁 pending、跳过过期、去重", () => {
  resetInteractions();
  const asks = [
    { id: "ask_1", clientId: "c9", status: "pending", question: "Q1", options: ["A"], createdAt: "2026-11-08T00:00:00.000Z", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { id: "ask_2", clientId: "c9", status: "pending", question: "过期", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    { id: "ask_3", clientId: "c9", status: "answered", question: "已答" },
  ];
  const first = migrateLegacyAsks(asks);
  assert.equal(first.created, 1);
  const second = migrateLegacyAsks(asks);
  assert.equal(second.created, 0);
  const list = listActiveInteractions({ clientId: "c9" });
  assert.equal(list.length, 1);
  assert.equal(list[0].interactionId, "itx_1");
  assert.equal(list[0].legacy.id, "ask_1");
});

test("存储文件在指定路径且是合法 JSON 数组", () => {
  const file = process.env.OAW_INTERACTIONS_FILE;
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(items));
});

// ---- 接线与事件 ----
test("agent.mjs：ask_user 创建/结算交互并双发事件", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(agent, /createInteraction\(\{/);
  assert.match(agent, /settleInteraction\(interactionId/);
  assert.match(agent, /emitChannelSafe\(entry, "interaction_open"/);
  assert.match(agent, /emitChannelSafe\(entry, "interaction_settled"/);
  assert.match(agent, /id: `itx_\$\{pendingAskId\.replace/);
});

test("index.mjs：提供交互列表/结算/假设接口，并懒迁移 legacy", () => {
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(index, /app\.get\("\/api\/interactions"/);
  assert.match(index, /app\.post\("\/api\/interactions\/:id\/settle"/);
  assert.match(index, /app\.post\("\/api\/interactions\/:id\/assume"/);
  assert.match(index, /migrateLegacyAsks/);
});

test("审批并入统一展示（只读投影，结算仍走审批接口）", () => {
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(index, /listPendingApprovals\(\)/);
  assert.match(index, /kind: "approval"/);
  assert.match(index, /itx_ap_/);
  assert.match(index, /pending-approvals/);
});

test("指标摘要接口：交互/技能/开关只读汇总", () => {
  const index = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(index, /app\.get\("\/api\/metrics\/summary"/);
  assert.match(index, /withRequires/);
  assert.match(index, /writingLeanContext: RUNTIME_FLAGS\.writingLeanContext/);
});

test("事件注册表登记 interaction_open/settled/expired/assumption", () => {
  const registry = fs.readFileSync(path.join(ROOT, "server", "事件注册表.mjs"), "utf8");
  for (const type of ["interaction_open", "interaction_settled", "interaction_expired", "interaction_assumption"]) {
    assert.match(registry, new RegExp(`type: "${type}"`), `缺少事件 ${type}`);
  }
});

console.log(failed ? "\n交互中枢测试：存在失败" : "\n交互中枢测试：全部通过");
process.exit(failed ? 1 : 0);
