#!/usr/bin/env node
/**
 * 会话收敛与流水线状态测试（2026-11-03）
 *
 * 守护本轮用户可见行为：
 *   1) 流水线阶段态不再把 skipped/revise 画成失败叉号；
 *   2) 思考正文缩小字号，并在流式期间自动跟随尾部（打字机）；
 *   3) memory_update 之后不再弹 ask_user；
 *   4) 最终答复直接作为整体结论，结果卡不再重复压缩摘要；
 *   5) 流水线 Planner/Writer 使用独立内部角色，Writer 不再继承规划者人设。
 *
 * 说明：本仓库以前端源码契约 + 纯逻辑断言为主，配合浏览器冒烟。
 *
 * 用法：node scripts/会话收敛与流水线状态测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBAGENT_ROLES } from "../server/子代理编排器.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const chatPanel = read("client/src/components/ChatPanel.jsx");
const styles = read("client/src/styles.css");
const typewriter = read("client/src/components/会话流/useTypewriter.jsx");
const agent = read("server/agent.mjs");

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
};

/* ---------------- 1) 流水线阶段态 ---------------- */

test("阶段状态映射：skipped=跳过、revise=需修订、failed=失败、cancelled=已取消", () => {
  const start = chatPanel.indexOf("function pipelineStageMeta");
  assert.ok(start >= 0, "缺少 pipelineStageMeta");
  const source = chatPanel.slice(start, start + 900);
  assert.match(source, /\["skipped", "skip"\]/, "skipped 应有独立分支");
  assert.match(source, /icon: "minus", label: "跳过"/, "skipped 应显示减号+跳过，而不是叉号");
  assert.match(source, /\["revise", "needs_revision"\]/, "revise 应有独立分支");
  assert.match(source, /icon: "warning", label: "需修订"/, "revise 应显示警告色，而不是失败红");
  assert.match(source, /\["failed", "error"\]/, "failed 分支应保留");
  assert.match(source, /\["cancelled", "canceled", "aborted"\]/, "cancelled 分支应保留");
  assert.match(source, /icon: "stop", label: "已取消"/, "取消态应显示停止图标");
});

test("阶段行使用统一映射，不再按三态手写图标/文案", () => {
  assert.doesNotMatch(
    chatPanel,
    /stage\.status === "done" \|\| stage\.status === "pass" \|\| stage\.status === "completed" \? "check"/,
    "不应再保留旧的三态手写判断",
  );
  assert.match(chatPanel, /const meta = pipelineStageMeta\(stage\.status\)/, "阶段行应调用 pipelineStageMeta");
  assert.match(chatPanel, /className=\{`pipeline-stage \$\{meta\.tone\}`\}/, "阶段行 class 应使用 tone");
});

test("skipped/revise/cancelled 有独立样式，不再共用失败红", () => {
  assert.match(styles, /\.pipeline-stage\.skipped \.pipeline-stage-icon \{[^}]*var\(--dim\)/, "skipped 应为中性色");
  assert.match(styles, /\.pipeline-stage\.revise \.pipeline-stage-icon \{[^}]*var\(--warning\)/, "revise 应为警告色");
  assert.match(styles, /\.pipeline-stage\.failed \.pipeline-stage-icon \{[^}]*var\(--error\)/, "failed 保留错误色");
  assert.match(styles, /\.pipeline-stage\.cancelled \.pipeline-stage-icon/, "cancelled 应有独立样式");
});

/* ---------------- 2) 思考字号与跟随尾部 ---------------- */

test("思考正文使用 12px，比正文更小", () => {
  const match = styles.match(/\.tl-thinking-text \{[^}]*font-size: (\d+)px/);
  assert.ok(match, "找不到 .tl-thinking-text 字号");
  assert.equal(match[1], "12", "思考正文字号应为 12px");
});

test("思考文本做展示层空格/空行归一化，不再撑大字间距", () => {
  assert.match(chatPanel, /function normalizeThinkingText/, "缺少思考文本归一化");
  assert.match(chatPanel, /normalizeThinkingText\(item\.text\)/, "时间流路径应使用归一化文本");
  assert.match(chatPanel, /normalizeThinkingText\(block\.text\)/, "过程路径应使用归一化文本");
  const rule = styles.match(/\.tl-thinking-text \{[^}]*\}/)?.[0] || "";
  assert.match(rule, /white-space: pre-line/, "思考正文应使用 pre-line 折叠多余空白");
  assert.match(rule, /line-height: 1\.5/, "思考行距应收到 1.5");
  assert.match(rule, /letter-spacing: 0/, "思考正文不应额外字距");
});

