#!/usr/bin/env node
/**
 * P3-b 活动摘要行守护测试（开关 activitySummary / OAW_ACTIVITY_SUMMARY，默认关）：
 * 校验开关注册与快照下发、ChatPanel 聚合接线（默认关 = 工具卡照常平铺）、样式纯追加。
 * 用法: node scripts/activity-summary-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const flagsSource = read("server/运行开关.mjs");
const chatSource = read("client/src/components/ChatPanel.jsx");
const stylesSource = read("client/src/styles.css");
const pkg = JSON.parse(read("package.json"));

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
const test = (name, fn) => { try { fn(); ok(name); } catch (e) { fail(`${name}: ${e.message}`); } };

console.log("\n▶ 开关注册");
test("服务端开关 activitySummary 注册且默认关（无 readFlagWithDefault 兜底）", () => {
  assert.match(flagsSource, /activitySummary: readFlag\("OAW_ACTIVITY_SUMMARY"\)/);
  assert.doesNotMatch(flagsSource, /activitySummary: readFlagWithDefault/);
});
test("快照下发 activitySummary", () => {
  assert.match(flagsSource, /activitySummary: RUNTIME_FLAGS\.activitySummary/);
});

console.log("\n▶ ChatPanel 接线");
test("摘要行组件存在且摘要行含文字标题（非纯图标）", () => {
  assert.match(chatSource, /function ActivitySummaryRow/);
  assert.match(chatSource, /个工具调用/);
});
test("聚合仅在开关开启时生效，关闭走基线平铺", () => {
  assert.match(chatSource, /if \(!activitySummaryOn\) return items\.map\(renderProcessBlock\);/);
  assert.match(chatSource, /renderProcessItems\(segment\.items\)/);
});
test("聚合阈值：短串（<3 个连续工具卡）不聚合", () => {
  assert.match(chatSource, /ACTIVITY_SUMMARY_MIN_TOOLS = 3/);
  assert.match(chatSource, /toolRun\.length < ACTIVITY_SUMMARY_MIN_TOOLS/);
});
test("开关快照就绪前按关闭处理（ready 门）", () => {
  assert.match(chatSource, /activitySummaryReady && flag\("activitySummary"\)/);
});
test("明细经既有 renderProcessBlock 渲染（onToggle/折叠逻辑不变）", () => {
  assert.match(chatSource, /toolRun\.map\(\(item\) => renderProcessBlock\(item\)\)/);
});

console.log("\n▶ 样式与脚本");
test("styles.css 追加 activity-summary 样式块（纯追加）", () => {
  assert.match(stylesSource, /\.activity-summary-row \{ margin/);
  assert.match(stylesSource, /P3-b 活动摘要行/);
});
test("package.json 注册 test:activity-summary", () => {
  assert.equal(pkg.scripts["test:activity-summary"], "node scripts/activity-summary-test.mjs");
});

console.log(failed ? "\n活动摘要行测试：失败" : "\n活动摘要行测试：通过");
process.exit(failed);
