#!/usr/bin/env node
/**
 * 会话流排版与宽度修复的回归测试（2026-11-01 会话流布局诊断）。
 *
 * 覆盖（全部离线，读源码 + 纯函数）：
 *   1. 总结正文为连续 Markdown（结论与详细展开合并，无 cap / 标签 / 「做了什么」行）；
 *   2. 横向滚动根因修复（.efn-item min-width / .chat-body overflow-x）；
 *   3. 四档缩进收敛（--tl-indent / locked 全宽 / sum-block 无内边距）；
 *   4. 加粗字体（--font-emphasis 与 700→600 收敛）；
 *   5. 表格排版（display:table / 字号随宿主）；
 *   6. 历史分页三态与单一事实源；
 *   7. 切换骨架屏与缓存容量；
 *   8. 右栏宽度上限与 Resizer 对齐；
 *   9. 整轮过程折叠头与字号档位（规范 v2.0 / ADR 0014）。
 *
 * 用法: node scripts/会话流排版回归测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const summaryBlock = read("client/src/components/会话流/SummaryBlock.jsx");
const runFoldBar = read("client/src/components/会话流/RunFoldBar.jsx");
const projection = read("client/src/会话流投影.js");
const traceSource = read("client/src/运行轨迹.js");

console.log("\n▶ 总结正文（连续 Markdown）");

await test("总结不再有 cap / 分节标签 / 做了什么行", () => {
  assert.doesNotMatch(summaryBlock, /sum-cap|sum-label|sum-conclusion|sum-what|sum-detail/, "v2.0 已移除三层标签");
  assert.doesNotMatch(styles, /^\.sum-(cap|label|conclusion|what|detail)\b/m, "样式表不应再有旧标签规则");
});

await test("结论与详细展开合并为一段连续正文", () => {
  assert.match(summaryBlock, /className="sum-body"/);
  assert.match(summaryBlock, /<MarkdownBody onOpenFile=\{onOpenFile\} artifacts=\{artifacts\} numberSections(?:[^>]*)>/);
  assert.match(chatPanel, /\[summaryParts\.conclusion, summaryParts\.detail\]\.filter\(Boolean\)\.join\("\\n\\n"\)/);
});

await test("正文是页面主体：14px / 1.75 / --text", () => {
  assert.match(styles, /\.sum-body \.markdown-body \{[^}]*?font-size: 14px;[^}]*?line-height: 1\.75;[^}]*?color: var\(--text\)/);
});

await test("地图紧凑对话栏单独收紧 Markdown 排版", () => {
  assert.match(styles, /\.center-chat-slot\.map-mode \.markdown-body,[\s\S]{0,260}?font-size: 13px;[\s\S]{0,80}?line-height: 1\.65;/);
  assert.match(styles, /\.center-chat-slot\.map-mode \.markdown-body p \{ margin: 6px 0; \}/);
  assert.match(styles, /\.center-chat-slot\.map-mode \.markdown-body li \{ margin: 3px 0; \}/);
  assert.match(styles, /\.center-chat-slot\.map-mode \.chat-body \{[\s\S]{0,80}?gap: 12px;/);
  assert.match(styles, /\.center-chat-slot\.map-mode \.run-result-grid \{ gap: 6px 14px; \}/);
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

await test("长路径文本可断行（markdown 正文 / ask-question）", () => {
  assert.match(styles, /\.markdown-body \{[^}]*?word-break: break-word/);
  assert.match(styles, /\.ask-question \{[^}]*?overflow-wrap: anywhere/);
});

console.log("\n▶ 加粗字体");

await test("--font-emphasis 使用 OPPO Sans 4.0 的真实 600 字重", () => {
  const line = styles.match(/--font-emphasis: ([^;]+);/)?.[1] || "";
  assert.ok(line, "缺少 --font-emphasis");
  assert.match(line, /OPPO Sans 4\.0/, "加粗字体栈应以 OPPO Sans 4.0 优先");
  assert.match(line, /Microsoft YaHei UI|Segoe UI/, "应保留系统字体兜底");
});

await test("OPPO Sans 4.0 以可变字体内嵌（100–700）", () => {
  const fontCss = fs.readFileSync(path.join(ROOT, "client/src/assets/fonts/oppo-sans/index.css"), "utf8");
  assert.match(styles, /@import "\.\/assets\/fonts\/oppo-sans\/index\.css"/, "styles.css 应引入 OPPO Sans 分片 CSS");
  assert.match(fontCss, /font-family: "OPPO Sans 4\.0"/, "分片 CSS 应声明 OPPO Sans 4.0");
  assert.match(fontCss, /font-weight: 100 700/, "应为 100–700 可变字重，600 不是合成加粗");
  assert.doesNotMatch(styles, /MiSans/, "不应再引用 MiSans");
});

await test("加粗统一走 --font-emphasis（含表头与 markdown 强强调）", () => {
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

await test("总结区表格只保留一层滚动（不再叠加 overflow-x）", () => {
  // 2026-11-14（计划 2026-11-14-002 P0）：删除 .sum-body 上多余的 overflow-x，
  // 滚动只由 MarkdownBody 的 .md-table-wrap 提供，避免双滚动条与表头错位。
  assert.doesNotMatch(styles, /\.sum-body \.markdown-body \{ overflow-x: auto; \}/);
  assert.match(styles, /\.md-table-wrap \{ overflow-x: auto; \}/);
});

await test("文档表：只保留横线，不再全网格 + 表头实底", () => {
  const cellRule = styles.match(/^\.markdown-body th, \.markdown-body td \{[^}]*\}/m)?.[0] || "";
  assert.ok(cellRule, "未找到单元格规则");
  assert.match(cellRule, /border: 0;/);
  assert.match(cellRule, /border-bottom: 0\.5px solid/);
  assert.doesNotMatch(cellRule, /border: 1px solid/);
  const thRule = styles.match(/^\.markdown-body th \{[^}]*\}/m)?.[0] || "";
  assert.ok(thRule, "未找到表头规则");
  assert.doesNotMatch(thRule, /background:/, "表头不应再铺实底");
});

await test("结论区文档化能力保留在 MarkdownBody；对话内结论不带目录条（2026-11-18-001 D1）", () => {
  const md = read("client/src/components/MarkdownBody.jsx");
  // 能力仍在组件层（md 文档预览 DocViewer 等场景继续使用）
  assert.match(md, /function extractTopSections/);
  assert.match(md, /className="md-doc-bar"/);
  assert.match(md, /className="md-doc-toc"/);
  assert.match(md, /navigator\.clipboard\.writeText/);
  assert.match(styles, /\.md-doc-toc-item/);
  // 对话内结论（SummaryBlock / SafeMarkdown 终稿路径）不再传 docToc/copyable：
  // 目录条横排铺开与 md 文档预览同款，观感像"打开了 md 文件"（用户 2026-11-18 反馈）。
  assert.doesNotMatch(summaryBlock, /docToc/, "SummaryBlock 不得再传 docToc");
  assert.doesNotMatch(summaryBlock, /copyable/, "SummaryBlock 不得再传 copyable");
});

await test("表格数字列使用等宽数字", () => {
  assert.match(styles, /\.markdown-body td \{ font-variant-numeric: tabular-nums; \}/);
});

console.log("\n▶ 已运行时长");

await test("历史轮用 runSummary / 消息起止时间兜底", () => {
  assert.match(chatPanel, /resolveRunElapsedMs\(\{[\s\S]*?runSummary[\s\S]*?message: m[\s\S]*?\}\)/);
  assert.match(traceSource, /Date\.parse\(runSummary\?\.startedAt/);
  assert.match(traceSource, /Date\.parse\(message\?\.startedAt/);
});

await test("结束后用时进折叠头，不再单占一行、也不再进总结 cap", () => {
  // 2026-11-07：运行中的用时并入消息头（固定高度），结算时不产生高度跳变；
  // compact/嵌入式隐藏消息头时才回落到独立行。
  assert.match(chatPanel, /isTaskLive && runElapsedText && !showTimelineSummary && \(\s*\n\s*<span className="msg-run-elapsed">/);
  assert.match(chatPanel, /\{runElapsedText && hideHeader && !showTimelineSummary && <div className="tl-elapsed">/);
  assert.match(chatPanel, /elapsedMs: runElapsedMs/);
  assert.match(projection, /`\$\{headText\} · 用时 \$\{formatDuration\(ms\)\}`/);
  assert.doesNotMatch(summaryBlock, /elapsedMs/, "总结块不再接收耗时");
});

await test("不再读取从未写入的 waitingMs（死字段已清理）", () => {
  assert.doesNotMatch(chatPanel, /runTraceForTimeline\?\.waitingMs/, "waitingMs 从未被归约写入，读取即死代码");
  assert.doesNotMatch(chatPanel, /其中等待/, "已移除从未生效的等待注记");
});

console.log("\n▶ 历史分页");

await test("分页结果回写 historyMessages（单一事实源）", () => {
  assert.match(app, /setHistoryMessages\(\(previous\) => \{[\s\S]{0,300}?sessionHistoryCacheRef\.current\.set\(sessionId, merged\)/);
});

await test("旧页也合并 run 摘要", () => {
  assert.match(app, /buildRunSummaryMessages\(runData\?\.runs\)/);
  // 2026-11-06：合并前先取历史消息（msgs），并补「运行记录缺失」孤儿卡、再做规范化。
  assert.match(app, /buildHistoryMessages\(d\.entries \|\| \[\]\)/);
  assert.match(app, /mergeRunSummaries\(msgs, \[\.\.\.runMessages, \.\.\.orphanCards\]\)/);
  assert.match(app, /normalizeHistoryMessages\(mergeRunSummaries\(/);
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

console.log("\n▶ 系统引导提示");

await test("office-pipeline 提醒不进消息流（只记系统提示）", () => {
  // 它是 harness 对模型的内部引导，用户不能响应；渲染成"⟳ 插入新指令"会被
  // 误认为用户操作，且 pushSystem 是永久气泡（Run 结束不清理）。
  assert.match(chatPanel, /else if \(source === "office-pipeline"\) \{/);
  assert.match(chatPanel, /key: "office-pipeline",[\s\S]{0,120}?kind: "progress"/);
  // 该分支内不得再调用 pushSystem
  const block = chatPanel.match(/else if \(source === "office-pipeline"\) \{([\s\S]{0,400}?)\n        \} else if/)?.[1] || "";
  assert.ok(block, "未找到 office-pipeline 分支");
  assert.doesNotMatch(block, /pushSystem\(/, "office-pipeline 不得再走永久气泡");
});

await test("用户主动插话仍保留确认提示", () => {
  const block = chatPanel.match(/else if \(message\) \{([\s\S]{0,200}?)\n        \}/)?.[1] || "";
  assert.match(block, /pushSystem\(`⟳ 插入新指令/, "用户插话的即时反馈应保留");
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

await test("跟底滚动瞬时定位，不被 CSS smooth 拖成动画（2026-11-15-003）", () => {
  // `.chat-body` 的 scroll-behavior: smooth 保留：用户主动滚动/点回到底部仍有动效。
  assert.match(styles, /\.chat-body \{ scroll-behavior: smooth; \}/, "会话流应保留平滑滚动的设计基线");
  // 关键：CSSOM 里 scrollTo({behavior:"auto"}) 会解析成 CSS 计算值（= smooth），
  // 跟底每 60ms 触发一次会互相打断，观感就是"一直在跳"——必须走瞬时定位。
  assert.match(chatPanel, /const jumpScrollTo = \(el, top\) => \{/, "缺少瞬时定位辅助函数");
  assert.match(chatPanel, /el\.style\.scrollBehavior = "auto";/, "瞬时定位需临时关闭 CSS 平滑");
  assert.match(chatPanel, /jumpScrollTo\(el, el\.scrollHeight\);/, "自动跟随必须走瞬时定位");
  assert.doesNotMatch(
    chatPanel,
    /el\.scrollTo\(\{ top: el\.scrollHeight, behavior: "auto" \}\)/,
    "自动跟随不得再用会被 CSS smooth 接管的写法",
  );
});

await test("阅读位置只在真正换会话时武装，避免水合重跑把视口拽回旧位置", () => {
  assert.match(
    chatPanel,
    /if \(previousThreadRef\.current !== threadId\) \{[\s\S]{0,220}?pendingScrollRestoreRef\.current/,
    "pendingScrollRestore 必须只在 thread 变化时武装",
  );
});

await test("一次性系统提示到点淡出后移除，错误/需行动类常驻（2026-11-15-004）", () => {
  // 提示生命周期
  assert.match(chatPanel, /const TRANSIENT_NOTICE_TTL_MS = 6000;/, "一次性提示应有时长常量");
  assert.match(chatPanel, /const TRANSIENT_NOTICE_FADE_MS = 220;/, "应有淡出时长常量");
  assert.match(chatPanel, /const pushSystem = useCallback\(\(text, key = text, options = \{\}\)/, "pushSystem 应支持第 3 个选项参数");
  assert.match(chatPanel, /\.\.\.\(sticky \? \{\} : \{ transient: true, expiresAt: Date\.now\(\) \+ TRANSIENT_NOTICE_TTL_MS \}\)/, "非 sticky 提示应标记 transient + 到期时间");
  assert.match(chatPanel, /leaving: true/, "到期应先标 leaving 再移除");
  assert.match(chatPanel, /isMotionReduced\(\) \? 0 : TRANSIENT_NOTICE_FADE_MS/, "减少动效档位下应直接移除");
  // 悬停暂停 / 移开重新计时
  assert.match(chatPanel, /addEventListener\("pointerover", onOver\)/, "提示悬停应暂停计时");
  assert.match(chatPanel, /expiresAt: Number\.MAX_SAFE_INTEGER/, "悬停时到期时间应推到极远");
  // 必须常驻的提示
  for (const key of ["agent_model_fallback_failed", "goal-error", "team-mode-rejected", "team-mode-disabled", "composer-help", "stop-unconfirmed", "stop-failed"]) {
    assert.match(
      chatPanel,
      new RegExp(`${key}[^\\n]{0,120}sticky: true`),
      `「${key}」必须 sticky（错误/需行动/用户主动索取）`,
    );
  }
  assert.match(chatPanel, /地图分析已生成[^\n]{0,160}sticky: true/, "地图分析结果入口提示应常驻");
  // 样式：淡出过渡 + 减少动效下禁用
  assert.match(styles, /\.msg\.system\.transient \{ transition: opacity/, "缺少淡出过渡");
  assert.match(styles, /\.msg\.system\.transient\.is-leaving \{ opacity: 0;/, "缺少淡出终态");
  assert.match(styles, /:is\(\[data-reduce-motion="1"\], \[data-motion-level="off"\]\) \.msg\.system\.transient \{ transition: none !important; \}/, "淡出过渡必须进统一动效闸门");
});

await test("工作区切换失败中止历史加载", () => {
  assert.match(app, /WORKSPACE_UNAVAILABLE/);
  assert.match(app, /已中止本次历史加载/);
});

console.log("\n▶ 右栏与令牌");

await test("右栏 max-width 与 Resizer 上限一致", () => {
  // 工作区右侧栏在画布整合后由 --canvas-w 驱动（App.jsx 的 Resizer max=760）；
  // CSS 的 max-width 必须与 Resizer 的 max 一致，否则拖到上限以上手柄还在动、栏宽却不变。
  assert.match(app, /cssVar="--canvas-w"/, "App.jsx 应由 --canvas-w 驱动画布右栏宽度");
  assert.match(
    app,
    /max=\{760\}[\s\S]{0,80}cssVar="--canvas-w"|cssVar="--canvas-w"[\s\S]{0,80}max=\{760\}/,
    "Resizer 的 max(760) 应与画布右栏上限一致",
  );
});

await test("--chat-w 标注了真实作用域", () => {
  assert.match(styles, /--chat-w\/min\/max 只在"独立对话列"/);
});

console.log("\n▶ 整轮过程折叠（规范 v2.0 / ADR 0014）");

await test("折叠头组件：可展开、有 aria 关联", () => {
  assert.match(runFoldBar, /aria-expanded=\{open\}/);
  assert.match(runFoldBar, /aria-controls=\{idRef\.current\}/);
  assert.match(runFoldBar, /className="run-fold-head"/);
});

await test("折叠头不使用字符箭头（统一走 Icon）", () => {
  assert.doesNotMatch(runFoldBar, /[▸▾↗]/, "字符箭头会被界面一致性守护拦下");
  assert.match(runFoldBar, /<Icon name="chevronRight" size=\{12\} \/>/);
});

await test("收起时把焦点交回折叠头，收起态移出 Tab 序列", () => {
  assert.match(runFoldBar, /if \(active && bodyRef\.current && bodyRef\.current\.contains\(active\)\) headRef\.current\?\.focus\(\)/);
  assert.match(styles, /\.run-fold-body \{[^}]*?visibility: hidden/);
});

await test("运行中直铺时间流，终态才折叠", () => {
  assert.match(chatPanel, /\{isTaskLive \? \(/);
  assert.match(chatPanel, /<RunFoldBar state=\{runFold\.state\} label=\{runFold\.label\} steps=\{runTimeline\.length\}/);
  assert.match(chatPanel, /const runFold = describeRunFold\(\{/);
  // 规范 §2 / ADR 0014 §4.2：失败与取消也默认折叠，可执行动作靠折叠体外「需行动提示」承载。
  assert.match(chatPanel, /defaultOpen=\{Boolean\(executionFlow\?\.defaultExpanded\)\}/, "折叠默认开合由用户「活动显示」设置决定，不随终态变化");
  assert.doesNotMatch(chatPanel, /defaultOpen=\{runFold\.state/, "不得按终态决定默认展开");
});

await test("已决 ask / 已决审批折叠为时间流一行，可展开回看", () => {
  assert.match(chatPanel, /case "ask": \{/);
  assert.match(chatPanel, /if \(!b\.answer && !b\.expired\) return null;/, "未决 ask 仍由折叠体外常驻渲染");
  assert.match(chatPanel, /verb=\{b\.answer \? "已回答" : "已过期"\}/);
  assert.match(chatPanel, /case "approval": \{/);
  assert.match(chatPanel, /if \(!b\.decision\) return null;/, "未决审批仍由折叠体外常驻渲染");
  assert.match(chatPanel, /verb=\{b\.decision === "deny" \? "已拒绝" : "已允许"\}/);
  assert.ok(
    chatPanel.indexOf('case "ask":') > chatPanel.indexOf("const renderTimelineItem"),
    "已决交互行应渲染在时间流内部（折叠体里）",
  );
});

await test("运行中显示「当前：动作」，结束后在总结页脚显示用量", () => {
  assert.match(chatPanel, /summarizeTimeline\(runTimeline\)\.runningLabel/);
  assert.match(chatPanel, /· 当前：\$\{runningLabel\}/);
  assert.match(chatPanel, /className="tl-metrics"/);
  assert.match(styles, /\.tl-metrics \{[^}]*?font-size: 12px/);
});

await test("工具卡折叠态有结果摘要（读取行数 / exit / 失败首行）", () => {
  assert.match(chatPanel, /const resultText = String\(output \|\| tool\.result \|\| ""\)/);
  assert.match(chatPanel, /const exitMatch = resultText\.match/);
  assert.match(chatPanel, /className=\{`tool-result-chip/, "结果摘要徽标应渲染在工具卡头部");
  assert.match(styles, /\.tool-result-chip \{[^}]*?color: var\(--muted\)/);
  assert.match(styles, /\.tool-result-chip\.err \{ color: var\(--error\); \}/);
});

await test("工具卡按类型分叉：读（行号）/ 搜索（命中）/ 命令（终端）/ 文件路径", () => {
  assert.match(chatPanel, /const TOOL_KIND_RULES = \[/);
  assert.match(chatPanel, /function toolKindOf\(name\)/);
  assert.match(chatPanel, /className="tool-read-lines"/);
  assert.match(chatPanel, /className="tool-search-hits"/);
  assert.match(chatPanel, /className=\{`tool-terminal/, "命令类工具应使用终端块");
  assert.match(chatPanel, /className="tool-path"/, "带文件路径的工具应可点击打开");
  assert.match(chatPanel, /onOpenFile=\{onOpenFile\}/, "ToolCard 应接收 onOpenFile");
  assert.match(styles, /\.tool-read-lines \{[^}]*?max-height: 260px/);
  assert.match(styles, /\.tool-terminal \{[^}]*?max-height: 280px/);
});

await test("多轮 Run 的过程按 turn 分组（只留间距、不显示轮次标签）", () => {
  assert.match(chatPanel, /assignTimelineTurns\(runTimeline, timelineEventsSource\)/);
  // 2026-11-12：时间流按「过程 / 结构化小节」二分——结构化小节提到折叠体外，
  // 折叠体只渲染过程条目；两处都必须走同一个 renderTimelineItem 渲染器。
  assert.match(chatPanel, /assignTimelineTurns\(runTimeline, timelineEventsSource\)/);
  assert.match(chatPanel, /foldTimelineItems\.map\(renderTimelineItem\)/, "折叠体内应渲染过程条目");
  assert.match(chatPanel, /liftedTimelineItems\.map\(renderTimelineItem\)/, "结构化小节应在折叠体外渲染");
  assert.match(chatPanel, /case "turn-divider":/);
  // 视觉上不出现「第 N 轮」文字/分隔线；轮次只通过 aria-label 给读屏
  assert.match(chatPanel, /aria-label=\{`第 \$\{item\.turn\} 轮`\}/);
  assert.doesNotMatch(chatPanel, /<span>第 \{item\.turn\} 轮<\/span>/, "不得显示轮次文字");
  assert.doesNotMatch(styles, /\.tl-turn-sep::before/, "不得画轮次分隔线");
  const rule = styles.match(/\.tl-turn-sep \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /margin: 2px 0 1px/, "轮次之间只留极小间距（2026-11-07 二次压缩）");
  // 步数仍按未分组条目计算，分隔行不计入
  assert.match(chatPanel, /steps=\{runTimeline\.length\}/);
});

await test("折叠头 failed 判定有 runStatus 兜底（缺 runCardView 的历史失败轮）", () => {
  assert.match(chatPanel, /String\(runSummary\?\.runStatus \|\| m\.runStatus \|\| ""\)\.toLowerCase\(\) === "failed"/);
});

await test("未决 ask / 审批渲染在折叠体之外", () => {
  const foldStart = chatPanel.indexOf("<RunFoldBar");
  const foldEnd = chatPanel.indexOf("</RunFoldBar>");
  assert.ok(foldStart > 0 && foldEnd > foldStart, "未找到 RunFoldBar 使用点");
  assert.doesNotMatch(chatPanel.slice(foldStart, foldEnd), /renderTimelineInteraction/, "ask/审批不得进折叠体");
  // 2026-11-17-001：v3 折叠体之后合法存在 lifted 小节与终稿渲染段（约 2.2k 字符），
  // "紧跟折叠体"的实质是「折叠体外常显」，窗口按融合后结构放宽到 2400。
  assert.match(chatPanel.slice(foldEnd, foldEnd + 2400), /renderTimelineInteraction/, "未决交互应紧跟折叠体之后常显");
});

await test("会话流 v3 渲染契约（2026-11-17-001 B/C/D 项）", () => {
  // B：v3 不渲染「阶段小结」标签——showCap 由 !transcriptV3 门控（基线保持原标签）。
  assert.match(chatPanel, /const showCap = !transcriptV3 && !isStreamingText && String\(item\.text \|\| ""\)\.trim\(\)\.length >= 8 && isNarrationText\(item\.text\);/, "v3 应去掉阶段小结标签（showCap 需 !transcriptV3 门控）");
  // C：v3 折叠体内过程旁白正文 13px/1.7，且 :not(.tl-list-replies) 排除终稿（结论保持 14px）。
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-list:not\(\.tl-list-replies\) \.textblock \.markdown-body \{[^}]*font-size: 13px;/, "v3 过程旁白正文应为 13px");
  assert.match(styles, /font-size: 13px;[\s\S]{0,40}?line-height: 1\.7;/, "v3 过程旁白行高 1.7");
  // D：v3 终稿保留分节编号；目录条/复制按钮按 2026-11-18-001 D1 去掉（对话内结论不做文档页眉形态）。
  assert.match(chatPanel, /className="textblock flow-markdown assistant-final-answer"[\s\S]{0,120}?numberSections/, "v3 终稿应带 numberSections 编号");
  assert.doesNotMatch(chatPanel, /numberSections docToc/, "对话内终稿不得再传 docToc（目录条/复制按钮已移除）");
  assert.match(chatPanel, /\{showTimelineSummary && !transcriptV3 && \([\s\S]{0,80}?<SummaryBlock/, "v3 下不得渲染「本轮总结」卡片");
});

await test("已完成轮次内缺终态的工具行中性显示（2026-11-17-001 E 项）", () => {
  assert.match(chatPanel, /const pendingUnknown = settled && !done;/, "ToolCard 应有未结转判定");
  assert.match(chatPanel, /settled=\{!isTaskLive\}/, "时间流工具行应按消息运行态传入 settled");
  assert.match(chatPanel, /\{pendingUnknown && <span className="tool-recovered"[^>]*>未结转<\/span>\}/, "未结转标识");
  assert.match(styles, /\.tool-icon\.unknown \{ color: var\(--dim\); animation: none; \}/, "未结转图标不得跑动画");
});

await test("v3 折叠体内旁白与组头同轴对齐（2026-11-19-001 统一网格）", () => {
  // 2026-11-19：旁白文字左缘不再用 0 / 38px，统一取 --tl-lead（12 chevron + 8 + 16 icon + 8），
  // 与组头 label、思考 verb、工具 phrase 共用同一网格。
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-list:not\(\.tl-list-replies\) \.textblock \{\s*padding: 2px 8px 4px var\(--tl-lead\);\s*\}/, "v3 折叠体内旁白左内边距应为 var(--tl-lead)");
});

await test("过程行统一网格 --tl-lead 与三层左缘（2026-11-19-001）", () => {
  assert.match(styles, /--tl-lead: 44px;/, "应有统一网格令牌 --tl-lead: 44px");
  // 组头：12px chevron 占位 + 16px 圆点槽 + gap 8
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-group-head \{[^}]*?gap: 8px;/, "组头 gap 应为 8px");
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-group-chev-lead \{ flex: 0 0 12px; width: 12px; \}/, "组头需 12px chevron 占位");
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-group-dot-slot \{[^}]*?width: 16px;[^}]*?height: 16px;/, "圆点需包进 16px 居中槽");
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-group-dot \{[^}]*?margin-left: 0;/, "圆点不再自带 margin-left");
  // 工具行：12px 占位 + 状态/语义并入 16px 图标列
  assert.match(styles, /\.tool-chevron-lead \{ flex: 0 0 12px; width: 12px; \}/, "工具行需 12px chevron 占位");
  assert.match(styles, /\[data-transcript-v3="1"\] \.tool-header \{[^}]*?gap: 8px;/, "工具行 gap 应为 8px");
  assert.match(chatPanel, /\{v3 && <span className="tool-chevron-lead" aria-hidden="true" \/>\}/, "v3 工具行应渲染左侧占位");
  // 完成态/失败态语义图标与运行态 spinner 共用同一图标列
  assert.match(chatPanel, /tool-icon \$\{done \? \(isError \? "err" : ""\)/, "v3 图标列应同时承担状态与语义");
});

await test("过程区两层竖线均已去掉（2026-11-19 用户口径）", () => {
  const listRule = styles.match(/^\.tl-list \{[^}]*\}/m)?.[0] || "";
  assert.ok(listRule, "未找到 .tl-list 规则");
  assert.doesNotMatch(listRule, /border-left/, "外层 .tl-list 不得再画竖线");
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-group-body \{\s*border-left: 0;\s*margin-left: 0;\s*padding-left: 0;\s*\}/, "组体不得再缩进或画竖线");
});

await test("思考预览不跟随多彩配色（2026-11-19-001）", () => {
  assert.match(styles, /\.tl-think-preview \.marquee \{ --marquee-a: currentColor; --marquee-b: currentColor; \}/, "思考预览的跑马灯两端色应取 currentColor");
});

await test("v3 过程流不显示横向分割线（2026-11-18 用户口径）", () => {
  assert.doesNotMatch(styles, /\[data-transcript-v3="1"\] \.tl-row-head \{[^}]*border-bottom/, "v3 行头不得有横向分割线");
  assert.doesNotMatch(styles, /\[data-transcript-v3="1"\] \.tool-card \{[^}]*border-bottom/, "v3 工具卡不得有横向分割线");
  // 基线 .tool-detail 自带 border-top:1px，v3 必须显式归零（只删自己的规则会让基线露出来）。
  assert.match(styles, /\[data-transcript-v3="1"\] \.tool-detail \{[^}]*border-top: 0;/, "v3 工具明细必须显式去掉基线 border-top");
});

await test("v3 思考行与工具行同色（2026-11-18 用户口径）", () => {
  assert.match(styles, /\[data-transcript-v3="1"\] \.tl-row-think \.tl-verb,\s*\[data-transcript-v3="1"\] \.tl-row-think \.tl-obj \{ color: var\(--muted\); font-size: 12\.5px; \}/, "思考行动作词应与工具行同色（--muted）");
  assert.doesNotMatch(styles, /\[data-transcript-v3="1"\] \.tl-row-think[^}]*color: var\(--dim\)/, "思考行不得再用 --dim 区分");
});

await test("工具行完成态不显示对勾（2026-11-18 用户口径）", () => {
  assert.match(chatPanel, /done \? \(isError && \(\s*<span className="tool-icon err">/, "完成态只保留失败标记，成功不再渲染对勾");
  assert.match(chatPanel, /blockIndex <= stopIndex/, "终稿之后的块不得再进入过程流");
});

await test("结论区本地图片走文件服务地址（2026-11-17-002）", () => {
  const md = read("client/src/components/MarkdownBody.jsx");
  // img 渲染必须经 resolveImgSrc 改写：本地文件 → /api/doc/<rel>/raw?cwd=...
  assert.match(md, /function resolveImgSrc\(src, cwd\)/, "应有图片地址改写函数");
  assert.match(md, /normalizeLocalFileHref\(value\)/, "本地文件判定走产物类型白名单");
  assert.match(md, /buildDocUrls\(\{ cwd, relativePath: rel \}\)\.raw/, "改写目标为文件服务 raw 路由");
  assert.match(md, /resolveImgSrc\(src, handlersRef\.current\.cwd\)/, "img 组件经 handlersRef 取 cwd");
  // 会话流链路：ChatPanel → Message → SafeMarkdown → MarkdownBody 逐层传 cwd
  assert.match(chatPanel, /function SafeMarkdown\(\{ text, onOpenFile, artifacts, numberSections = false, docToc = false, cwd = "" \}\)/, "SafeMarkdown 应支持 cwd");
  assert.match(chatPanel, /<MarkdownBody onOpenFile=\{onOpenFile\} artifacts=\{artifacts\} numberSections=\{numberSections\} docToc=\{docToc\} copyable=\{docToc\} cwd=\{cwd\}>/, "SafeMarkdown 应把 cwd 透传给 MarkdownBody");
  assert.match(chatPanel, /cwd=\{workspace\}\s*\/>/, "Message 内 SafeMarkdown 调用点应传 cwd={workspace}");
  assert.match(chatPanel, /sessionId=\{sessionId\} workspace=\{workspace\}/, "ChatPanel 应把 workspace 传给 Message");
  // 灯箱用改写后的地址（本地路径点击放大不再破图）
  assert.match(md, /setLightbox\(\{ src: shown, alt/, "灯箱应使用改写后的地址");
});

await test("结论区两条渲染路径都透传 cwd，图片尺寸有上限（2026-11-19-001）", () => {
  // 非 v3 路径：SummaryBlock 自身接收 cwd 并传给 MarkdownBody；ChatPanel 调用点传入 workspace。
  assert.match(summaryBlock, /export default function SummaryBlock\(\{ body = "", onOpenFile = null, artifacts = null, cwd = "" \}\)/, "SummaryBlock 应接收 cwd");
  assert.match(summaryBlock, /numberSections cwd=\{cwd\}/, "SummaryBlock 应把 cwd 透传给 MarkdownBody");
  assert.match(chatPanel, /<SummaryBlock[\s\S]{0,220}?cwd=\{workspace\}/, "ChatPanel 调用 SummaryBlock 时应传 cwd={workspace}");
  // 尺寸契约：宽度跟随内容列，单图不超过 60vh。
  assert.match(styles, /\.md-img \{ max-width: 100%; max-height: 60vh;/, "结论区图片应有 max-width 100% + max-height 60vh");
  // 提示词：涉及截图/示意图时用 Markdown 图片引用，不只给路径文本。
  const agent = read("server/agent.mjs");
  assert.match(agent, /图片引用[^\n]*!\[[^\]]*\]\(工作区相对路径\)/, "输出规范应要求用 Markdown 图片引用");
});

await test("结论与产物卡不在折叠体内", () => {
  const foldStart = chatPanel.indexOf("<RunFoldBar");
  const foldEnd = chatPanel.indexOf("</RunFoldBar>");
  const foldBody = chatPanel.slice(foldStart, foldEnd);
  assert.doesNotMatch(foldBody, /<SummaryBlock/, "结论正文必须常显");
  assert.doesNotMatch(foldBody, /<ArtifactCard/, "产物卡必须常显");
});

await test("折叠过渡写在统一动效闸门之前", () => {
  const gate = styles.indexOf("P3 · 统一动效闸门");
  assert.ok(gate > 0, "样式表应包含统一动效闸门");
  assert.ok(styles.indexOf(".run-fold-body {") > 0 && styles.indexOf(".run-fold-body {") < gate);
  assert.match(styles, /\.run-fold-body \{[^}]*?grid-template-rows: 0fr/);
  assert.match(styles, /\.run-fold\.open \.run-fold-body \{[^}]*?grid-template-rows: 1fr/);
});

await test("折叠头不新增无限动画", () => {
  const foldCss = styles.slice(styles.indexOf(".run-fold {"), styles.indexOf("/* 框外总结"));
  assert.ok(foldCss.length > 0, "未找到折叠头样式段");
  assert.doesNotMatch(foldCss, /animation:/, "折叠头只能靠 chevron 旋转与行过渡");
});

await test("折叠头与其它块共用消息列宽", () => {
  assert.match(styles, /\.msg\.assistant \.msg-main \.run-fold,/);
});

await test("chevron 紧跟文字，不推到列宽最右端", () => {
  const rule = styles.match(/^\.run-fold-chev \{[^}]*\}/m)?.[0] || "";
  assert.ok(rule, "未找到 .run-fold-chev 规则");
  assert.doesNotMatch(rule, /margin-left: auto/, "推右会让指示符在 720px 列里与内容脱节");
});

await test("步数带分隔符，读屏不会把「43 秒48 步」连读", () => {
  assert.match(runFoldBar, /<span className="run-fold-steps">· \{steps\} 步<\/span>/);
});

await test("旧过程折叠与 Run 折叠头同形态：无边框 / 背景 / 字符箭头", () => {
  const rule = styles.match(/\.message-process-fold \{[^}]*\}/)?.[0] || "";
  assert.ok(rule, "未找到 .message-process-fold 规则");
  assert.doesNotMatch(rule, /border:/, "不应有外边框（规范 §2 / §11 禁止运行框）");
  assert.doesNotMatch(rule, /background:/, "不应有背景块（规范 §2 / §11）");
  assert.doesNotMatch(styles, /content: "›"/, "不应使用字符箭头（规范 §2.1，统一走 Icon）");
  const summaryRule = styles.match(/\.message-process-fold > summary \{[^}]*\}/)?.[0] || "";
  assert.match(summaryRule, /font-size: 12px/, "摘要行应回到 12px 档");
});

console.log("\n▶ 字号档位（规范 v2.0 §4）");

await test("会话流字号只允许 12 / 14 / 16（v3 另允许 12.5 / 13）", () => {
  const start = styles.indexOf("/* 时间流 */");
  const end = styles.indexOf("/* 本轮产物卡 */");
  assert.ok(start > 0 && end > start, "未找到会话流样式段");
  const sizes = [...styles.slice(start, end).matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
  assert.ok(sizes.length > 0, "会话流段应声明字号");
  for (const size of sizes) {
    assert.ok(["12px", "14px", "16px"].includes(size), `会话流出现了档位外的字号：${size}`);
  }
});

