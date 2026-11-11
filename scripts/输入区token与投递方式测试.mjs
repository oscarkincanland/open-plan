#!/usr/bin/env node
/**
 * 输入区 token 与投递方式回归测试（计划 2026-11-11-005）。
 *
 * 覆盖三件事：
 *   1. 图片 / 附件 / 引用不再作为输入卡兄弟节点飘在卡外，统一收进卡内 token 行；
 *   2. `@文件` 等结构化标记不再写进输入框（只登记为 token），发送时由
 *      expandReferenceMarkers 展开成标记，会话重开时气泡再把标记还原成 chip；
 *   3. 忙碌态「立即执行 / 排队执行 / 注入上下文」三态折叠为一个控件，
 *      不再常驻一整行的「当前任务中新输入：」按钮条。
 *
 * 用法: node scripts/输入区token与投递方式测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error?.message || error}`); failed = 1; }
}

const chat = read("client/src/components/ChatPanel.jsx");
const tokenBar = read("client/src/components/输入区/ComposerTokenBar.jsx");
const styles = read("client/src/styles.css");

console.log("输入区 token 与投递方式回归测试");

console.log("\n▶ token 行位置");

test("ChatPanel 渲染 ComposerTokenBar，且位于输入卡 .chat-input 内部", () => {
  assert.match(chat, /import ComposerTokenBar from "\.\/输入区\/ComposerTokenBar\.jsx"/, "缺少 ComposerTokenBar 导入");
  const cardAt = chat.indexOf('<div className="chat-input">');
  const barAt = chat.indexOf("<ComposerTokenBar");
  const targetAt = chat.indexOf('<div className="chat-target-bar"', cardAt);
  assert.ok(cardAt > 0, "未找到输入卡容器");
  assert.ok(barAt > cardAt, "token 行必须在输入卡内部（不再作为卡外兄弟节点）");
  assert.ok(targetAt > barAt, "token 行应排在「本轮目标」之上");
});

test("旧的三条卡外 chip 行不再渲染（图片 / 附件 / 引用）", () => {
  assert.doesNotMatch(chat, /<div className="img-preview-row">/, "图片预览行仍渲染在卡外");
  assert.doesNotMatch(chat, /<div className="att-preview-row">/, "附件行仍渲染在卡外");
  assert.doesNotMatch(chat, /<div className="reference-bar" aria-label="本轮引用">/, "引用行仍渲染在卡外");
});

test("token 由状态归一生成，引用/附件/图片都进同一行", () => {
  assert.match(chat, /const composerTokens = useMemo\(/, "缺少 composerTokens 归一");
  for (const key of ["image:", "attachment:", "reference:"]) {
    assert.ok(chat.includes(key), `缺少 ${key} 类型的 token`);
  }
  assert.match(tokenBar, /tokens\.map\(\(token\) => <ComposerToken/, "token 行未渲染 token");
  assert.match(tokenBar, /composer-token-remove/, "token 缺少移除入口");
});

console.log("\n▶ 引用标记与输入框分离");

test("composer 选中项不再把结构化标记写进输入框", () => {
  const start = chat.indexOf("const insertComposerItem = (item) => {");
  assert.ok(start > 0, "缺少 insertComposerItem");
  const block = chat.slice(start, chat.indexOf("// ===== 统一面板", start));
  assert.match(block, /parseReferenceMarkers\(item\.insert\)/, "未解析选中项里的标记");
  assert.match(block, /setReferences\(/, "标记未登记为引用");
  // 标记分支只登记引用、清掉未闭合的触发器；完整标记只允许出现在非标记项（如 `/` 命令）分支。
  const markerBranch = block.slice(block.indexOf("if (markers.length)"), block.indexOf("} else {"));
  assert.ok(markerBranch.length > 0, "未找到标记分支");
  assert.doesNotMatch(markerBranch, /item\.insert/, "标记分支仍把完整标记拼进输入框");
  assert.match(markerBranch, /composerMenu\.start/, "标记分支未清掉未闭合的触发器");
});

test("insertText 插入的是去标记后的自然语言", () => {
  const start = chat.indexOf("insertText(text) {");
  const block = chat.slice(start, chat.indexOf("insertContext(text)", start));
  assert.match(block, /stripReferenceMarkers\(text\)/, "未剥离结构化标记");
});

test("发送时按 references 展开标记，保证模型与会话记录仍带引用", () => {
  assert.match(chat, /function expandReferenceMarkers\(text = "", references = \[\]\)/, "缺少 expandReferenceMarkers");
  assert.match(chat, /const expandedText = expandReferenceMarkers\(rawText \|\| text, sendReferences\)/, "send 未展开引用标记");
  assert.match(chat, /const fullText = mentionPrefix \+ [\s\S]{0,200}expandedText/, "fullText 未使用展开后的文本");
});

test("气泡把标记还原成 chip（与 flag 解耦），并按 kind+target 去重", () => {
  assert.match(chat, /const bubbleReferences = isUser\b/, "气泡 references 仍按开关派生");
  assert.match(chat, /parseReferenceMarkers\(m\.text \|\| ""\)/, "气泡未从正文解析引用");
  assert.match(chat, /const bubbleText = isUser \? stripReferenceMarkers\(m\.text \|\| ""\) : m\.text/, "气泡未剥离标记");
});

test("引用同步不再因「输入里没有标记」清空 token 化引用", () => {
  const start = chat.indexOf("// 2026-11-11-005：输入框不再承载结构化标记");
  assert.ok(start > 0, "缺少引用同步的本次改动注释");
  const block = chat.slice(start, chat.indexOf("}, [input, composerUnified]);", start));
  assert.match(block, /textBound/, "缺少 textBound 判定，token 化引用会被误删");
  assert.doesNotMatch(block, /if \(!found\.length && !composerUnified\) return;/, "旧的提前 return 仍在（会跳过同步）");
});

console.log("\n▶ 忙碌态投递方式");

test("三态折叠为一个控件，含完整三项与单选语义", () => {
  assert.match(tokenBar, /export const BUSY_DELIVERY_MODES/, "缺少投递方式元数据");
  for (const mode of ["steer", "queue", "context"]) {
    assert.ok(tokenBar.includes(`mode: "${mode}"`), `缺少 ${mode} 模式`);
  }
  assert.match(tokenBar, /role="menuitemradio"/, "投递方式需要单选语义");
  assert.match(tokenBar, /aria-expanded=\{open\}/, "触发器需要 aria-expanded");
  assert.match(tokenBar, /if \(event\.key === "Escape"\) setOpen\(false\)/, "缺少 Esc 关闭");
});

test("旧「当前任务中新输入」整行按钮条已移除", () => {
  assert.doesNotMatch(chat, /className="busy-input-mode"/, "旧的忙时提示行仍在渲染");
  assert.match(chat, /<ComposerTokenBar[\s\S]{0,220}busyMode=\{busyInputMode\}/, "投递方式未接线到 token 行");
});

test("样式：token 与投递方式菜单存在，极矮窗口收起投递控件", () => {
  assert.match(styles, /\.composer-token-bar \{/, "缺少 token 行样式");
  assert.match(styles, /\.composer-token \{/, "缺少 token 样式");
  assert.match(styles, /\.busy-delivery-menu \{/, "缺少投递方式菜单样式");
  assert.match(styles, /\.composer-token-bar \.busy-delivery \{ display: none; \}/, "极矮窗口未收起投递控件");
});

if (failed) {
  console.error("输入区 token 与投递方式回归：未通过");
  process.exit(1);
}
console.log("输入区 token 与投递方式回归：通过");
