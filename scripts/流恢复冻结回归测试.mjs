#!/usr/bin/env node
/**
 * 流恢复 / 会话隔离 / 渲染形态回归测试
 *
 * 覆盖三轮修复（2026-11-06 ~ 11-07），调查见：
 *   docs/audits/2026-11-06-切回运行中会话冻结调查.md
 *   docs/audits/2026-11-06-双会话隔离与模型污染调查.md
 *   docs/audits/2026-11-07-时间流与对话流渲染审查.md
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
const css = read("client/src/styles.css");
const index = read("server/index.mjs");
const agent = read("server/agent.mjs");
const runs = read("server/runs.mjs");
const api = read("client/src/api.js");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log("▶ P0-1 恢复失败不再静默卡死（App）");

test("失败统一落到 markSessionLoadFailed（横幅 + 可重试）", () => {
  assert.match(app, /const markSessionLoadFailed = \(message, code = ""\)/);
  assert.match(app, /setSessionResumeError\(\{ sessionId: session\.id, message, code, detail: null \}\)/);
});

test("历史加载失败与异常路径都会记录可重试错误", () => {
  assert.match(app, /markSessionLoadFailed\(`加载会话历史失败/);
  assert.match(app, /markSessionLoadFailed\(`加载会话失败/);
});

test("自动重试不再依赖默认关闭的开关", () => {
  assert.doesNotMatch(app, /flag\("resumeAutoRetry"\)/, "不得再以默认关的开关作为重试前提");
  assert.match(app, /code === "SESSION_BUSY" \|\| code === ""/);
});

console.log("▶ P0-2 解除自举死锁（ChatPanel）");

test("对账探测不再依赖 replayRecover 开关或本地 live 判定", () => {
  assert.doesNotMatch(chat, /flag\("replayRecover"\) && threadId && !replayProbedThreadsRef/);
  assert.match(chat, /2026-11-06 冻结修复/);
  assert.match(chat, /if \(!shouldReconcile\) \{/);
});

test("探测使用 includeEvents=all 并恢复执行轨迹", () => {
  assert.match(chat, /listRuns\(probeThread, 12, \{ cwd: workspace, includeEvents: "all" \}\)/);
  assert.match(chat, /replaceExecutionEvents\(flowEvents\)/);
});

test("探测期间事件先缓冲，确认 live 后才冲刷", () => {
  assert.match(chat, /replayProbeRef\.current\.pending && replayProbeRef\.current\.thread === threadId/);
  assert.match(chat, /if \(live\) for \(const ev of buffered\) eventHandlerRef\.current\?\.\(ev\)/);
});

test("切回会话时允许重新探测", () => {
  assert.match(chat, /if \(threadId\) replayProbedThreadsRef\.current\.delete\(threadId\)/);
});

test("stream_resync 无条件重探", () => {
  const block = chat.slice(chat.indexOf('case "stream_resync"'), chat.indexOf('case "connected"'));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /runInProgressRef\.current \|\| busy/);
  assert.match(block, /replayProbedThreadsRef\.current\.delete\(threadId\)/);
  assert.match(block, /setReplayFlagsTick/);
});

console.log("▶ P0-3 服务端切片回放说真话");

test("切片回放发 stream_resync 并报告实际起点", () => {
  assert.match(index, /reason: "replay_window"/);
  assert.match(index, /skipped: entry\.channel\.history\.length - replayHistory\.length/);
  assert.match(index, /earliest: firstReplayId/);
  const slice = index.slice(index.indexOf("if (lastId === 0 && replayHistory.length < entry.channel.history.length)"));
  assert.ok(slice.indexOf("stream_resync") < slice.indexOf("for (const ev of replayHistory)"));
});

console.log("▶ P0-4 Runtime 忙时不重建");

test("ensureRuntime 在 busy/compacting/queued 时不重启", () => {
  assert.match(agent, /if \(existing\.busy \|\| existing\.compacting \|\| existing\.queuedCount > 0 \|\| \(existing\.chainDepth \|\| 0\) > 0\) \{\s*\n\s*return existing;/);
  assert.match(agent, /if \(current\.busy \|\| current\.compacting \|\| current\.queuedCount > 0 \|\| \(current\.chainDepth \|\| 0\) > 0\) return current;/);
});

console.log("▶ P1 解耦与清理");

test("P1-1 活跃 Run 时不受 agentReady 门禁", () => {
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

test("P1-4 预算不足时不建连", () => {
  assert.match(chat, /P1-4：预算不足时不建连/);
  assert.match(chat, /if \(!slot\) \{[\s\S]{0,160}?reconnectTimer = setTimeout/);
});

test("P1-5 知识库/模板库改为隐藏而非卸载主布局", () => {
  assert.match(app, /<div className="app-main-shell" hidden=\{\["knowledge", "templates"\]\.includes\(activeModule\)\}>/);
  assert.doesNotMatch(app, /\{!\["knowledge", "templates"\]\.includes\(activeModule\) && \(/);
  assert.match(css, /\.app-main-shell \{ display: contents; \}/);
  assert.match(css, /\.app-main-shell\[hidden\] \{ display: none; \}/);
});

console.log("▶ 刷新恢复的渲染形态");

test("恢复气泡带 Run 锚点", () => {
  assert.match(chat, /const recoveredRunId = activeRunIdRef\.current \|\| runState\.runId \|\| null/);
  assert.match(chat, /role: "assistant", runId: recoveredRunId \|\| undefined, runStatus/);
});

test("命令类工具的 $ ... 显示命令本身（字符串/对象两种输入）", () => {
  assert.match(chat, /if \(!inputObject && typeof input === "string" && \/\^\\s\*\\\{\/\.test\(input\)\)/);
  assert.match(chat, /if \(typeof inputObject\.command === "string" && inputObject\.command\.trim\(\)\) inputStr = inputObject\.command;/);
});

test("旧过程折叠区不出现横向滚动条", () => {
  const rule = css.match(/\.message-process-scroll \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /overflow-y: auto; overflow-x: hidden;/);
  assert.match(css, /\.message-process-scroll > \* \{ min-width: 0; \}/);
});

console.log("▶ 长任务记录与活性");

test("Run 记录超限时保留最近事件", () => {
  const block = runs.slice(runs.indexOf("function pushRunEvent"), runs.indexOf("const MAX_FILES"));
  assert.match(block, /run\.events\.shift\(\);/);
  assert.match(block, /run\.events\.push\(event\);/);
  assert.match(block, /run\.eventsTruncated = true;/);
  assert.match(block, /run\.eventsDropped = Number\(run\.eventsDropped \|\| 0\) \+ 1;/);
});

test("运行中工具显示「已运行 Ns」", () => {
  assert.match(chat, /const pendingElapsed = !done && tool\.startTime/);
  assert.match(chat, /className="tool-pending-elapsed">已运行 \{pendingElapsed\}s/);
  assert.match(css, /\.tool-pending-elapsed \{/);
});

console.log("▶ 实时事件与历史 hydrate 不混排");

test("按 toolCallId 跨消息去重（历史已有则只更新那一块）", () => {
  assert.match(chat, /const findToolBlockOwner = useCallback\(/);
  assert.match(chat, /if \(findToolBlockOwner\(data\.toolCallId\)\) break;/);
  assert.match(chat, /if \(owner\) queueToolOutput\(owner\.messageId, data\);/);
  assert.match(chat, /if \(owner\) \{\s*\n\s*patch\(owner\.messageId,/);
});

test("hydrate 保留尚未落盘的实时气泡（思考栏/跑马灯不消失）", () => {
  assert.match(chat, /const liveStreaming = \(messagesRef\.current \|\| \[\]\)\.find\(\(item\) => item\?\.role === "assistant" && item\?\.status === "streaming"\)/);
  assert.match(chat, /mergedHistory = \[\.\.\.normalizedHistory, \{ \.\.\.liveStreaming, blocks: keptBlocks \}\]/);
  assert.match(chat, /assistantIdRef\.current = keptLiveId \|\| \(isLiveRun/);
});

test("中断后的孤儿消息归到一张「运行记录缺失」卡", () => {
  assert.match(app, /function buildOrphanRunCards\(messages = \[\], runCards = \[\]\)/);
  assert.match(app, /const orphanCards = buildOrphanRunCards\(msgs, runMessages\);/);
  assert.match(app, /mergeRunSummaries\(msgs, \[\.\.\.runMessages, \.\.\.orphanCards\]\)/);
  assert.match(app, /mergeRunSummaries\(appendedMessages, \[\.\.\.runMessages, \.\.\.buildOrphanRunCards\(appendedMessages, runMessages\)\]\)/);
});

console.log("▶ 会话隔离");

test("切换会话时目标会话的历史必须重新水合", () => {
  const hydrate = chat.slice(chat.indexOf("if (historyThreadId && historyThreadId !== threadId) return;"));
  assert.match(hydrate, /\}, \[historyMessages, historyThreadId, threadId\]\);/);
});

test("切会话清掉上一会话的当前动作/上一轮提示", () => {
  const block = chat.slice(chat.indexOf("const hydratingHistory = Boolean(historyMessages"), chat.indexOf("previousThreadRef.current = threadId;"));
  assert.match(block, /setLastPrompt\(null\);\s*\n\s*setAgentPhase\(""\);/);
  assert.doesNotMatch(block, /if \(!hydratingHistory\) \{\s*\n\s*setLastPrompt\(null\);/);
});

test("模型隔离：会话上报的模型不写全局偏好、不回推 onModelChange", () => {
  assert.match(chat, /function applyModelForSession\(id, list\)/);
  // 取整个 connected 分支（到下一个 case 为止），避免新增代码把窗口挤出去。
  const start = chat.indexOf('case "connected":');
  const nextCase = chat.indexOf('case "', start + 10);
  const connected = chat.slice(start, nextCase > start ? nextCase : start + 1200);
  assert.match(connected, /applyModelForSession\(data\.model\)/);
  assert.doesNotMatch(connected, /onModelChange\?\.\(data\.model\)/);
  assert.match(chat, /const lastSelectedModelRef = useRef\(selectedModel\);/);
  assert.match(chat, /if \(selectedModel === previous\) return;/);
});

console.log("▶ 推理档位");

test("默认推理档位为「高」，不支持时按 高→标准→默认 降级且不回写偏好", () => {
  assert.match(chat, /const DEFAULT_THINKING_EFFORT = "high";/);
  assert.match(chat, /function readInitialThinkingEffort\(\)/);
  assert.match(chat, /const \[effort, setEffort\] = useState\(readInitialThinkingEffort\)/);
  assert.match(chat, /const effectiveEffort = useMemo\(\(\) => \{/);
  assert.match(chat, /return \["high", "medium", "default"\]\.find\(\(id\) => thinkingAvailable\(id\)\) \|\| "default";/);
  assert.doesNotMatch(chat, /setEffort\(fallback\)/);
  assert.doesNotMatch(chat, /localStorage\.setItem\(THINKING_KEY, fallback\)/);
  assert.match(chat, /const selectedEffort = source\.effort \?\? effectiveEffort;/);
});

test("老版本遗留的 default 档位做一次性迁移", () => {
  assert.match(chat, /const THINKING_MIGRATION_KEY = "oaw_thinking_level_v3";/);
  assert.match(chat, /saved === "default" && !migrated/);
});

console.log("▶ 时间流排版节奏（2026-11-07 实测收敛，同日二次压缩）");

test("单行条目用 1.35 行高，不继承正文 1.75", () => {
  const head = css.match(/\.tl-row-head \{[\s\S]*?\}/)?.[0] || "";
  assert.match(head, /line-height: 1\.35;/);
  assert.match(css, /\.tl-verb \{ font-size: 14px; font-weight: 400; line-height: 1\.35; flex: none; \}/);
  assert.match(css, /\.tl-obj \{ font-size: 14px; line-height: 1\.35;/);
});

test("工具行与工具卡间距收敛（header 3px / card 2px）", () => {
  const headerRule = (css.match(/\.tool-header \{[^}]*\}/g) || []).pop() || "";
  assert.match(headerRule, /padding: 3px 8px;/);
  assert.match(headerRule, /line-height: 1\.35;/);
  assert.match(css, /\.tool-card \{[\s\S]{0,300}?margin-bottom: 2px;/);
  const listRule = css.match(/\.tl-list \{[\s\S]*?\}/)?.[0] || "";
  assert.match(listRule, /gap: 1px;/);
  assert.match(listRule, /margin: 2px 0 3px 0;/);
});

test("轮次分隔只留 2/1（不再在每张工具卡后形成 14px 空白）", () => {
  assert.match(css, /\.tl-turn-sep \{ height: 0; margin: 2px 0 1px; \}/);
});

test("阶段小结：标签 1.5 行高 + 与思考正文同一左边缘（38px）", () => {
  const block = css.match(/\.tl-list \.textblock \{[^}]*\}/)?.[0] || "";
  assert.match(block, /padding: 2px 8px 4px 38px;/);
  assert.match(block, /margin: 1px 0;/, "小结块上下各 1px，与工具卡形成分组感");
  const capRule = css.match(/\.tl-list \.textblock \.tb-cap \{[^}]*\}/)?.[0] || "";
  assert.match(capRule, /line-height: 1\.5;/);
  assert.match(capRule, /margin-bottom: 2px;/, "标签与正文间距固定 2px");
});

test("消息列与消息内条目同步收敛（gap 12 / main 2）", () => {
  const slot = css.match(/\.center-chat-slot \.chat-body \{[\s\S]*?\}/)?.[0] || "";
  assert.match(slot, /gap: 12px;/);
  assert.match(slot, /padding: 24px var\(--chat-gutter\) 18px;/);
  const main = css.match(/\.msg-main \{[\s\S]*?\}/)?.[0] || "";
  assert.match(main, /gap: 2px;/);
});


test("时间流小结正文首尾段落外边距归零（消除\"空格很大\"）", () => {
  assert.match(css, /\.tl-list \.textblock \.markdown-body > :first-child \{ margin-top: 0; \}/);
  assert.match(css, /\.tl-list \.textblock \.markdown-body > :last-child \{ margin-bottom: 0; \}/);
});

test("运行中用时并入消息头（结算时不产生高度跳变）", () => {
  assert.match(chat, /isTaskLive && runElapsedText && !showTimelineSummary && \(\s*\n\s*<span className="msg-run-elapsed">/);
  assert.match(chat, /runElapsedText && hideHeader && !showTimelineSummary && <div className="tl-elapsed">/);
  assert.match(css, /\.msg-run-elapsed \{ margin-left: auto; color: var\(--muted\); font-variant-numeric: tabular-nums; \}/);
});

test("思考正文高度随视口收缩（不再固定 220px）", () => {
  const rule = css.match(/\.tl-thinking-text \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /max-height: min\(220px, 45vh\);/);
});

test("正文行高仍按 DESIGN 1.75（不跟着收敛）", () => {
  const flow = css.match(/\.flow-markdown \.markdown-body \{[^}]*\}/)?.[0] || "";
  assert.match(flow, /font-size: 14px;/);
  assert.match(css, /\.msg \.markdown-body \{ font-size: 14px; line-height: 1\.75; \}/);
});

test("跟底滚动定时器不会被高频 token 饿死", () => {
  const block = chat.slice(chat.indexOf("跟底滚动不能被"), chat.indexOf("useEffect(() => () => {"));
  assert.ok(block.length > 0, "未找到跟底滚动实现");
  assert.match(block, /if \(scrollTimerRef\.current\) return;/, "已排队时不得重置定时器");
  assert.doesNotMatch(block, /clearTimeout\(scrollTimerRef\.current\);\s*\n\s*scrollTimerRef\.current = setTimeout/, "不得每次 messages 变化都清理重建");
});

console.log("▶ 基线保持");

test("冷会话仍不建连（避免创建空 runtime）", () => {
  assert.doesNotMatch(chat, /if \(!agentReady\) return undefined;/);
  assert.match(chat, /if \(!streamAttachAllowed\) return undefined;/);
});

test("listRuns 客户端支持 includeEvents", () => {
  assert.match(api, /if \(options\.includeEvents\) params\.set\("includeEvents", options\.includeEvents\)/);
});

if (failed) {
  console.error("\n✗ 流恢复/隔离/排版回归存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 流恢复/隔离/排版回归全部通过\n");
