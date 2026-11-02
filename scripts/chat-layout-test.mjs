#!/usr/bin/env node
/**
 * 会话流排版与宽度修复的回归测试（2026-11-01 会话流布局诊断）。
 *
 * 覆盖（全部离线，读源码 + 纯函数）：
 *   1. 结论行内 Markdown 解析（parseInlineSegments）；
 *   2. 横向滚动根因修复（.efn-item min-width / .chat-body overflow-x）；
 *   3. 四档缩进收敛（--tl-indent / locked 全宽 / sum-block 无内边距）；
 *   4. 加粗字体（--font-emphasis 与 700→600 收敛）；
 *   5. 表格排版（display:table / 字号随宿主）；
 *   6. 历史分页三态与单一事实源；
 *   7. 切换骨架屏与缓存容量；
 *   8. 右栏宽度上限与 Resizer 对齐。
 *
 * 用法: node scripts/chat-layout-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const styles = read("client/src/styles.css");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const app = read("client/src/App.jsx");
const summaryBlock = read("client/src/components/chat-flow/SummaryBlock.jsx");

const { parseInlineSegments } = await import(pathToFileURL(path.join(ROOT, "client/src/chat-flow-layout.js")).href);

console.log("\n▶ 结论行内 Markdown 解析");

await test("行内代码被识别", () => {
  const { segments } = parseInlineSegments("结论：用 `deck.json` 规范");
  const code = segments.find((s) => s.type === "code");
  assert.ok(code, "应解析出 code 片段");
  assert.equal(code.text, "deck.json", "代码内容不应包含反引号");
  assert.equal(segments.some((s) => s.text?.includes("`")), false, "不应残留反引号");
});

await test("粗体被识别", () => {
  const { segments } = parseInlineSegments("这里 **重点** 与 __次要__ 都加粗");
  const strong = segments.filter((s) => s.type === "strong").map((s) => s.text);
  assert.deepEqual(strong, ["重点", "次要"]);
});

await test("http(s) 链接被识别，非 http 协议按纯文本", () => {
  const ok = parseInlineSegments("见 [文档](https://example.com/a)");
  assert.ok(ok.segments.some((s) => s.type === "link" && s.href === "https://example.com/a"));
  const bad = parseInlineSegments("见 [危险](javascript:alert(1))");
  assert.equal(bad.segments.some((s) => s.type === "link"), false, "非 http(s) 不得生成链接");
  assert.ok(bad.segments.some((s) => s.text?.includes("javascript")), "原文保留为纯文本");
});

await test("代码内的粗体标记不被二次解析", () => {
  const { segments } = parseInlineSegments("路径 `**不是粗体**`");
  assert.equal(segments.some((s) => s.type === "strong"), false);
  assert.ok(segments.some((s) => s.type === "code" && s.text === "**不是粗体**"));
});

await test("块级标记整体降级为纯文本（结论是一段话）", () => {
  for (const text of ["## 小标题\n内容", "- 列表项", "| a | b |", "> 引用", "```js\ncode\n```"]) {
    const result = parseInlineSegments(text);
    assert.equal(result.block, true, `应判定为块级：${text.slice(0, 12)}`);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].type, "text");
  }
});

await test("空文本返回空片段", () => {
  assert.deepEqual(parseInlineSegments("").segments, []);
});

console.log("\n▶ 横向滚动修复");

await test(".efn-item 声明 min-width: 0（grid 子项可收缩）", () => {
  const rule = styles.match(/^\.efn-item \{[^}]*\}/m)?.[0] || "";
  assert.ok(rule, "未找到 .efn-item 规则");
  assert.match(rule, /min-width: 0/, "缺少 min-width: 0，省略号会失效");
});

await test(".chat-body 禁止横向滚动", () => {
  const base = styles.match(/^\.chat-body \{[^}]*\}/m)?.[0] || "";
  assert.match(base, /overflow-x: hidden/, "基础 .chat-body 应禁止横向滚动");
  // 该选择器在样式表里出现多次（含媒体查询与短规则），任一负责布局的规则带上即可。
  const slotRules = [...styles.matchAll(/\.center-chat-slot \.chat-body \{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(slotRules.length > 0, "未找到对话列的 .chat-body 规则");
  assert.ok(slotRules.some((rule) => /overflow-x: hidden/.test(rule)), "对话列的 .chat-body 也应禁止横向滚动");
});

await test(".efn-text 具备省略号三件套", () => {
  assert.match(styles, /\.efn-text \{[^}]*?min-width: 0;[^}]*?overflow: hidden;[^}]*?text-overflow: ellipsis;[^}]*?white-space: nowrap;/);
});

console.log("\n▶ 四档缩进收敛");

await test("--tl-indent 令牌存在且被 .tl-list 使用", () => {
  assert.match(styles, /--tl-indent: 12px/);
  assert.match(styles, /\.tl-list \{[^}]*?padding-left: var\(--tl-indent\)/);
});

await test(".tl-list 不再有额外 margin-left", () => {
  const rule = styles.match(/^\.tl-list \{[^}]*\}/m)?.[0] || "";
  assert.doesNotMatch(rule, /margin: [^;]*5px/, "margin-left 应归零，缩进只由 --tl-indent 承担");
});

await test("未决 ask / 审批（locked）的明细恢复全宽", () => {
  assert.match(styles, /\.tl-row\.locked \.tl-detail \{ margin-left: 0; \}/);
});

await test("本轮总结不再有独立内边距", () => {
  const rule = styles.match(/^\.sum-block \{[^}]*\}/m)?.[0] || "";
  assert.doesNotMatch(rule, /padding: 0 2px/, "sum-block 应去掉 2px 内边距");
});

await test("长路径文本可断行（sum-what / ask-question）", () => {
  assert.match(styles, /\.sum-what \{[^}]*?overflow-wrap: anywhere/);
  assert.match(styles, /\.ask-question \{[^}]*?overflow-wrap: anywhere/);
});

console.log("\n▶ 加粗字体");

await test("--font-emphasis 令牌存在且不含 MiSans", () => {
  const line = styles.match(/--font-emphasis: ([^;]+);/)?.[1] || "";
  assert.ok(line, "缺少 --font-emphasis");
  assert.doesNotMatch(line, /MiSans/, "加粗字体栈必须排除只有 400 字重的 MiSans");
  assert.match(line, /Microsoft YaHei UI|Segoe UI/, "应包含有真 Semibold 的系统字体");
});

await test("结论 / 表头 / markdown 加粗使用 --font-emphasis", () => {
  assert.match(styles, /\.sum-conclusion \{[^}]*?font-family: var\(--font-emphasis\)/);
  assert.match(styles, /\.markdown-body th \{[^}]*?font-family: var\(--font-emphasis\)/);
  assert.match(styles, /\.markdown-body strong,\n\.markdown-body b \{ font-family: var\(--font-emphasis\)/);
});

await test("全站不再使用 700 字重（只保留 400/600 两档）", () => {
  const count = (styles.match(/font-weight: 700/g) || []).length;
  assert.equal(count, 0, `仍有 ${count} 处 700，应收敛到 600`);
});

console.log("\n▶ 表格排版");

await test("表格字号跟随宿主（不再写死 12px）", () => {
  const rule = styles.match(/^\.markdown-body table \{[^}]*\}/m)?.[0] || "";
  assert.match(rule, /font-size: inherit/);
  assert.doesNotMatch(rule, /font-size: 12px/);
});

await test("总结区表格保持 display:table，滚动交给外层", () => {
  assert.match(styles, /\.sum-detail \.markdown-body table \{ display: table;/);
  assert.match(styles, /\.sum-detail \.markdown-body \{ overflow-x: auto; \}/);
});

await test("表格数字列使用等宽数字", () => {
  assert.match(styles, /\.markdown-body td \{ font-variant-numeric: tabular-nums; \}/);
});

console.log("\n▶ 已运行时长");

await test("历史轮用消息自带起止时间兜底", () => {
  assert.match(chatPanel, /const msgStart = Date\.parse\(m\.startedAt \|\| ""\) \|\| 0;/);
  assert.match(chatPanel, /const msgEnd = Date\.parse\(m\.finishedAt \|\| ""\) \|\| 0;/);
});

await test("结束后折进总结 cap，不再单占一行", () => {
  assert.match(chatPanel, /\{runElapsedText && !showTimelineSummary && <div className="tl-elapsed">/);
  assert.match(chatPanel, /elapsedMs=\{runElapsedMs\}/);
  assert.match(summaryBlock, /本轮总结\{elapsedText \? ` · \$\{elapsedText\}` : ""\}/);
});

await test("等待时长占比高时标注", () => {
  assert.match(chatPanel, /waitingMs >= runElapsedMs \* 0\.3/);
  assert.match(chatPanel, /其中等待/);
});

console.log("\n▶ 历史分页");

await test("分页结果回写 historyMessages（单一事实源）", () => {
  assert.match(app, /setHistoryMessages\(\(previous\) => \{[\s\S]{0,300}?sessionHistoryCacheRef\.current\.set\(sessionId, merged\)/);
});

await test("旧页也合并 run 摘要", () => {
  assert.match(app, /buildRunSummaryMessages\(runData\?\.runs\)/);
  assert.match(app, /mergeRunSummaries\(buildHistoryMessages\(d\.entries \|\| \[\]\), runMessages\)/);
});

await test("三态反馈可见（已加载 N / 已到最早 / 不支持）", () => {
  assert.match(chatPanel, /已到最早/);
  assert.match(chatPanel, /已加载 \$\{loaded\}/);
  assert.match(chatPanel, /不支持加载更早历史/);
  assert.match(chatPanel, /chat-history-status/);
});

await test("分页追加不重置可见窗口 / 不跳底部", () => {
  assert.match(chatPanel, /const appendOnly = historyAppendPendingRef\.current;/);
  assert.match(chatPanel, /if \(appendOnly\) \{\n\s*setMessages\(normalizeHistoryMessages\(historyMessages\)\);\n\s*return;/);
});

console.log("\n▶ 会话切换");

await test("缓存未命中置加载态并渲染骨架屏", () => {
  assert.match(app, /setHistoryLoading\(true\)/);
  assert.match(chatPanel, /\{historyHydrating && messages\.length === 0 && \(/);
  assert.match(chatPanel, /chat-history-skeleton/);
  assert.match(chatPanel, /aria-busy=\{historyHydrating \|\| undefined\}/);
});

await test("加载态在 finally 收敛（成功/失败/提前返回）", () => {
  assert.match(app, /finally \{[\s\S]{0,160}?setHistoryLoading\(false\)/);
});

await test("缓存容量扩到 24 并同步清理 meta/cursor", () => {
  assert.match(app, /sessionHistoryCacheRef\.current\.size > 24/);
  assert.match(app, /sessionHistoryMetaRef\.current\.delete\(first\)/);
});

await test("滚动位置按会话恢复", () => {
  assert.match(chatPanel, /scrollPositionsRef\.current\.set\(threadId, el\.scrollTop\)/);
  assert.match(chatPanel, /pendingScrollRestoreRef\.current = \(savedScroll != null && !hydratedIsLive\) \? savedScroll : null/);
  assert.match(chatPanel, /el\.scrollTop = Math\.min\(target, Math\.max\(0, el\.scrollHeight - el\.clientHeight\)\)/);
});

await test("工作区切换失败中止历史加载", () => {
  assert.match(app, /WORKSPACE_UNAVAILABLE/);
  assert.match(app, /已中止本次历史加载/);
});

console.log("\n▶ 右栏与令牌");

await test("右栏 max-width 与 Resizer 上限（680）一致", () => {
  const rule = styles.match(/^\.app-preview-slot \{[^}]*\}/m)?.[0] || "";
  assert.match(rule, /max-width: 680px/, "应与 App.jsx 里 Resizer 的 max(680) 一致");
  assert.match(app, /cssVar="--preview-w"/);
});

await test("--chat-w 标注了真实作用域", () => {
  assert.match(styles, /--chat-w\/min\/max 只在"独立对话列"/);
});

console.log(failed ? "\n✗ 会话流排版回归存在失败项\n" : "\n✓ 会话流排版回归全部通过\n");
process.exit(failed ? 1 : 0);
