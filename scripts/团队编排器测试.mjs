#!/usr/bin/env node
/**
 * 团队编排器测试（计划 2026-11-04-014）
 *
 * 守护：
 *   - Work/Review 可创建，Chat 不创建（这里只测服务本身；模式边界由能力契约测试守护）；
 *   - 团队总人数最多 3（Lead + 2 队友）；
 *   - 任务板 revision CAS、依赖 DAG、写域告警；
 *   - 消息运行中排队、空闲唤醒、完成后投递；
 *   - team_wait 边沿触发，没有活跃队友时立即 noProgress；
 *   - Run 结束 close 取消在飞队友并广播 team_closed。
 *
 * 用法：node scripts/团队编排器测试.mjs
 */
import assert from "node:assert/strict";
import { createTeamService, TEAM_MAX_MEMBERS, TEAM_MAX_TASKS } from "../server/团队编排器.mjs";

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHarness({ mode = "agent", canWrite = true } = {}) {
  const events = [];
  const calls = [];
  const service = createTeamService({
    teamId: "team_test",
    runId: "run_test",
    threadId: "thread_test",
    leadName: "Lead",
    mode,
    canWrite,
    emit: (type, data) => events.push({ type, data }),
    runMemberTask: (member, prompt, options) => new Promise((resolve, reject) => {
      const call = { member, prompt, options, resolve, reject };
      calls.push(call);
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { code: "TEAM_ABORTED" }));
      }, { once: true });
    }),
  });
  service.start();
  return { service, events, calls };
}

async function resolveCall(call, text = "done") {
  call.resolve({ text, isError: false, childId: call.member.childId, transcript: [{ kind: "text", text }] });
  await tick();
}

console.log("\n▶ 团队边界");
await testAsync("Lead + 2 名队友后拒绝第 4 人", async () => {
  const { service } = makeHarness();
  service.spawn({ name: "甲", role: "scout", task: "读资料" });
  service.spawn({ name: "乙", role: "reviewer", task: "审阅" });
  assert.throws(
    () => service.spawn({ name: "丙", role: "scout", task: "再读" }),
    (error) => error.code === "TEAM_FULL",
  );
  assert.equal(service.snapshot().members.length, TEAM_MAX_MEMBERS);
  service.close("test");
});

await testAsync("名字重复/过长被拒绝；Review 的 worker 降级为 scout", async () => {
  const { service } = makeHarness({ mode: "review", canWrite: false });
  const first = service.spawn({ name: "甲", role: "worker", task: "试着写" });
  assert.equal(first.member.role, "scout");
  assert.throws(() => service.spawn({ name: "甲", role: "scout", task: "重复" }), (error) => error.code === "TEAM_NAME_DUPLICATE");
  assert.throws(() => service.spawn({ name: "x".repeat(65), role: "scout", task: "长名" }), (error) => error.code === "TEAM_NAME_TOO_LONG");
  service.close("test");
});

console.log("\n▶ 成员生命周期与等待");
await testAsync("spawn → active → completed；team_wait 收到变化，完成后 noProgress", async () => {
  const { service, calls, events } = makeHarness();
  const spawned = service.spawn({ name: "甲", role: "scout", task: "读资料" });
  assert.equal(spawned.member.status, "provisioning");
  await tick();
  assert.equal(calls.length, 1);
  const waitPromise = service.waitForChange({ timeoutMs: 1000 });
  await resolveCall(calls[0], "已读完");
  const waited = await waitPromise;
  assert.equal(waited.changed, true);
  const member = service.snapshot().members.find((item) => item.id === "member-1");
  assert.equal(member.status, "completed");
  assert.equal(member.result, "已读完");
  assert.equal(member.transcript.length, 1);
  const noProgress = await service.waitForChange({ timeoutMs: 1000 });
  assert.equal(noProgress.noProgress, true);
  assert.ok(events.some((event) => event.type === "team_member_result"));
  service.close("test");
});

console.log("\n▶ 任务板");
await testAsync("创建/依赖/claim/CAS/完成解锁", async () => {
  const { service } = makeHarness();
  service.spawn({ name: "甲", role: "worker", task: "执行" });
  const t1 = service.task({ action: "create", title: "第一步", writeScopes: ["a.md"] }, { actorId: "lead" }).task;
  const t2 = service.task({ action: "create", title: "第二步", blockedBy: [t1.id], writeScopes: ["a.md"] }, { actorId: "lead" }).task;
  assert.equal(t1.revision, 1);
  assert.throws(() => service.task({ action: "create", title: "坏依赖", blockedBy: ["task-999"] }, { actorId: "lead" }), (error) => error.code === "TEAM_DEPENDENCY_MISSING");
  assert.throws(() => service.task({ action: "claim", taskId: t2.id, expectedRevision: 1 }, { actorId: "member-1" }), (error) => error.code === "TEAM_TASK_BLOCKED");
  const claimed = service.task({ action: "claim", taskId: t1.id, expectedRevision: 1 }, { actorId: "member-1" }).task;
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.revision, 2);
  assert.throws(() => service.task({ action: "claim", taskId: t1.id, expectedRevision: 1 }, { actorId: "member-1" }), (error) => error.code === "STALE_REVISION");
  const done = service.task({ action: "update", taskId: t1.id, expectedRevision: 2, status: "done" }, { actorId: "member-1" }).task;
  assert.equal(done.status, "done");
  const second = service.task({ action: "claim", taskId: t2.id, expectedRevision: 1 }, { actorId: "member-1" }).task;
  assert.equal(second.status, "claimed");
  assert.equal(second.ready, true);
  assert.deepEqual(second.writeConflicts, []);
  service.close("test");
});