// 2026-11-18：v3 段一直落在上一段扫描范围之外，导致 11px 越档长期"假绿"（审查 P0-5）。
await test("会话流 v3 段字号只允许 12 / 12.5 / 13 / 14 / 16", () => {
  const start = styles.indexOf("/* ===== 会话流 v3");
  const end = styles.indexOf("/* ==========================================================================", start);
  assert.ok(start > 0 && end > start, "未找到会话流 v3 样式段");
  const sizes = [...styles.slice(start, end).matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
  assert.ok(sizes.length > 0, "会话流 v3 段应声明字号");
  for (const size of sizes) {
    assert.ok(
      ["12px", "12.5px", "13px", "14px", "16px"].includes(size),
      `会话流 v3 出现了档位外的字号：${size}（规范 §4）`,
    );
  }
});

await test("会话流次级明细字号下限 12px（工具卡 / 审批 / 子代理 / 流水线）", () => {
  const floorStart = styles.indexOf("会话流字号下限");
  const floorEnd = styles.indexOf("本轮用量", floorStart);
  assert.ok(floorStart > 0 && floorEnd > floorStart, "应有一层「会话流字号下限」规则并标明结束锚点");
  const floor = styles.slice(floorStart, floorEnd);
  for (const selector of [
    ".tool-card", ".tool-icon", ".tool-phrase", ".tool-code", ".cmd-code", ".tool-duration",
    ".ask-receipt", ".ask-status", ".approval-status", ".approval-scope",
    ".subagent-card", ".subagent-card-title small",
    ".pipeline-card-title small", ".pipeline-card-status",
    ".browser-steps-card", ".run-result-action", ".msg-streaming-status",
  ]) {
    assert.ok(floor.includes(selector), `字号下限规则应覆盖 ${selector}`);
  }
  const sizes = [...floor.matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
  for (const size of sizes) {
    assert.ok(["12px", "14px", "16px"].includes(size), `字号下限规则里出现了档位外字号：${size}`);
  }
});

await test("思考正文回到 14px / --text（规范 §4）", () => {
  const rule = styles.match(/\.tl-thinking-text \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /font-size: 14px/, "思考正文应为 14px");
  assert.match(rule, /color: var\(--text\)/, "思考正文应使用正文色");
});

await test("会话流不再使用 em 相对字号", () => {
  const start = styles.indexOf("/* 时间流 */");
  const end = styles.indexOf("/* 本轮产物卡 */");
  assert.doesNotMatch(styles.slice(start, end), /font-size:\s*[0-9.]+em/);
  assert.doesNotMatch(styles, /\.markdown-body h[1-6] \{[^}]*?font-size: [0-9.]+em/, "标题必须用 px，否则会随宿主滚出非整数档");
});

await test("行内代码回到正文色，绿色只留给图标与状态", () => {
  const rule = styles.match(/\.markdown-body code \{[^}]*\}/)?.[0] || "";
  assert.ok(rule, "未找到 .markdown-body code 规则");
  assert.match(rule, /color: var\(--text\)/);
  assert.doesNotMatch(rule, /var\(--accent\)/);
});

console.log(failed ? "\n✗ 会话流排版回归存在失败项\n" : "\n✓ 会话流排版回归全部通过\n");
process.exit(failed ? 1 : 0);
