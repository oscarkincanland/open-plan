#!/usr/bin/env node
/**
 * 会话流滚动意图与折叠驱动测试（计划 2026-11-14-001 / 阶段 3–4）。
 *
 * 覆盖两端纯函数：
 *   - 滚动意图：阈值判定、手势中断、程序滚动不改变意图、锁定期冻结、恢复策略；
 *   - 折叠驱动：smoothstep 时序、解析式补偿、半屏 cap、帧间隔分位。
 * 不依赖 DOM（几何测量与 rAF 由浏览器侧负责），可在 Node 直接运行。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  FOLLOW_THRESHOLD_GRAY,
  FOLLOW_THRESHOLD_FINAL,
  distanceFromBottom,
  isNearBottom,
  createScrollIntent,
  restoreFollow,
} = await import(pathToFileURL(path.join(ROOT, "client", "src", "会话流", "滚动意图.js")).href);
const {
  FOLD_TIMING,
  clamp01,
  smoothstep,
  foldProgress,
  fadeProgress,
  planScrollTop,
  capOneShotShift,
  framePercentile,
} = await import(pathToFileURL(path.join(ROOT, "client", "src", "会话流", "折叠驱动.js")).href);

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

const metrics = (scrollTop, clientHeight = 400, scrollHeight = 1000) => ({ scrollTop, clientHeight, scrollHeight });

console.log("\n▶ 滚动意图");

test("阈值常量：灰度 40 / 目标 24，且目标更严格", () => {
  assert.equal(FOLLOW_THRESHOLD_GRAY, 40);
  assert.equal(FOLLOW_THRESHOLD_FINAL, 24);
  assert.ok(FOLLOW_THRESHOLD_FINAL < FOLLOW_THRESHOLD_GRAY);
});

test("距离底部：正常、越界、非法输入都不抛", () => {
  assert.equal(distanceFromBottom(metrics(600)), 0);
  assert.equal(distanceFromBottom(metrics(500)), 100);
  assert.equal(distanceFromBottom(metrics(2000)), 0);
  assert.equal(distanceFromBottom({}), 0);
  assert.equal(distanceFromBottom(metrics(Number.NaN)), 0);
});

test("贴底判定：40px 阈值含 1px 容差，超过即离开", () => {
  assert.equal(isNearBottom(metrics(559), 40), true, "距离 41px = 阈值 40 + 1px 容差");
  assert.equal(isNearBottom(metrics(558.5), 40), false, "距离 41.5px 已超出容差");
  assert.equal(isNearBottom(metrics(500), 40), false);
  // 24px 阈值更严格：距离 40px 在 40 阈值下贴底，在 24 下已算离开
  assert.equal(isNearBottom(metrics(560), 24), false);
  assert.equal(isNearBottom(metrics(584), 24), true, "距离 16px 在 24 阈值内");
});

test("初始为跟尾；滚远退出、滚回恢复", () => {
  const intent = createScrollIntent();
  assert.equal(intent.isFollowing(), true);
  assert.equal(intent.state(), "following");
  assert.equal(intent.onScroll(metrics(400)), false);
  assert.equal(intent.isFollowing(), false);
  assert.equal(intent.state(), "reader");
  assert.equal(intent.onScroll(metrics(560)), true);
  assert.equal(intent.isFollowing(), true);
});

test("用户手势立即退出跟尾（不等下一个 scroll 采样）", () => {
  const intent = createScrollIntent();
  intent.interrupt();
  assert.equal(intent.isFollowing(), false);
});

test("锁定期内滚动采样不得改变意图（程序滚动不误判）", () => {
  const intent = createScrollIntent();
  intent.lock();
  assert.equal(intent.onScroll(metrics(100)), true, "锁定期内应保持跟尾意图");
  assert.equal(intent.isFollowing(), true);
  intent.unlock();
  assert.equal(intent.onScroll(metrics(100)), false, "解锁后按位置重算");
});

test("lock/unlock 可嵌套，不会出现负数", () => {
  const intent = createScrollIntent();
  intent.lock();
  intent.lock();
  intent.unlock();
  assert.equal(intent.isLocked(), true);
  intent.unlock();
  assert.equal(intent.isLocked(), false);
  intent.unlock();
  assert.equal(intent.isLocked(), false);
});

test("回到底部按钮：toBottom 直接置回跟尾", () => {
  const intent = createScrollIntent();
  intent.interrupt();
  intent.toBottom();
  assert.equal(intent.isFollowing(), true);
});

test("阈值可运行时切换（灰度 40 → 24）", () => {
  const intent = createScrollIntent({ threshold: 40 });
  assert.equal(intent.threshold(), 40);
  intent.setThreshold(24);
  assert.equal(intent.threshold(), 24);
  assert.equal(intent.onScroll(metrics(559)), false, "24px 阈值下 41px 距离应视为离开");
  intent.setThreshold(-5);
  assert.equal(intent.threshold(), 24, "非法阈值不生效");
});

test("恢复策略：记录位置为 null 表示继续跟尾", () => {
  assert.equal(restoreFollow(null), true);
  assert.equal(restoreFollow(undefined), true);
  assert.equal(restoreFollow(0), false);
  assert.equal(restoreFollow(320), false);
});

console.log("\n▶ 折叠驱动");

test("时序常量与 DSH 一致：50 / 110 / 70", () => {
  assert.equal(FOLD_TIMING.delay, 50);
  assert.equal(FOLD_TIMING.duration, 110);
  assert.equal(FOLD_TIMING.fade, 70);
});

test("clamp01 / smoothstep 边界与单调性", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  const mid = smoothstep(0.5);
  assert.ok(mid > 0.49 && mid < 0.51, `smoothstep(0.5) 应约等于 0.5，实际 ${mid}`);
  let last = -1;
  for (let t = 0; t <= 1; t += 0.05) {
    const v = smoothstep(t);
    assert.ok(v >= last, "smoothstep 必须单调不减");
    last = v;
  }
});

test("高度进度：延迟期内为 0，结束为 1", () => {
  assert.equal(foldProgress(0), 0);
  assert.equal(foldProgress(49), 0);
  assert.equal(foldProgress(50), 0);
  assert.equal(foldProgress(160), 1);
  assert.equal(foldProgress(500), 1);
  const mid = foldProgress(105);
  assert.ok(mid > 0.4 && mid < 0.6, `中点应接近 0.5，实际 ${mid}`);
});

test("淡出进度：70ms 内到 1，之后保持 1", () => {
  assert.equal(fadeProgress(0), 0);
  assert.equal(fadeProgress(35), 0.5);
  assert.equal(fadeProgress(70), 1);
  assert.equal(fadeProgress(200), 1);
});

test("解析式补偿：scrollTop = top0 − height × progress", () => {
  assert.deepEqual(planScrollTop({ top0: 800, height: 400, progress: 0 }), { scrollTop: 800, shift: 0, unfulfilled: 0 });
  assert.deepEqual(planScrollTop({ top0: 800, height: 400, progress: 1 }), { scrollTop: 400, shift: 400, unfulfilled: 0 });
  const half = planScrollTop({ top0: 800, height: 400, progress: 0.5 });
  assert.equal(half.scrollTop, 600);
  assert.equal(half.shift, 200);
});

test("补偿不足时夹到 0 并报告未补足量", () => {
  const result = planScrollTop({ top0: 100, height: 400, progress: 1 });
  assert.equal(result.scrollTop, 0);
  assert.equal(result.unfulfilled, 300);
});

test("半屏 cap：一次性隐藏最多补半屏", () => {
  assert.equal(capOneShotShift(600, 400), 200, "600 > 半屏 200，应被 cap");
  assert.equal(capOneShotShift(120, 400), 120, "未超 cap 原样返回");
  assert.equal(capOneShotShift(120, 0), 120, "无视口高度时不 cap");
});

test("帧间隔分位：空数组为 0，能取到 P95", () => {
  assert.equal(framePercentile([], 0.95), 0);
  const frames = Array.from({ length: 100 }, (_, i) => i + 1);
  const p95 = framePercentile(frames, 0.95);
  assert.ok(p95 >= 95 && p95 <= 100, `P95 应落在 95–100，实际 ${p95}`);
});

console.log("\n▶ 代码接线");

test("折叠驱动不读几何（帧内只写不读，避免强制同步布局）", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "会话流", "折叠驱动.js"), "utf8");
  const runBody = source.slice(source.indexOf("export async function runFoldBatch"));
  assert.ok(!/getBoundingClientRect/.test(runBody), "runFoldBatch 帧内不得调用 getBoundingClientRect");
  assert.match(runBody, /requestAnimationFrame\(step\)/, "折叠应由 rAF 帧钟驱动");
});

test("滚动意图模块不依赖 DOM/React（纯逻辑可单测）", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "会话流", "滚动意图.js"), "utf8");
  assert.ok(!/from "react"/.test(source), "纯逻辑模块不应依赖 React");
  assert.ok(!/document\.|window\./.test(source), "纯逻辑模块不应直接访问 DOM");
});

console.log(failed ? "\n✗ 会话流滚动与折叠测试存在失败项\n" : "\n✓ 会话流滚动与折叠测试全部通过\n");
process.exit(failed ? 1 : 0);