await testAsync("未认领不能直接完成；任务数上限", async () => {
  const { service } = makeHarness();
  const t1 = service.task({ action: "create", title: "未认领" }, { actorId: "lead" }).task;
  assert.throws(() => service.task({ action: "update", taskId: t1.id, expectedRevision: 1, status: "done" }, { actorId: "lead" }), (error) => error.code === "TEAM_TASK_NOT_CLAIMED");
  for (let i = service.snapshot().tasks.length; i < TEAM_MAX_TASKS; i += 1) {
    service.task({ action: "create", title: `任务 ${i + 1}` }, { actorId: "lead" });
  }
  assert.throws(() => service.task({ action: "create", title: "超限" }, { actorId: "lead" }), (error) => error.code === "TEAM_TASK_LIMIT");
  service.close("test");
});

await testAsync("update 只改 blockedBy（不必带 status），cycle 被拒绝", async () => {
  const { service } = makeHarness();
  const t1 = service.task({ action: "create", title: "A" }, { actorId: "lead" }).task;
  const t2 = service.task({ action: "create", title: "B" }, { actorId: "lead" }).task;
  const updated = service.task({ action: "update", taskId: t2.id, expectedRevision: 1, blockedBy: [t1.id] }, { actorId: "lead" }).task;
  assert.deepEqual(updated.blockedBy, [t1.id]);
  assert.equal(updated.revision, 2);
  assert.throws(
    () => service.task({ action: "update", taskId: t1.id, expectedRevision: 1, blockedBy: [t2.id] }, { actorId: "lead" }),
    (error) => error.code === "TEAM_DEPENDENCY_CYCLE",
  );
  service.close("test");
});

await testAsync("队友完成后结果自动回填当前认领任务，供 reviewer 读取", async () => {
  const { service, calls } = makeHarness();
  service.spawn({ name: "甲", role: "scout", task: "读资料" });
  await tick();
  const task = service.task({ action: "create", title: "读取 AGENTS.md" }, { actorId: "lead" }).task;
  service.task({ action: "claim", taskId: task.id, expectedRevision: 1 }, { actorId: "member-1" });
  await resolveCall(calls[0], "AGENTS.md 规定产物写入工作区。");
  const done = service.task({ action: "get", taskId: task.id }, { actorId: "lead" }).task;
  assert.match(done.result, /产物写入工作区/);
  assert.equal(done.ownerName, "甲");
  service.close("test");
});

await testAsync("写域重叠只告警，不阻塞 claim", async () => {
  const { service } = makeHarness();
  service.spawn({ name: "甲", role: "worker", task: "执行" });
  const t1 = service.task({ action: "create", title: "A", writeScopes: ["第3章.md"] }, { actorId: "lead" }).task;
  const t2 = service.task({ action: "create", title: "B", writeScopes: ["第3章.md"] }, { actorId: "lead" }).task;
  assert.deepEqual(t2.writeConflicts, [t1.id]);
  const claimed = service.task({ action: "claim", taskId: t2.id, expectedRevision: 1 }, { actorId: "member-1" });
  assert.equal(claimed.task.status, "claimed");
  service.close("test");
});

console.log("\n▶ 消息与关闭");
await testAsync("运行中消息排队，完成后投递并唤醒；空闲队友可被新消息重新唤醒", async () => {
  const { service, calls, events } = makeHarness();
  service.spawn({ name: "甲", role: "scout", task: "初稿" });
  await tick();
  const sent = service.send({ target: "甲", message: "补一段结论" });
  assert.equal(sent.queued, true);
  await resolveCall(calls[0], "初稿完成");
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /补一段结论/);
  assert.ok(events.some((event) => event.type === "team_message_delivered"));
  await resolveCall(calls[1], "补完");
  const second = service.send({ target: "member-1", message: "再核对一次" });
  assert.equal(second.queued, false);
  await tick();
  assert.equal(calls.length, 3);
  assert.match(calls[2].prompt, /再核对一次/);
  await resolveCall(calls[2], "核对完");
  service.close("test");
});

await testAsync("消息大小限制与目标校验", async () => {
  const { service } = makeHarness();
  service.spawn({ name: "甲", role: "scout", task: "x" });
  assert.throws(() => service.send({ target: "甲", message: "x".repeat(16 * 1024 + 1) }), (error) => error.code === "TEAM_MESSAGE_TOO_LARGE");
  assert.throws(() => service.send({ target: "lead", message: "hi" }), (error) => error.code === "TEAM_SEND_LEAD");
  assert.throws(() => service.send({ target: "不存在", message: "hi" }), (error) => error.code === "TEAM_MEMBER_NOT_FOUND");
  service.close("test");
});

await testAsync("close 取消在飞队友并广播 team_closed", async () => {
  const { service, events } = makeHarness();
  service.spawn({ name: "甲", role: "scout", task: "慢任务" });
  await tick();
  const waitPromise = service.waitForChange({ timeoutMs: 1000 });
  const closed = service.close("run_finished");
  assert.equal(closed.status, "closed");
  const waited = await waitPromise;
  assert.equal(waited.closed, true);
  const member = service.snapshot().members.find((item) => item.id === "member-1");
  assert.equal(member.status, "cancelled");
  assert.ok(events.some((event) => event.type === "team_closed"));
});

console.log(failed ? "\n团队编排器测试：存在失败项" : "\n团队编排器测试：全部通过");
process.exit(failed ? 1 : 0);
