#!/usr/bin/env node
/**
 * 子代理编排器测试（P1-C / P2-B，方案 §3.2–§3.6）。
 * 只测纯逻辑（server/子代理编排器.mjs），执行器（Pi 子会话）注入模拟实现；
 * agent.mjs 的接线由集成测试覆盖。
 *
 * 用法: node scripts/子代理编排器测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBAGENT_ROLES,
  SUBAGENT_CONCURRENCY,
  SUBAGENT_MAX_TASKS,
  SUBAGENT_REVISE_ROUNDS,
  resolveRole,
  childIdFor,
  parseVerdict,
  buildVerifierTask,
  summarizeResults,
  orchestrateSubagents,
  createDelegationIdempotencyCache,
} from "../server/子代理编排器.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

console.log("\n▶ 角色定义与解析（P1-C）");
test("五个角色且只读/可写分级正确", () => {
  for (const role of ["scout", "reviewer", "planner", "verifier"]) {
    assert.equal(SUBAGENT_ROLES[role].readOnly, true, `${role} 应只读`);
    assert.ok(SUBAGENT_ROLES[role].tools.includes("read"));
    assert.ok(!SUBAGENT_ROLES[role].tools.includes("write"), `${role} 不应有写工具`);
  }
  assert.equal(SUBAGENT_ROLES.worker.readOnly, false);
  assert.ok(SUBAGENT_ROLES.worker.tools.includes("officecli"));
});
test("超时分级：worker 最长、scout/planner 最短", () => {
  assert.ok(SUBAGENT_ROLES.worker.timeoutMs > SUBAGENT_ROLES.scout.timeoutMs);
  assert.equal(SUBAGENT_ROLES.scout.timeoutMs, 60000);
  assert.equal(SUBAGENT_ROLES.reviewer.timeoutMs, 120000);
});
test("resolveRole：未知角色回 scout，worker 无写权限降级", () => {
  assert.equal(resolveRole("worker", { canWrite: false }), "scout");
  assert.equal(resolveRole("worker", { canWrite: true }), "worker");
  assert.equal(resolveRole("不存在的角色", {}), "scout");
  assert.equal(resolveRole("verifier", { canWrite: false }), "verifier");
});
test("childIdFor 稳定且净化非法字符", () => {
  assert.equal(childIdFor("call_1", 0, false), "subagent_call_1");
  assert.equal(childIdFor("call_1", 1, true), "subagent_call_1_2");
  assert.equal(childIdFor("a/b\\c", 0, false), "subagent_a_b_c");
});

console.log("\n▶ verifier 判定解析");
test("解析「判定：revise」与检查清单", () => {
  const parsed = parseVerdict("- 数据来源：缺失\n- 结论与文件一致：通过\n判定：revise");
  assert.equal(parsed.verdict, "revise");
  assert.equal(parsed.checklist.length, 2);
  assert.equal(parsed.checklist[0].ok, false);
  assert.equal(parsed.checklist[1].ok, true);
});
test("解析 JSON verdict 与 fail 关键词", () => {
  assert.equal(parseVerdict('{"verdict":"fail"}').verdict, "fail");
  assert.equal(parseVerdict("结论不成立\n判定：fail").verdict, "fail");
});
test("无明确判定时 fail-safe 为 pass", () => {
  assert.equal(parseVerdict("看起来没问题").verdict, "pass");
});
test("buildVerifierTask 包含任务、结论与判定格式要求", () => {
  const task = buildVerifierTask({ task: "统计人口", output: "约 120 万" });
  assert.ok(task.includes("统计人口"));
  assert.ok(task.includes("120 万"));
  assert.match(task, /判定：pass/);
});

console.log("\n▶ 编排：fan-out + 对抗核验 + revise 回环（P2-B）");
await test("planned→started→result→verified→closed 事件序 + revise 回环一次", async () => {
  const events = [];
  let workerRuns = 0;
  let verifierRuns = 0;
  const result = await orchestrateSubagents({
    tasks: ["任务甲", "任务乙"],
    role: "worker",
    roleSpec: SUBAGENT_ROLES.worker,
    toolKey: "call1",
    parentToolCallId: "call1",
    verify: true,
    emit: (type, data) => events.push({ type, childId: data.childId, verdict: data.verdict ?? null, finalStatus: data.finalStatus ?? null }),
    runTask: async (task, ctx) => {
      if (ctx.roleOverride === "verifier") {
        verifierRuns += 1;
        const round = Number(String(ctx.childId).match(/_v(\d+)/)?.[1] || 0);
        return { text: round === 1 ? "- 覆盖不全：缺失\n判定：revise" : "- 已补齐：通过\n判定：pass", isError: false, childId: ctx.childId };
      }
      workerRuns += 1;
      return { text: `交付 ${workerRuns}`, isError: false, childId: ctx.childId };
    },
  });
  assert.equal(workerRuns, 4, "2 个子任务各跑 2 轮（revise 一次）");
  assert.equal(verifierRuns, 4, "每个子任务每轮核验一次");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("subagent_planned"));
  assert.ok(types.includes("subagent_started"));
  assert.ok(types.includes("subagent_result"));
  assert.ok(types.includes("subagent_verified"));
  assert.ok(types.includes("subagent_closed"));
  // 每个子任务都以 closed 收尾，且第二轮核验后 pass
  const closed = events.filter((e) => e.type === "subagent_closed");
  assert.equal(closed.length, 2);
  for (const item of closed) assert.equal(item.finalStatus, "completed");
  // 每个子任务都经历 revise→pass 两轮核验；最终判定（最后一次 verified）应为 pass
  const verdicts = events.filter((e) => e.type === "subagent_verified").map((e) => e.verdict);
  const verdictByChild = new Map();
  for (const event of events) {
    if (event.type === "subagent_verified") verdictByChild.set(event.childId, event.verdict);
  }
  assert.deepEqual([...verdictByChild.values()].sort(), ["pass", "pass"]);
  assert.equal(verdicts.filter((v) => v === "revise").length, 2, "每个子任务第一轮核验应为 revise");
  assert.equal(result.isError, false);
  // 事件都带 parentToolCallId（G3：按 toolCallId 归属）——由 emit 参数断言在调用方侧验证
});
await test("所有子代理事件都带 parentToolCallId（G3 契约）", async () => {
  const events = [];
  await orchestrateSubagents({
    tasks: ["只读检索"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call2",
    parentToolCallId: "tool-call-xyz",
    emit: (type, data) => events.push({ type, parent: data.parentToolCallId }),
    runTask: async (task, ctx) => ({ text: "ok", isError: false, childId: ctx.childId }),
  });
  assert.ok(events.length >= 4);
  for (const event of events) assert.equal(event.parent, "tool-call-xyz", `${event.type} 必须携带 parentToolCallId`);
});
await test("scout 不触发核验；并发受限（SUBAGENT_CONCURRENCY）", async () => {
  let concurrent = 0;
  let peak = 0;
  const events = [];
  await orchestrateSubagents({
    tasks: ["a", "b", "c", "d"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call3",
    verify: true, // scout 不应核验
    emit: (type) => events.push(type),
    runTask: async (task, ctx) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { text: task, isError: false, childId: ctx.childId };
    },
  });
  assert.equal(peak, SUBAGENT_CONCURRENCY, `峰值并发应等于 ${SUBAGENT_CONCURRENCY}`);
  assert.ok(!events.includes("subagent_verified"), "scout 任务不做核验");
});
await test("超过 SUBAGENT_MAX_TASKS 的任务被裁剪", async () => {
  const seen = [];
  await orchestrateSubagents({
    tasks: ["1", "2", "3", "4", "5", "6"],
    role: "planner",
    roleSpec: SUBAGENT_ROLES.planner,
    toolKey: "call4",
    emit: () => {},
    runTask: async (task, ctx) => { seen.push(task); return { text: task, isError: false, childId: ctx.childId }; },
  });
  assert.equal(seen.length, SUBAGENT_MAX_TASKS);
});
await test("执行器抛错不中断其它子任务，错误子任务关账 failed", async () => {
  const closed = [];
  const result = await orchestrateSubagents({
    tasks: ["会炸", "正常"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call5",
    emit: (type, data) => { if (type === "subagent_closed") closed.push({ id: data.childId, status: data.finalStatus }); },
    runTask: async (task) => {
      if (task.includes("会炸")) throw new Error("boom");
      return { text: "fine", isError: false, childId: "x" };
    },
  });
  assert.equal(closed.filter((item) => item.status === "failed").length, 1);
  assert.equal(closed.filter((item) => item.status === "completed").length, 1);
  assert.equal(result.results.find((item) => item.text.includes("fine")).status, "completed");
});
await test("signal 已中止时子任务直接关账 cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const closed = [];
  await orchestrateSubagents({
    tasks: ["a"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call6",
    signal: controller.signal,
    emit: (type, data) => { if (type === "subagent_closed") closed.push(data.finalStatus); },
    runTask: async () => ({ text: "不应执行", isError: false, childId: "x" }),
  });
  assert.deepEqual(closed, ["cancelled"]);
});
await test("summarizeResults 多任务带标题、附核验结论", () => {
  const text = summarizeResults([
    { text: "结果一", isError: false, verify: { verdict: "pass" } },
    { text: "结果二", isError: false, verify: { verdict: "revise" } },
  ]);
  assert.match(text, /### 子任务 1/);
  assert.match(text, /结果一/);
  assert.match(text, /需修订/);
});

console.log("\n▶ revise 回环上限");
test("SUBAGENT_REVISE_ROUNDS = 1（方案 §3.6）", () => {
  assert.equal(SUBAGENT_REVISE_ROUNDS, 1);
});

console.log("\n▶ 委派幂等缓存（opt-in，默认关）");
await test("同一 key 只执行一次；重复调用 deduped=true", async () => {
  const cache = createDelegationIdempotencyCache();
  let runs = 0;
  const fn = async () => { runs += 1; return { runs }; };
  const first = cache.run("k1", fn);
  const second = cache.run("k1", fn);
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  const [a, b] = await Promise.all([first.promise, second.promise]);
  assert.equal(runs, 1, "同一 key 只应执行一次");
  assert.deepEqual(a, { runs: 1 });
  assert.deepEqual(b, { runs: 1 });
  assert.equal(cache.size(), 1);
});
await test("在途调用共享同一个 promise（并发重放不重复派发）", async () => {
  const cache = createDelegationIdempotencyCache();
  let release;
  let runs = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const fn = async () => { runs += 1; await gate; return "done"; };
  const first = cache.run("k", fn);
  const second = cache.run("k", fn);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 1, "首次调用即占位，重放不应再次进入执行器");
  assert.equal(first.promise, second.promise, "在途时应共享同一个 promise");
  release();
  assert.equal(await second.promise, "done");
});
await test("失败不缓存：后续重放会重新执行", async () => {
  const cache = createDelegationIdempotencyCache();
  let runs = 0;
  const fn = async () => { runs += 1; if (runs === 1) throw new Error("boom"); return "ok"; };
  await assert.rejects(() => cache.run("k", fn).promise);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.has("k"), false, "失败后应从缓存移除");
  assert.equal(await cache.run("k", fn).promise, "ok");
  assert.equal(runs, 2);
});
await test("TTL 过期后重新执行", async () => {
  let clock = 0;
  const cache = createDelegationIdempotencyCache({ ttlMs: 1000, now: () => clock });
  let runs = 0;
  const fn = async () => { runs += 1; return runs; };
  await cache.run("k", fn).promise;
  clock = 500;
  assert.equal(cache.run("k", fn).deduped, true, "未过期应命中");
  clock = 2000;
  const third = cache.run("k", fn);
  assert.equal(third.deduped, false, "过期后应重新执行");
  await third.promise;
  assert.equal(runs, 2);
});
await test("超过 max 时按最旧清理", async () => {
  const cache = createDelegationIdempotencyCache({ max: 2 });
  const fn = async () => "x";
  await cache.run("a", fn).promise;
  await cache.run("b", fn).promise;
  await cache.run("c", fn).promise;
  assert.equal(cache.has("a"), false, "最旧的 a 应被清理");
  assert.equal(cache.size(), 2);
});

console.log("\n▶ 阻塞事件冒泡与开关契约（opt-in）");
await test("subagent_blocked / subagent_unblocked 已登记且负载校验生效", async () => {
  const { isRegisteredEvent, validateEventPayload, eventSpec } = await import("../server/事件注册表.mjs");
  for (const type of ["subagent_blocked", "subagent_unblocked"]) {
    assert.ok(isRegisteredEvent(type), `${type} 未登记`);
    const spec = eventSpec(type);
    assert.equal(spec.persist, true, `${type} 应落盘`);
    assert.equal(spec.lifecycle, true, `${type} 应为生命周期事件`);
    const verdict = validateEventPayload(type, { childId: "subagent_x", kind: "approval", tool: "write", target: "a/b.txt" });
    assert.equal(verdict.ok, true, `${type} 合法负载应通过：${JSON.stringify(verdict)}`);
  }
  assert.equal(validateEventPayload("subagent_blocked", { kind: "approval" }).ok, false, "缺少 childId 应判不合法");
});
await test("运行开关含 subagentIdempotent / subagentBlockedBubble（默认关）", async () => {
  const flags = await import("../server/运行开关.mjs");
  const src = fs.readFileSync(path.join(ROOT, "server", "运行开关.mjs"), "utf8");
  assert.match(src, /OAW_SUBAGENT_IDEMPOTENT/, "应定义幂等开关环境变量");
  assert.match(src, /OAW_SUBAGENT_BLOCKED_BUBBLE/, "应定义阻塞冒泡开关环境变量");
  const snapshot = flags.runtimeFlagsSnapshot();
  assert.ok("subagentIdempotent" in snapshot, "快照应含 subagentIdempotent");
  assert.ok("subagentBlockedBubble" in snapshot, "快照应含 subagentBlockedBubble");
  if (!process.env.OAW_SUBAGENT_IDEMPOTENT && !process.env.OAW_SUBAGENT_BLOCKED_BUBBLE) {
    assert.equal(flags.RUNTIME_FLAGS.subagentIdempotent, false, "未设 env 时幂等开关应默认关闭");
    assert.equal(flags.RUNTIME_FLAGS.subagentBlockedBubble, false, "未设 env 时冒泡开关应默认关闭");
  }
});
await test("agent.mjs 接线：幂等复用 + 阻塞冒泡均门控在开关上", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(src, /subagentDelegationCache\.run\(/, "run_subagent 应接入委派幂等缓存");
  assert.match(src, /RUNTIME_FLAGS\.subagentIdempotent && parentToolCallId/, "幂等路径应门控 subagentIdempotent");
  assert.match(src, /return runOrchestration\(\);/, "开关关闭时应直接执行编排主体（基线行为）");
  assert.match(src, /emitChild\("subagent_blocked"/, "应冒泡 subagent_blocked");
  assert.match(src, /emitChild\("subagent_unblocked"/, "应冒泡 subagent_unblocked");
  assert.match(src, /RUNTIME_FLAGS\.subagentBlockedBubble && matchToolAction\("write"/, "冒泡应门控 subagentBlockedBubble");
});

console.log(failed ? "\n子代理编排器测试：存在失败" : "\n子代理编排器测试：全部通过");
process.exit(failed);
