#!/usr/bin/env node
/**
 * 过程分组与组头摘要测试（计划 2026-11-14-001 阶段 5）。
 *
 * 覆盖 `client/src/会话流/过程分组.js` 的纯函数：分类表、分组边界、类别计数去重、
 * 运行中活动选择、完成文案组合（1/2/3/4 类）。不依赖 DOM。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildRunTimeline } = await import(pathToFileURL(path.join(ROOT, "client", "src", "会话流投影.js")).href);
const {
  toolCategory,
  isProcessItem,
  countCategories,
  groupLabel,
  buildProcessSegments,
  groupCallCount,
} = await import(pathToFileURL(path.join(ROOT, "client", "src", "会话流", "过程分组.js")).href);

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

const tool = (id, name, { done = true, state = done ? "ok" : "run", input = "" } = {}) => ({
  kind: "tool",
  id,
  state,
  block: { id, toolCallId: id, name, done, input, output: "" },
});
const thinking = (id, text = "想一想") => ({ kind: "thinking", id, state: "ok", text });
const text = (id, body = "阶段小结") => ({ kind: "text", id, text: body });

console.log("\n▶ 工具名分类（DSH 精确名称表）");

test("类别表逐项命中", () => {
  const cases = [
    ["read", "read"], ["read_image", "readImage"], ["grep", "search"], ["glob", "search"],
    ["subagent_inspect", "search"], ["write", "write"], ["edit", "edit"], ["apply_patch", "edit"],
    ["bash", "commands"], ["pwsh", "commands"], ["exec_command", "commands"], ["terminal_close", "commands"],
    ["run_code", "code"], ["web_search", "webSearch"], ["web_fetch", "webFetch"],
    ["subagent", "subagents"], ["subagent_codex", "subagents"],
    ["todo_write", "plan"], ["create_goal", "plan"], ["ask_user_question", "questions"],
    ["list_mcp_resources", "tools"], ["functions.read", "tools"], ["Read", "tools"], ["", "tools"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(toolCategory(name), expected, `${name} 应归 ${expected}`);
  }
});

test("_inspect 后缀优先于 subagent_/terminal_ 前缀", () => {
  assert.equal(toolCategory("terminal_inspect"), "search");
  assert.equal(toolCategory("subagent_inspect"), "search");
});

console.log("\n▶ 分组边界");

test("过程节点（工具/思考/系统提醒）进组，回复截断组", () => {
  const segments = buildProcessSegments([
    tool("t1", "read"), thinking("k1"), tool("t2", "bash"),
    text("x1"), tool("t3", "write"),
  ]);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, "group");
  assert.equal(segments[0].members.length, 3, "工具类别变化不拆组");
  assert.equal(segments[1].type, "item");
  assert.equal(segments[2].type, "group");
  assert.equal(segments[2].members.length, 1);
});

test("轮次分隔与交互节点截断组，且自身独立成条", () => {
  const segments = buildProcessSegments([
    tool("t1", "read"),
    { kind: "turn-divider", id: "d1" },
    { kind: "ask", id: "a1", block: { answered: true } },
    tool("t2", "bash"),
  ]);
  assert.deepEqual(segments.map((s) => s.type), ["group", "item", "item", "group"]);
});

test("隐藏/权限等跳过类型既不进组也不截断", () => {
  const segments = buildProcessSegments([
    tool("t1", "read"),
    { kind: "permission", id: "p1" },
    tool("t2", "bash"),
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].members.length, 2);
});

test("思考单独成组时不计数，但仍产生组", () => {
  const segments = buildProcessSegments([thinking("k1"), thinking("k2")]);
  assert.equal(segments.length, 1);
  assert.equal(groupCallCount(segments[0].counts), 0);
});

console.log("\n▶ 类别计数");

test("按 callId 去重：同一次调用记录两次只计一次", () => {
  const counts = countCategories([tool("same", "read"), tool("same", "read"), tool("t2", "bash")]);
  assert.equal(counts.get("read"), 1);
  assert.equal(counts.get("commands"), 1);
});

test("排序：次数降序，同数按首次出现顺序", () => {
  const label = groupLabel({ members: [tool("t1", "bash"), tool("t2", "read"), tool("t3", "read")] });
  assert.equal(label, "已读取文件，执行了命令", "read=2 应排在 commands=1 前");
  const tie = groupLabel({ members: [tool("t1", "bash"), tool("t2", "read")] });
  assert.equal(tie, "执行了命令，已读取文件", "同数时按首次出现顺序");
});

console.log("\n▶ 组头文案");

test("已结束：0 类回退「已完成分析」", () => {
  assert.equal(groupLabel({ members: [] }), "已完成分析");
  assert.equal(groupLabel({ members: [thinking("k1")] }), "已完成分析");
});

test("已结束：1 类直出、2 类用「并」、3 类用「，」、4 类取前三 + 等", () => {
  assert.equal(groupLabel({ members: [tool("a", "read")] }), "已读取文件");
  assert.equal(groupLabel({ members: [tool("a", "read"), tool("b", "grep")] }), "已读取文件并搜索代码");
  assert.equal(
    groupLabel({ members: [tool("a", "read"), tool("b", "grep"), tool("c", "bash")] }),
    "已读取文件，已搜索代码，执行了命令",
  );
  assert.equal(
    groupLabel({ members: [tool("a", "read"), tool("b", "grep"), tool("c", "bash"), tool("d", "write")] }),
    "已读取文件，已搜索代码，执行了命令等",
  );
});

test("混合「已」与「非已」两类时用逗号，不强行省略第二个「已」", () => {
  const label = groupLabel({ members: [tool("a", "edit"), tool("b", "bash")] });
  assert.equal(label, "修改了文件，执行了命令");
});

test("运行中：取最近仍在运行的工具 + 参数详情", () => {
  const label = groupLabel({
    members: [
      tool("t1", "read", { done: true }),
      tool("t2", "bash", { done: false, state: "run", input: { command: "npm run test:motion" } }),
    ],
    running: true,
  });
  assert.equal(label, "正在运行命令 · npm run test:motion");
});

test("运行中：没有运行工具时回退思考首行", () => {
  const label = groupLabel({
    members: [thinking("k1", "先确认折叠实现\n第二行")],
    running: true,
  });
  assert.equal(label, "正在分析请求 · 先确认折叠实现");
});

test("运行中：既无运行工具也无思考时给「正在分析请求」", () => {
  assert.equal(groupLabel({ members: [tool("t1", "read")], running: true }), "正在分析请求");
});

console.log("\n▶ 段落产物");

test("段落带上 counts / label / running，供组头直接渲染", () => {
  const segments = buildProcessSegments([tool("t1", "read"), tool("t2", "grep")], { running: false });
  const [group] = segments;
  assert.equal(group.type, "group");
  assert.equal(group.label, "已读取文件并搜索代码");
  assert.equal(group.running, false);
  assert.equal(groupCallCount(group.counts), 2);
  assert.ok(String(group.id).startsWith("group:"));
});

test("空输入返回空数组（不产生空组）", () => {
  assert.deepEqual(buildProcessSegments([]), []);
  assert.deepEqual(buildProcessSegments(null), []);
});

test("isProcessItem：回复/交互不是过程，工具/思考是", () => {
  assert.equal(isProcessItem(tool("t1", "read")), true);
  assert.equal(isProcessItem(thinking("k1")), true);
  assert.equal(isProcessItem(text("x1")), false);
  assert.equal(isProcessItem({ kind: "approval", id: "a" }), false);
  assert.equal(isProcessItem(null), false);
});


console.log("\n▶ 与投影层联调（真实 blocks → 分组）");

test("buildRunTimeline → buildProcessSegments：真实 block 序列分组与摘要", () => {
  const blocks = [
    { type: "thinking", id: "k1", text: "先读实现" },
    { type: "tool", id: "t1", toolCallId: "c1", name: "read", input: { file_path: "client/src/a.jsx" }, output: "1\n2", done: true },
    { type: "tool", id: "t2", toolCallId: "c2", name: "bash", input: { command: "npm test" }, output: "ok", done: true },
    { type: "text", id: "x1", text: "阶段小结：读完了。" },
    { type: "tool", id: "t3", toolCallId: "c3", name: "write", input: { file_path: "client/src/b.jsx" }, output: "ok", done: true },
  ];
  const timeline = buildRunTimeline({ blocks, trace: null });
  const segments = buildProcessSegments(timeline, { running: false });
  assert.deepEqual(segments.map((segment) => segment.type), ["group", "item", "group"]);
  assert.equal(segments[0].label, "已读取文件，执行了命令");
  assert.equal(segments[2].label, "已写入文件");
  assert.equal(segments[0].members.length, 3, "思考与两个工具同组");
});

test("运行中：真实块里未完成的工具驱动组头活动", () => {
  const blocks = [
    { type: "tool", id: "t1", toolCallId: "c1", name: "bash", input: { command: "npm run test:motion" }, done: false },
  ];
  const timeline = buildRunTimeline({ blocks, trace: null });
  const [group] = buildProcessSegments(timeline, { running: true });
  assert.equal(group.running, true);
  assert.equal(group.label, "正在运行命令 · npm run test:motion");
});

console.log(failed ? "\n✗ 过程分组测试存在失败项\n" : "\n✓ 过程分组测试全部通过\n");
process.exit(failed ? 1 : 0);
