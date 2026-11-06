#!/usr/bin/env node
/**
 * 流恢复冻结回归测试（2026-11-06，P0 修复）
 *
 * 背景：刷新 / 切工作区 / 切会话后再切回「正在运行」的会话，界面冻结、运行动画消失。
 * 调查见 `docs/audits/2026-11-06-切回运行中会话冻结调查.md`。本测试冻结四条 P0 修复：
 *   P0-1 App：恢复/加载失败必须落到「横幅 + 可重试」，不能静默停在 agentReady=false；
 *        自动重试不再依赖默认关闭的开关。
 *   P0-2 ChatPanel：对账探测不再依赖「本地已判定 live」或 replayRecover 开关；
 *        探测期间的 SSE 事件先缓冲，确认 live 后再冲刷；stream_resync 无条件重探。
 *   P0-3 server：切片回放必须发 stream_resync（reason=replay_window）并报告实际起点。
 *   P0-4 server：Runtime 健康失败但忙时不得重建（否则 SSE 被打成 agent_error 循环）。
 *
 * 项目无 DOM 测试环境，这里做源码/契约级断言（与既有守护脚本口径一致）。
 * 用法：node scripts/流恢复冻结回归测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const app = read("client/src/App.jsx");
const chat = read("client/src/components/ChatPanel.jsx");
const index = read("server/index.mjs");
const agent = read("server/agent.mjs");
const api = read("client/src/api.js");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log("▶ P0-1 恢复失败不再静默卡死（App）");

test("失败统一落到 markSessionLoadFailed（横幅 + 可重试）", () => {
  assert.match(app, /const markSessionLoadFailed = \(message, code = ""\)/);
  assert.match(app, /代码|setSessionResumeError\(\{ sessionId: session\.id, message, code, detail: null \}\)/);
});

test("历史加载失败与异常路径都会记录可重试错误", () => {
  assert.match(app, /markSessionLoadFailed\(`加载会话历史失败/, "历史失败必须可重试");
  assert.match(app, /markSessionLoadFailed\(`加载会话失败/, "异常路径必须可重试");
});

test("自动重试不再依赖默认关闭的开关", () => {
  assert.doesNotMatch(app, /flag\("resumeAutoRetry"\)/, "不得再以默认关的开关作为重试前提");
  assert.match(app, /code === "SESSION_BUSY" \|\| code === ""/, "只对等一会可能成功的原因重试");
});

console.log("▶ P0-2 解除自举死锁（ChatPanel）");

test("对账探测不再依赖 replayRecover 开关或本地 live 判定", () => {
  assert.doesNotMatch(chat, /flag\("replayRecover"\) && threadId && !replayProbedThreadsRef/, "探测入口不得被开关门控");
  assert.match(chat, /2026-11-06 冻结修复/, "应有修复注释可追溯");
  assert.match(chat, /if \(!shouldReconcile\) \{/, "本地非 live 时也要进入探测");
});

test("探测使用 includeEvents=all 并恢复执行轨迹", () => {
  assert.match(chat, /listRuns\(probeThread, 12, \{ cwd: workspace, includeEvents: "all" \}\)/);
  assert.match(chat, /replaceExecutionEvents\(flowEvents\)/, "应恢复运行动画/轨迹");
});

test("探测期间事件先缓冲，确认 live 后才冲刷", () => {
  assert.match(chat, /replayProbeRef\.current\.pending && replayProbeRef\.current\.thread === threadId/, "缓冲门闩不应再带开关");
  assert.match(chat, /if \(live\) for \(const ev of buffered\) eventHandlerRef\.current\?\.\(ev\)/, "只在确认 live 后冲刷，避免历史重渲染");
});

test("切回会话时允许重新探测（否则第二次切回再次死锁）", () => {
  assert.match(chat, /if \(threadId\) replayProbedThreadsRef\.current\.delete\(threadId\)/);
});

test("stream_resync 无条件重探", () => {
  const block = chat.slice(chat.indexOf('case "stream_resync"'), chat.indexOf('case "connected"'));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /runInProgressRef\.current \|\| busy/, "不得再要求本地已知在运行");
  assert.match(block, /replayProbedThreadsRef\.current\.delete\(threadId\)/);
  assert.match(block, /setReplayFlagsTick/);
});

console.log("▶ P0-3 服务端切片回放说真话");

test("切片回放发 stream_resync 并报告实际起点", () => {
  assert.match(index, /reason: "replay_window"/);
  assert.match(index, /skipped: entry\.channel\.history\.length - replayHistory\.length/);
  assert.match(index, /earliest: firstReplayId/);
  const slice = index.slice(index.indexOf("if (lastId === 0 && replayHistory.length < entry.channel.history.length)"));
  assert.ok(slice.indexOf("stream_resync") < slice.indexOf("for (const ev of replayHistory)"), "resync 必须在回放之前发给客户端");
});

console.log("▶ P0-4 Runtime 忙时不重建");

test("ensureRuntime 在 busy/compacting/queued 时不重启", () => {
  assert.match(agent, /if \(existing\.busy \|\| existing\.compacting \|\| existing\.queuedCount > 0 \|\| \(existing\.chainDepth \|\| 0\) > 0\) \{\s*\n\s*return existing;/);
  assert.match(agent, /if \(current\.busy \|\| current\.compacting \|\| current\.queuedCount > 0 \|\| \(current\.chainDepth \|\| 0\) > 0\) return current;/);
});

console.log("▶ 基线保持");

test("恢复未完成且无活跃 Run 时仍不建连（避免创建空 runtime）", () => {
  // P1-1 放宽的只是"已知活跃 Run"这一种情况；冷会话仍必须等 resume 完成。
  assert.doesNotMatch(chat, /if \(!agentReady\) return undefined;/);
  assert.match(chat, /if \(!streamAttachAllowed\) return undefined;/);
});

test("listRuns 客户端支持 includeEvents（对账依赖）", () => {
  assert.match(api, /if \(options\.includeEvents\) params\.set\("includeEvents", options\.includeEvents\)/);
});

console.log("▶ P1 解耦与清理");

test("P1-1 活跃 Run 时不受 agentReady 门禁（attach 安全）", () => {
  assert.match(chat, /const streamAttachAllowed = Boolean\(agentReady \|\| busy\)/);
  assert.match(chat, /if \(!streamAttachAllowed\) return undefined;/);
  assert.match(chat, /\}, \[clientId, threadId, workspace, streamAttachAllowed\]\)/);
});

test("P1-2 通道换代时服务端主动 resync 并收流", () => {
  assert.match(agent, /peekRuntime\(clientId\) \{/);
  assert.match(index, /reason: "generation_changed"/);
  assert.match(index, /const current = agentManager\.peekRuntime\?\.\(agentKey\(client, thread\)\)/);
});

test("P1-3 关闭旧流带 tab 且跳过刚建立的流", () => {
  const closeBlock = index.slice(index.indexOf('app.post("/api/agent/stream/close"'), index.indexOf("// SSE stream per client"));
  assert.ok(closeBlock.length > 0);
  assert.match(closeBlock, /const tab = String\(body\.tab \|\| ""\)/);
  assert.match(closeBlock, /idleMs \|\| 0\) >= 800/);
  assert.match(closeBlock, /deferred:/);
  assert.match(read("client/src/长连接预算.js"), /tab: meta\.tab \|\| getTabId\(\)/);
});

test("P1-4 预算不足时不建连（避免黑流）", () => {
  assert.match(chat, /P1-4：预算不足时不建连/);
  assert.match(chat, /if \(!slot\) \{[\s\S]{0,160}?reconnectTimer = setTimeout/);
});

test("P1-5 知识库/模板库改为隐藏而非卸载主布局", () => {
  assert.match(app, /<div className="app-main-shell" hidden=\{\["knowledge", "templates"\]\.includes\(activeModule\)\}>/);
  assert.doesNotMatch(app, /\{!\["knowledge", "templates"\]\.includes\(activeModule\) && \(/, "不得再按模块条件卸载主布局");
  assert.match(read("client/src/styles.css"), /\.app-main-shell \{ display: contents; \}/);
  assert.match(read("client/src/styles.css"), /\.app-main-shell\[hidden\] \{ display: none; \}/);
});

console.log("▶ 刷新恢复的渲染形态");

test("恢复气泡带 Run 锚点（走时间线而不是旧折叠路径）", () => {
  assert.match(chat, /const recoveredRunId = activeRunIdRef\.current \|\| runState\.runId \|\| null/);
  assert.match(chat, /role: "assistant", runId: recoveredRunId \|\| undefined, runStatus/);
});

test("命令类工具的 `$ ...` 显示命令本身，不显示整个 JSON（字符串/对象两种输入）", () => {
  // 事件里的 input 是 JSON 字符串（"{\"command\":\"cd ...\"}"），旧修复只覆盖对象形态。
  assert.match(chat, /if \(!inputObject && typeof input === "string" && \/\^\\s\*\\\{\/\.test\(input\)\)/);
  assert.match(chat, /if \(typeof inputObject\.command === "string" && inputObject\.command\.trim\(\)\) inputStr = inputObject\.command;/);
});

test("Run 记录超限时保留最近事件（刷新对账要能看到当前进度）", () => {
  const runs = read("server/runs.mjs");
  const block = runs.slice(runs.indexOf("function pushRunEvent"), runs.indexOf("const MAX_FILES"));
  assert.match(block, /run\.events\.shift\(\);/);
  assert.match(block, /run\.events\.push\(event\);/);
  assert.match(block, /run\.eventsTruncated = true;/);
  assert.match(block, /run\.eventsDropped = Number\(run\.eventsDropped \|\| 0\) \+ 1;/);
});

test("旧过程折叠区不出现横向滚动条", () => {
  const css = read("client/src/styles.css");
  const rule = css.match(/\.message-process-scroll \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /overflow-y: auto; overflow-x: hidden;/);
  assert.match(css, /\.message-process-scroll > \* \{ min-width: 0; \}/);
});

test("运行中工具显示「已运行 Ns」活性提示（长命令静默期不再像卡死）", () => {
  assert.match(chat, /const pendingElapsed = !done && tool\.startTime/);
  assert.match(chat, /className="tool-pending-elapsed">已运行 \{pendingElapsed\}s/);
  assert.match(read("client/src/styles.css"), /\.tool-pending-elapsed \{/);
});

console.log("▶ 实时事件与历史 hydrate 不混排");

test("按 toolCallId 跨消息去重（历史已有则只更新那一块）", () => {
  assert.match(chat, /const findToolBlockOwner = useCallback\(/);
  assert.match(chat, /if \(findToolBlockOwner\(data\.toolCallId\)\) break;/, "tool_start 不得重复建卡");
  assert.match(chat, /const owner = findToolBlockOwner\(data\.toolCallId\);\s*\n\s*if \(owner\) queueToolOutput\(owner\.messageId, data\);/, "tool_output 必须回到拥有该卡片的消息");
  assert.match(chat, /if \(owner\) \{\s*\n\s*patch\(owner\.messageId,/, "tool_end 必须在原消息上收尾");
});

test("hydrate 前缓冲的旧回放不追加到快照之后", () => {
  assert.match(chat, /replayBufferRef\.current = \[\];\s*\n\s*replayProbeRef\.current = \{ pending: false, thread: null \};/);
});

test("hydrate 保留尚未落盘的实时气泡（思考栏/跑马灯不消失）", () => {
  assert.match(chat, /const liveStreaming = \(messagesRef\.current \|\| \[\]\)\.find\(\(item\) => item\?\.role === "assistant" && item\?\.status === "streaming"\)/);
  assert.match(chat, /mergedHistory = \[\.\.\.normalizedHistory, \{ \.\.\.liveStreaming, blocks: keptBlocks \}\]/);
  assert.match(chat, /assistantIdRef\.current = keptLiveId \|\| \(isLiveRun/, "保留下来的气泡必须是新的流式锚点");
});

test("合并时按 toolCallId 与文本重叠去重（不重复渲染）", () => {
  assert.match(chat, /if \(block\.type === "tool"\) return !hydratedToolIds\.has/);
  assert.match(chat, /return !hydratedTextBlob\.includes\(text\.slice\(0, Math\.min\(80, text\.length\)\)\)/);
});

test("中断后的孤儿消息归到一张「运行记录缺失」卡（不再每条一个折叠头）", () => {
  assert.match(app, /function buildOrphanRunCards\(messages = \[\], runCards = \[\]\)/);
  assert.match(app, /const orphanCards = buildOrphanRunCards\(msgs, runMessages\);/);
  assert.match(app, /mergeRunSummaries\(msgs, \[\.\.\.runMessages, \.\.\.orphanCards\]\)/);
  assert.match(app, /mergeRunSummaries\(appendedMessages, \[\.\.\.runMessages, \.\.\.buildOrphanRunCards\(appendedMessages, runMessages\)\]\)/);
});

if (failed) {
  console.error("\n✗ 流恢复冻结回归存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 流恢复冻结回归全部通过\n");