test("打字机支持 autoScroll，并按用户滚动位置暂停/恢复跟随", () => {
  assert.match(typewriter, /autoScroll = false/, "TypewriterText 应接受 autoScroll");
  assert.match(typewriter, /followTailRef\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight <= 24/, "应在滚动时更新跟随意图");
  assert.match(typewriter, /if \(!autoScroll \|\| !el \|\| !followTailRef\.current\) return;\n\s*el\.scrollTop = el\.scrollHeight;/, "每次揭示后应滚到尾部");
});

test("实时思考在两个渲染路径都启用打字机+跟随尾部", () => {
  assert.match(chatPanel, /<TypewriterText text=\{thinkingText\} enabled autoScroll className="tl-thinking-text" \/>/, "时间流路径应启用");
  assert.match(chatPanel, /<TypewriterText text=\{text\} enabled autoScroll className="tl-thinking-text" \/>/, "折叠过程路径应启用");
});

/* ---------------- 3) memory_update 之后不再 ask_user ---------------- */

test("ask_user 在 memory_update 之后直接返回收尾提示", () => {
  const executeAt = agent.indexOf('name: "ask_user"');
  assert.ok(executeAt >= 0, "找不到 ask_user 定义");
  const source = agent.slice(executeAt, executeAt + 2200);
  assert.match(source, /if \(entry\.memoryWrittenThisRun\) \{/, "缺少 memory_update 后的守卫");
  assert.match(source, /不要再向用户提问；请直接用最终答复说明结果/, "守卫应引导模型直接收尾");
});

test("提示词要求 memory_update 后直接收尾", () => {
  assert.match(agent, /调用 memory_update 后直接收尾，不要再用 ask_user 追问/, "缺少提示词约束");
});

/* ---------------- 4) 最终答复即整体结论 ---------------- */

test("结果卡在存在最终答复时不再重复压缩摘要", () => {
  assert.match(
    chatPanel,
    /const fallbackSummary = finalAnswer \? "" : \(summaryText \|\| String\(m\.text \|\| ""\)\.trim\(\)\);/,
    "fallbackSummary 应在有终稿时为空",
  );
});

test("结论块优先使用模型终稿，而不是压缩摘要", () => {
  assert.match(chatPanel, /const timelineSummarySource = timelineFinalText \|\| timelineSummaryText;/, "应优先终稿");
  assert.match(chatPanel, /splitCompletionSummary\(finalTextIsSummary \? "" : timelineSummarySource, finalTextIsSummary \? timelineFinalText : ""\)/, "应把终稿交给结论块");
});

/* ---------------- 5) 流水线内部角色 ---------------- */

test("新增 pipeline_planner / pipeline_writer 两个只读内部角色", () => {
  for (const role of ["pipeline_planner", "pipeline_writer"]) {
    assert.ok(SUBAGENT_ROLES[role], `缺少角色 ${role}`);
    assert.equal(SUBAGENT_ROLES[role].readOnly, true, `${role} 应只读`);
    assert.ok(SUBAGENT_ROLES[role].tools.includes("read"), `${role} 应有 read`);
    assert.ok(!SUBAGENT_ROLES[role].tools.includes("write"), `${role} 不应有写工具`);
  }
  assert.match(SUBAGENT_ROLES.pipeline_writer.prompt, /完整正文/, "Writer 人设应要求完整正文");
  assert.doesNotMatch(SUBAGENT_ROLES.pipeline_writer.prompt, /输出简短/, "Writer 不应继承规划者「输出简短」人设");
});

test("编辑流水线按阶段注入对应角色，Writer 不再标成 planner", () => {
  assert.match(
    agent,
    /defaultRole: writer \? "pipeline_writer" : "pipeline_planner"/,
    "编辑流水线应按 writer 阶段选择内部角色",
  );
});

test("前端能显示两个内部角色标签", () => {
  assert.match(chatPanel, /pipeline_planner: "规划结构"/, "缺少规划结构标签");
  assert.match(chatPanel, /pipeline_writer: "撰写正文"/, "缺少撰写正文标签");
});

console.log(failed ? "\n会话收敛与流水线状态测试：存在失败项" : "\n会话收敛与流水线状态测试：全部通过（13 例）");
process.exit(failed ? 1 : 0);
