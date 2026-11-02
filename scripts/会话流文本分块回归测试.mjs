#!/usr/bin/env node
/**
 * 会话流文本分块回归测试
 *
 * 覆盖「模型的一次连续输出被工具调用切断」这一类渲染错乱：
 * 模型输出 text → 调工具 → 继续输出 text，界面上同一句话会裂成几截
 * （前半句在工具卡前、后半句在工具卡后，末段常常只剩一两个字）。
 *
 * 真实事故样本（2026-11-02，景宁县新能源重卡报告会话）：
 *   前半段「明白，做一个 demo 级精简版。我按景宁县新能源重卡充换电方向写，
 *   先读工作区素材拿真实数」+ 工具卡 + 孤立尾巴「据。」
 *
 * 本测试**直接跑渲染用的纯函数**（client/src/components/流式文本队列.js），
 * 不是断言源码字符串——源码断言对这类运行时行为无效。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  追加文本块,
  并回上一段文本块,
  构建流式块序列,
  计算权威文本缺口,
} from "../client/src/components/流式文本队列.js";

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

const chatPanelSource = fs.readFileSync(new URL("../client/src/components/ChatPanel.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// 真实事故样本：同一句话被工具卡切成两截。
const 事故前半句 = "明白，做一个 demo 级精简版。我按景宁县新能源重卡充换电方向写，先读工作区素材拿真实数";
const 事故后半句 = "据。";
const 事故完整句 = "明白，做一个 demo 级精简版。我按景宁县新能源重卡充换电方向写，先读工作区素材拿真实数据。";

console.log("\n▶ 文本块不被工具卡切断");

test("工具卡插队时，未揭示的文本并回上一段而不是新开一块", () => {
  const blocks = 构建流式块序列([], [
    { kind: "text", text: 事故前半句 },
    { kind: "block", block: { type: "tool", id: "t1", name: "officecli" } },
    { kind: "text", text: 事故后半句 },
  ]);
  const texts = blocks.filter((block) => block.type === "text");
  assert.equal(texts.length, 1, `同一句话应只有一段 text 块，实际 ${texts.length} 段`);
  assert.equal(texts[0].text, 事故完整句, "文本块内容应是完整的一句话");
  assert.equal(blocks.length, 2, "工具卡与文本块应各占一块");
  assert.equal(blocks[1].type, "tool", "工具卡应排在文本之后");
});

test("工具卡前后的文本各自成段（模型真的分段输出时不合并）", () => {
  const blocks = 构建流式块序列([], [
    { kind: "text", text: "第一段结论。" },
    { kind: "block", block: { type: "tool", id: "t1", name: "read" } },
    { kind: "text", text: "第二段小结。" },
  ]);
  const texts = blocks.filter((block) => block.type === "text");
  assert.equal(texts.length, 2, "两段独立输出应保留为两段");
  assert.equal(texts[0].text, "第一段结论。");
  assert.equal(texts[1].text, "第二段小结。");
});

test("没有工具插入时，文本连续并入同一块", () => {
  const blocks = 构建流式块序列([], [
    { kind: "text", text: "前半" },
    { kind: "text", text: "后半。" },
  ]);
  assert.equal(blocks.length, 1, "连续文本应只有一块");
  assert.equal(blocks[0].text, "前半后半。");
});

test("子代理卡与流水线卡同样不能切断句子", () => {
  for (const block of [
    { type: "subagent", id: "s1" },
    { type: "pipeline", id: "p1" },
    { type: "ask", id: "a1" },
    { type: "approval", id: "ap1" },
  ]) {
    const blocks = 构建流式块序列([], [
      { kind: "text", text: 事故前半句 },
      { kind: "block", block },
      { kind: "text", text: 事故后半句 },
    ]);
    const texts = blocks.filter((item) => item.type === "text");
    assert.equal(texts.length, 1, `${block.type} 卡不应切断句子`);
    assert.equal(texts[0].text, 事故完整句, `${block.type} 卡后的文本应并回上一段`);
  }
});

console.log("\n▶ 并回上一段文本块");

test("并回上一段：跨越工具卡找到最近的 text 块", () => {
  const blocks = 并回上一段文本块(
    [{ type: "text", text: "旧段。" }, { type: "tool", id: "t1" }],
    "补上的尾巴",
  );
  assert.equal(blocks[0].text, "旧段。补上的尾巴", "尾巴应并回上一段 text 块");
  assert.equal(blocks.length, 2, "不应新增块");
});

test("并回上一段：没有 text 块时新开一块", () => {
  const blocks = 并回上一段文本块([{ type: "tool", id: "t1" }], "首段");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "text");
  assert.equal(blocks[1].text, "首段");
});

test("追加文本块：尾部是 text 就并入，否则新开", () => {
  const merged = 追加文本块([{ type: "text", text: "甲" }], "乙");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "甲乙");
  const fresh = 追加文本块([{ type: "tool", id: "t1" }], "丙");
  assert.equal(fresh.length, 2);
  assert.equal(fresh[1].text, "丙");
});

console.log("\n▶ 权威全文补齐的缺口定位");

test("缺口相对已入队文本定位，不用已揭示长度", () => {
  // queued = 已揭示 + 待揭示；权威全文以 queued 为前缀。
  const gap = 计算权威文本缺口("甲乙丙丁", "甲乙");
  assert.equal(gap.mode, "suffix");
  assert.equal(gap.missing, "丙丁");
});

test("已入队内容就是权威全文时不追加", () => {
  const gap = 计算权威文本缺口("甲乙", "甲乙");
  assert.equal(gap.mode, "none");
  assert.equal(gap.missing, "");
});

test("尚未入队任何文本时允许从权威全文重播", () => {
  const gap = 计算权威文本缺口("甲乙", "");
  assert.equal(gap.mode, "replay");
  assert.equal(gap.missing, "甲乙");
});

test("权威全文不包含已入队文本时保留已显示内容（多回合累积）", () => {
  const gap = 计算权威文本缺口("另一轮的结论。", "本轮已入队");
  assert.equal(gap.mode, "conflict");
  assert.equal(gap.missing, "");
});

test("权威全文包含已入队文本但不在开头时取包含之后的部分", () => {
  const gap = 计算权威文本缺口("前缀甲乙", "甲乙");
  assert.equal(gap.mode, "suffix");
  assert.equal(gap.missing, "");
});

console.log("\n▶ 组件接线");

test("工具/子代理/流水线/交互卡插队前都要排空文本缓冲", () => {
  const flushCalls = chatPanelSource.match(/flushTextReveal\(aid\)/g) || [];
  assert.ok(flushCalls.length >= 4, `至少 4 处插队点需要排空文本缓冲，实际 ${flushCalls.length} 处`);
  for (const marker of ['case "tool_start":', 'case "subagent_start":', 'case "pipeline_started":', 'case "ask_user":']) {
    assert.ok(chatPanelSource.includes(marker), `应保留事件分支 ${marker}`);
  }
});

test("排空文本缓冲的实现并回上一段而不是新开一块", () => {
  assert.match(
    chatPanelSource,
    /const blocks = 追加流式文本块\(\[\.\.\.\(m\.blocks \|\| \[\]\)\], chunk\)/,
    "flushTextReveal 应把缓冲并回同句文本块",
  );
  assert.match(
    chatPanelSource,
    /blocks: 追加流式文本块\(\[\.\.\.\(m\.blocks \|\| \[\]\)\], active\.pending\)/,
    "取消打字机时保留文本也应走同句合并",
  );
});

console.log(failed ? `\n会话流文本分块回归：${passed} 例通过，存在失败` : `\n会话流文本分块回归：${passed} 例全部通过`);
process.exitCode = failed ? 1 : 0;
