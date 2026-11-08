#!/usr/bin/env node
/**
 * 交互前端契约测试（2026-11-08 D2；计划 2026-11-08-001 §11、DESIGN §6.4/§6.5/§7、ADR-0026）
 *
 * 守护（静态 + 纯函数动态校验）：
 *   1) 交互组件存在：交互模型.js / InteractionDock.jsx / InteractionCard.jsx；
 *   2) ChatPanel 用 `flag("interactionHub")` + flagsReady 读取开关，默认关闭 = 基线行为；
 *   3) hub 开启时 ask_user 分支不再插入旧 `type:"ask"` 块（只留预览/等待态），避免双渲染；
 *   4) settle/assume 走 `/api/interactions/*`，成功后从待处理列表移除；
 *   5) Dock 最多 3 条摘要并显示"第 n/m 个"；倒计时只在最后 5 分钟出现；
 *   6) 卡片三形态（字段表单 / 选项+自由输入 / 草稿预览）与已决回执（含"改一下"）；
 *   7) styles.css 有交互坞/卡片样式且只用既有令牌；styles 窄屏不溢出。
 *
 * 用法: node scripts/交互前端契约测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error?.message || error}`);
  }
};

console.log("\n▶ 组件存在与开关接线");

const modelPath = "client/src/components/交互/交互模型.js";
const dockPath = "client/src/components/交互/InteractionDock.jsx";
const cardPath = "client/src/components/交互/InteractionCard.jsx";
const chatPath = "client/src/components/ChatPanel.jsx";

test("三个交互前端文件存在且非空", () => {
  for (const file of [modelPath, dockPath, cardPath]) {
    assert.ok(exists(file), `${file} 不存在`);
    assert.ok(read(file).trim().length > 500, `${file} 内容过少`);
  }
});

test("ChatPanel 用 flag(\"interactionHub\") 且 mount 后用 flagsReady 补读", () => {
  const chat = read(chatPath);
  assert.match(chat, /flag\("interactionHub"\)/, "缺少 flag(\"interactionHub\")");
  assert.match(chat, /flagsReady\.then\(apply\)/, "缺少 flagsReady.then 补读开关");
  assert.match(chat, /const \[interactionHub, setInteractionHub\] = useState\(false\)/, "开关默认必须为 false（关闭=基线）");
  assert.match(chat, /interactionHubRef\.current = interactionHub/, "缺少同步 ref，事件处理器读不到最新开关");
});

console.log("\n▶ hub 开启不双渲染旧 ask 块");

test("ask_user 分支先判 hub 开关，再走旧 ask 卡路径", () => {
  const chat = read(chatPath);
  const start = chat.indexOf('case "ask_user":');
  assert.ok(start > 0, "缺少 ask_user 分支");
  const end = chat.indexOf('case "tool_approval_request":', start);
  assert.ok(end > start, "ask_user 分支边界异常");
  const segment = chat.slice(start, end);
  const guard = segment.indexOf("if (interactionHubRef.current)");
  const legacyBlock = segment.indexOf('type: "ask"');
  assert.ok(guard > 0, "hub 开启守卫缺失");
  assert.ok(legacyBlock > guard, "旧 ask 块必须在守卫之后（hub 关闭才渲染）");
  assert.match(segment, /previewFile/, "hub 开启时仍应打开 previewFile 草稿预览");
  assert.match(segment, /setAgentPhase\("等待你的回答"\)/, "hub 开启时仍应保留等待状态");
});

test("历史水合/恢复路径也不再补旧 pending ask 卡", () => {
  const chat = read(chatPath);
  const reconcile = chat.indexOf("listPendingQuestions(clientId, threadId)");
  assert.ok(reconcile > 0, "缺少 pending ask 对账逻辑");
  const before = chat.slice(Math.max(0, reconcile - 1200), reconcile);
  assert.match(before, /if \(interactionHubRef\.current\) \{[\s\S]*?refreshInteractionsRef\.current\?\.\(\)/, "对账前缺少 hub 守卫");
});

console.log("\n▶ 交互事实源与提交接口");

test("进入会话/切线程时 GET /api/interactions 对账", () => {
  const chat = read(chatPath);
  assert.match(chat, /fetch\(`\/api\/interactions\?\$\{query\}`/, "缺少 GET /api/interactions");
  assert.match(chat, /const query = `client=\$\{encodeURIComponent\(clientId \|\| ""\)\}&thread=\$\{encodeURIComponent\(threadId \|\| ""\)\}`/, "缺少 client/thread 查询参数");
  assert.match(chat, /useEffect\(\(\) => \{[\s\S]*?setInteractions\(\(previous\) => \(previous\.length \? \[\] : previous\)\)[\s\S]*?refreshInteractions\(\)/, "切线程应清空并重新对账");
});

test("SSE interaction_* 事件只驱动交互列表（hub 关闭时忽略）", () => {
  const chat = read(chatPath);
  for (const type of ["interaction_open", "interaction_settled", "interaction_expired", "interaction_assumption"]) {
    assert.ok(chat.includes(`case "${type}"`), `缺少 ${type} 事件处理`);
  }
  assert.match(chat, /mergeInteractionEvent\(list, \{ type, data \}\)/, "缺少事件合并（去重）");
  assert.match(chat, /if \(!interactionHubRef\.current\) break;/, "hub 关闭时应忽略 interaction_* 事件");
});

test("settle 成功后从待处理列表移除，409 按失效处理", () => {
  const chat = read(chatPath);
  assert.match(chat, /\/api\/interactions\/\$\{encodeURIComponent\(id\)\}\/settle/, "缺少 settle 接口调用");
  assert.match(chat, /body: JSON\.stringify\(payload && typeof payload === "object" \? payload : \{\}\)/, "settle body 应为 answer/values/skip");
  assert.match(chat, /response\.status === 409/, "缺少 409 已失效处理");
  assert.match(chat, /setInteractions\(\(list\) => list\.filter\(\(item\) => item\.interactionId !== id\)\)/, "成功后应从列表移除");
});

test("onAssume 调 assume 接口并可更新回执假设", () => {
  const chat = read(chatPath);
  assert.match(chat, /\/api\/interactions\/\$\{encodeURIComponent\(id\)\}\/assume/, "缺少 assume 接口调用");
  assert.match(chat, /body: JSON\.stringify\(\{ assumption: text \}\)/, "assume body 应为 {assumption}");
  assert.match(chat, /setInteractionReceipts\(patchAssumption\)/, "assume 后应同步回执");
});

test("ChatPanel 渲染交互坞与消息流内交互卡片", () => {
  const chat = read(chatPath);
  const card = read(cardPath);
  assert.match(chat, /<InteractionDock[\s\S]*?onSettle=\{settleHubInteraction\}[\s\S]*?onAssume=\{assumeHubInteraction\}[\s\S]*?onLocate=\{locateHubInteraction\}/, "Dock 接线不完整");
  assert.match(chat, /<InteractionCard[\s\S]*?interaction=\{item\}/, "缺少消息流卡片渲染");
  assert.match(card, /data-interaction-id=\{item\.interactionId\}/, "卡片缺少定位锚点");
  assert.match(chat, /querySelectorAll\("\[data-interaction-id\]"\)/, "定位逻辑应查找卡片锚点");
});

console.log("\n▶ 交互模型纯函数（动态校验）");

const model = await import(new URL(`../${modelPath}`, import.meta.url));

test("kind 文案符合 DESIGN §6.4", () => {
  assert.equal(model.kindLabel("clarify"), "需要你补充");
  assert.equal(model.kindLabel("confirm"), "请确认");
  assert.equal(model.kindLabel("review"), "草稿已就绪");
  assert.equal(model.kindLabel("approval"), "需要审批");
});

test("优先级 approval > confirm > clarify > review", () => {
  assert.ok(model.KIND_PRIORITY.approval > model.KIND_PRIORITY.confirm);
  assert.ok(model.KIND_PRIORITY.confirm > model.KIND_PRIORITY.clarify);
  assert.ok(model.KIND_PRIORITY.clarify > model.KIND_PRIORITY.review);
  const sorted = model.sortInteractions([
    { interactionId: "r", kind: "review", status: "open", createdAt: "2026-11-08T00:00:00Z" },
    { interactionId: "a", kind: "clarify", status: "open", createdAt: "2026-11-08T00:00:01Z" },
    { interactionId: "p", kind: "approval", status: "open", createdAt: "2026-11-08T00:00:02Z" },
    { interactionId: "c", kind: "confirm", status: "open", createdAt: "2026-11-08T00:00:03Z" },
  ]);
  assert.deepEqual(sorted.map((item) => item.kind), ["approval", "confirm", "clarify", "review"]);
});

test("倒计时只在最后 5 分钟出现", () => {
  assert.equal(model.COUNTDOWN_WINDOW_MS, 5 * 60 * 1000, "窗口应为 5 分钟");
  const now = Date.parse("2026-11-08T12:00:00Z");
  const make = (seconds) => model.normalizeInteraction({ interactionId: `i${seconds}`, kind: "clarify", status: "open", expiresAt: new Date(now + seconds * 1000).toISOString() });
  assert.equal(model.countdownText(make(6 * 60), now), "", "还剩 6 分钟不应显示倒计时");
  assert.equal(model.countdownText(make(301), now), "", "还剩 5:01 不应显示倒计时");
  assert.equal(model.countdownText(make(299), now), "还剩 4:59", "最后 5 分钟应显示秒级倒计时");
  assert.equal(model.countdownText(make(-1), now), "", "已超时由状态文案表达，不重复倒计时");
});

test("事件去重合并：同一 interactionId 只保留一条", () => {
  const open = { type: "interaction_open", data: { interactionId: "itx_1", kind: "clarify", status: "open", runId: "run_1", priority: 10, payload: { question: "Q" } } };
  let list = model.mergeInteractionEvent([], open);
  list = model.mergeInteractionEvent(list, open);
  assert.equal(list.length, 1, "重复 open 应去重");
  const settled = model.mergeInteractionEvent(list, { type: "interaction_settled", data: { interactionId: "itx_1", reason: "assumed", assumption: "按默认口径" } });
  assert.equal(settled[0].status, "settled");
  assert.equal(settled[0].settledReason, "assumed");
  assert.equal(settled[0].assumption, "按默认口径");
  assert.match(model.receiptText(settled[0]), /已按假设继续/);
});

test("回执行文案覆盖 answered/skipped/assumed/expired", () => {
  const now = Date.now();
  const base = { interactionId: "itx_2", kind: "clarify", status: "open", expiresAt: new Date(now + 90000).toISOString() };
  assert.match(model.receiptText(model.normalizeInteraction({ ...base, status: "settled", settledReason: "answered", answer: "方案 A" })), /已回答：方案 A/);
  assert.match(model.receiptText(model.normalizeInteraction({ ...base, status: "settled", settledReason: "skipped" })), /已跳过/);
  assert.match(model.receiptText(model.normalizeInteraction({ ...base, status: "expired", settledReason: "expired" })), /已超时/);
});

test("Dock 最多 3 条摘要，并给出 n/m 总数", () => {
  assert.equal(model.DOCK_LIMIT, 3);
  const items = Array.from({ length: 5 }, (_, index) => ({ interactionId: `i${index}`, kind: "clarify", status: "open", createdAt: new Date(2026, 10, 8, 12, 0, index).toISOString() }));
  const summary = model.dockSummary(items);
  assert.equal(summary.items.length, 3, "最多 3 条");
  assert.equal(summary.total, 5, "总数用于 第 n/m 个");
});

console.log("\n▶ 组件行为静态契约");

test("Dock：空态不占位、显示第 n/m 个、倒计时仅最后 5 分钟", () => {
  const dock = read(dockPath);
  assert.match(dock, /if \(!summary\.total\) return null;/, "无交互时不占位");
  assert.match(dock, /第 \{index \+ 1\}\/\{summary\.total\} 个/, "缺少第 n/m 个");
  assert.match(dock, /COUNTDOWN_WINDOW_MS/, "倒计时窗口应复用模型常量");
  assert.match(dock, /countdownText\(item, now\)/, "缺少倒计时文案");
  assert.match(dock, /dockSummary\(interactions, DOCK_LIMIT\)/, "应复用模型排序/截断");
});

test("Card：三形态 + 已决回执 + 必填校验", () => {
  const card = read(cardPath);
  assert.match(card, /fields\.length \?/, "缺少字段表单形态");
  assert.match(card, /options\.length > 0/, "缺少选项形态");
  assert.match(card, /item\.previewFile/, "缺少草稿预览形态");
  assert.match(card, /请填写：\$\{missing\.label\}/, "缺少必填内联校验");
  assert.match(card, /receiptText\(item\)/, "缺少已决回执");
  assert.match(card, />改一下</, "假设回执缺少“改一下”入口");
  assert.match(card, /runSettle\(\{ skip: true \}\)/, "缺少跳过（按默认假设继续）");
  assert.match(card, /kind === "confirm"[\s\S]*?跳过/, "confirm 不得提供假设跳过（安全约束）");
});

console.log("\n▶ 样式与脚本接线");

test("styles.css 含交互坞/卡片样式且只用既有令牌", () => {
  const styles = read("client/src/styles.css");
  for (const selector of [".interaction-dock {", ".interaction-item {", ".interaction-card {", ".interaction-receipt {", ".interaction-card-list {"]) {
    assert.ok(styles.includes(selector), `缺少样式 ${selector}`);
  }
  const interactionStyles = styles.slice(styles.indexOf("/* ===== 人机协作中枢"));
  assert.match(interactionStyles, /border-radius: var\(--radius-lg\)/, "圆角应使用 --radius-lg");
  for (const token of ["--border", "--success", "--warning", "--danger", "--muted"]) {
    assert.ok(interactionStyles.includes(`var(${token})`), `样式应使用既有令牌 ${token}`);
  }
  assert.doesNotMatch(interactionStyles, /#[0-9a-fA-F]{3,8}\b/, "交互样式不得新增色值");
  assert.doesNotMatch(interactionStyles, /font-size: (10|11|13|16)px/, "字号只用 14/12 档");
  assert.match(interactionStyles, /@media \(max-width: 560px\)/, "缺少窄屏适配");
});

test("package.json 注册 test:interaction-ui", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts?.["test:interaction-ui"], "node scripts/交互前端契约测试.mjs");
});

console.log(failed ? "\n交互前端契约测试：存在失败项" : "\n交互前端契约测试：全部通过");
process.exit(failed ? 1 : 0);
