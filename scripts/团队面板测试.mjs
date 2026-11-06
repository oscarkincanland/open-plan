#!/usr/bin/env node
/**
 * 团队面板投影与契约测试（计划 2026-11-04-014 §7.9）
 *
 * 守护：
 *   - team_* 事件 → roster/task/counts/closed 的纯函数投影；
 *   - 旧 revision / 无 team_started 不乱建团队；
 *   - 任务分组顺序；
 *   - 画布 team 单例标签、顶栏 chip、只读面板源码契约；
 *   - Work/Review 有团队工具、Chat 只读；事件已登记。
 *
 * 用法：node scripts/团队面板测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reduceTeamEvent,
  teamFromEvents,
  groupTeamTasks,
  teamHeaderLabel,
  teamHeaderTitle,
  teamStatusLabel,
} from "../client/src/团队投影.js";
import { toolPolicyForMode, planTaskCapabilities } from "../server/task.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const event = (type, data, seq) => ({ type, data, seq });
const started = event("team_started", {
  teamId: "team_r1",
  runId: "r1",
  mode: "agent",
  leadId: "lead",
  leadName: "Lead",
  maxMembers: 3,
  maxTasks: 20,
  members: [{ id: "lead", name: "Lead", role: "lead", status: "active" }],
}, 1);

console.log("\n▶ 事件投影");
test("team_started → member/task/result/closed 全链路", () => {
  const team = teamFromEvents([
    started,
    event("team_member_spawned", { member: { id: "member-1", name: "甲", role: "scout", status: "provisioning" } }, 2),
    event("team_member_status", { memberId: "member-1", status: "active", activity: "执行中" }, 3),
    event("team_task_updated", { task: { id: "task-1", title: "读资料", status: "pending", revision: 1, ownerName: "", blockedBy: [], writeScopes: [] } }, 4),
    event("team_task_updated", { task: { id: "task-1", title: "读资料", status: "done", revision: 2, ownerName: "甲", blockedBy: [], writeScopes: [] } }, 5),
    event("team_member_result", { memberId: "member-1", status: "completed", output: "已读完", transcript: [{ kind: "text", text: "已读完" }] }, 6),
    event("team_closed", {
      reason: "run_finished",
      team: {
        status: "closed",
        members: [
          { id: "lead", name: "Lead", role: "lead", status: "completed", activity: "团队已结束" },
          { id: "member-1", name: "甲", role: "scout", status: "completed", activity: "任务已完成" },
        ],
        tasks: [{ id: "task-1", title: "读资料", status: "done", revision: 2, ownerName: "甲" }],
      },
    }, 7),
  ]);
  assert.equal(team.id, "team_r1");
  assert.equal(team.members.length, 2);
  assert.equal(team.members[0].id, "lead");
  assert.equal(team.members[1].status, "completed");
  assert.equal(team.members[1].transcript.length, 1);
  assert.equal(team.tasks.length, 1);
  assert.equal(team.tasks[0].revision, 2);
  assert.equal(team.tasks[0].status, "done");
  assert.equal(team.counts.members, 2);
  assert.equal(team.counts.doneTasks, 1);
  assert.equal(team.status, "closed");
  assert.equal(teamStatusLabel(team.status), "已结束");
});

test("旧 task revision 不覆盖新状态", () => {
  const team = teamFromEvents([
    started,
    event("team_task_updated", { task: { id: "task-1", title: "x", status: "done", revision: 5 } }, 2),
    event("team_task_updated", { task: { id: "task-1", title: "x", status: "pending", revision: 3 } }, 3),
  ]);
  assert.equal(team.tasks[0].status, "done");
  assert.equal(team.tasks[0].revision, 5);
});

test("没有 team_started 时不凭 member/task 事件造团队", () => {
  assert.equal(teamFromEvents([event("team_task_updated", { task: { id: "task-1" } }, 1)]), null);
});

test("未知 team 事件保持现状；非 team 事件原样返回", () => {
  const team = teamFromEvents([started]);
  assert.equal(reduceTeamEvent(team, event("team_unknown", {}, 2)), team);
  assert.equal(reduceTeamEvent(team, event("token", { text: "x" }, 3)), team);
});

test("任务分组顺序：进行中 → 待认领 → 待验收 → 已结束", () => {
  const groups = groupTeamTasks([
    { id: "t1", status: "done" },
    { id: "t2", status: "pending" },
    { id: "t3", status: "running" },
    { id: "t4", status: "review" },
  ]);
  assert.deepEqual(groups.map((group) => group.key), ["running", "pending", "review", "done"]);
  assert.deepEqual(groups.map((group) => group.tasks.map((task) => task.id)), [["t3"], ["t2"], ["t4"], ["t1"]]);
});

test("顶栏摘要包含计数/状态/关注项", () => {
  const team = teamFromEvents([
    started,
    event("team_task_updated", { task: { id: "task-1", title: "x", status: "review", revision: 1, ownerName: "甲" } }, 2),
  ]);
  assert.match(teamHeaderLabel(team), /团队 1\/1/);
  assert.match(teamHeaderTitle(team), /团队 1\/1/);
  assert.match(teamHeaderTitle(team), /待验收/);
});

console.log("\n▶ 前端源码契约");
test("画布 team 是单例但不持久化", () => {
  const source = read("client/src/画布状态.js");
  assert.match(source, /SINGLETON_TAB_KINDS[\s\S]*"team"/);
  assert.match(source, /team:\s*\{\s*title:\s*"团队",\s*icon:\s*"user"/);
  assert.match(source, /kind === "team"\) return null/);
});

test("App 同时挂顶栏 chip 与画布团队面板", () => {
  const source = read("client/src/App.jsx");
  assert.match(source, /<TeamHeaderChip/);
  assert.match(source, /canvas-body-team/);
  assert.match(source, /<TeamPanel/);
  assert.match(source, /openTeamTab/);
});

test("ChatPanel 刷新/切回会话时用 latest Run 详情重建只读团队", () => {
  const source = read("client/src/components/ChatPanel.jsx");
  assert.match(source, /includeEvents:\s*"latest"/);
  assert.match(source, /getRun\(latest\.id\)/);
  assert.match(source, /teamFromEvents\(detail\?\.run\?\.events/);
  assert.match(source, /onTeamChange/);
});

test("刷新恢复 team 时画布无其他标签则自动展示团队，窄屏保留计数", () => {
  const app = read("client/src/App.jsx");
  assert.match(app, /shouldAutoOpen/);
  assert.match(app, /teamSourceRef\.current === "hydrate"/);
  const css = read("client/src/styles.css");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*team-header-chip-count \{ display: inline; \}/);
});

test("团队面板只读：无 fetch/SSE/团队写工具", () => {
  const source = read("client/src/components/TeamPanel.jsx");
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /EventSource/);
  assert.doesNotMatch(source, /team_spawn|team_task\s*\(/);
  assert.match(source, /role="tabpanel"/);
});

test("标签栏支持通用 badge/alert，不是团队硬编码", () => {
  const source = read("client/src/components/画布标签栏.jsx");
  assert.match(source, /canvas-tab-badge/);
  assert.match(source, /canvas-tab-alert/);
  assert.doesNotMatch(source, /team_header|team-header/);
});

test("样式含 chip、面板与窄屏容器查询", () => {
  const source = read("client/src/styles.css");
  assert.match(source, /\.team-header-chip\s*\{/);
  assert.match(source, /\.team-panel\s*\{/);
  assert.match(source, /@container \(min-width:\s*560px\)/);
  assert.match(source, /@container \(max-width:\s*559px\)/);
});

console.log("\n▶ 模式边界与事件");
test("Work/Review 有 team_*，Chat 没有", () => {
  const agent = toolPolicyForMode("agent").tools;
  const review = toolPolicyForMode("review").tools;
  const chat = toolPolicyForMode("chat").tools;
  for (const name of ["team_spawn", "team_send", "team_wait", "team_list", "team_task"]) {
    assert.ok(agent.includes(name), `Work 缺少 ${name}`);
    assert.ok(review.includes(name), `Review 缺少 ${name}`);
    assert.equal(chat.includes(name), false, `Chat 不应有 ${name}`);
  }
  assert.equal(planTaskCapabilities({ text: "协作", task: { mode: "chat" } }).capabilities.some((item) => item.id === "team"), false);
  assert.equal(planTaskCapabilities({ text: "协作", task: { mode: "agent" } }).capabilities.some((item) => item.id === "team"), true);
  assert.equal(planTaskCapabilities({ text: "协作", task: { mode: "review" } }).capabilities.some((item) => item.id === "team"), true);
});

test("team_* 事件已登记且团队总人数上限为 3", () => {
  const registry = read("server/事件注册表.mjs");
  for (const type of ["team_started", "team_member_spawned", "team_member_status", "team_member_result", "team_message_queued", "team_message_delivered", "team_wait_finished", "team_task_updated", "team_closed"]) {
    assert.match(registry, new RegExp(`type: "${type}"`));
  }
  const orchestrator = read("server/团队编排器.mjs");
  assert.match(orchestrator, /TEAM_MAX_MEMBERS\s*=\s*3/);
});

test("Agent 工具按 Work/Review 模式守卫，Review 的 worker 由编排器降级", () => {
  const source = read("server/agent.mjs");
  assert.match(source, /entry\.mode === "agent" \|\| entry\.mode === "review"/);
  assert.match(source, /团队只能在 Work 或 Review 模式创建/);
  assert.match(read("server/团队编排器.mjs"), /role === "worker" && !this\.canWrite\) role = "scout"/);
});

console.log(failed ? "\n团队面板测试：存在失败项" : "\n团队面板测试：全部通过");
process.exit(failed ? 1 : 0);
