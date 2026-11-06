#!/usr/bin/env node
/**
 * 文档定位几何测试（2026-11-06）：守护「zoom 换算」这一确定性缺陷。
 *
 * 背景：Word 预览默认「适应宽度」会给滚动容器加 CSS zoom（常见 0.7–0.85）。
 * getBoundingClientRect() 返回**视觉像素**，而 scrollTop 是**布局像素**；
 * 旧实现直接相加导致系统性滚过头（zoom 0.7 → 多滚约 43%），
 * 表现为「目录点不准、批注越靠后偏得越多」。
 *
 * 本测试用伪 DOM 对象直接驱动 文档定位.js，不依赖浏览器/jsdom。
 * 用法: node scripts/文档定位测试.mjs
 */
import assert from "node:assert/strict";

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

// ── 伪 DOM ─────────────────────────────────────────────────────────────
let currentZoom = 1;
globalThis.getComputedStyle = (el) => ({ zoom: String(el?.__zoom ?? currentZoom) });

function fakeContainer({ top = 100, height = 600, scrollTop = 0, clientHeight = 600, scrollHeight = 4000, zoom = 1 } = {}) {
  const box = { top, height, left: 0, width: 800 };
  const calls = [];
  return {
    __zoom: zoom,
    scrollTop,
    clientHeight,
    scrollHeight,
    getBoundingClientRect: () => box,
    scrollTo: (opts) => { calls.push(opts); },
    scrollIntoView: () => { calls.push({ scrollIntoView: true }); },
    calls,
  };
}

function fakeEl({ top, height = 20 } = {}) {
  const calls = [];
  return {
    __calls: calls,
    getBoundingClientRect: () => ({ top, height, left: 0, width: 400 }),
    scrollIntoView: (opts) => { calls.push({ scrollIntoView: true, ...opts }); },
  };
}

const { readZoomFactor, scrollToElementInContainer } = await import("../client/src/components/文档定位.js");

console.log("\n▶ zoom 因子读取");
await test("未设置 zoom → 1", () => {
  assert.equal(readZoomFactor(fakeContainer({ zoom: 0 })), 1, "zoom=0 应回落为 1");
  assert.equal(readZoomFactor({ __zoom: "normal" }), 1, "非法 zoom 应回落为 1");
  assert.equal(readZoomFactor(null), 1, "空元素应返回 1");
});
await test("读取生效 zoom（0.7 / 1.25）", () => {
  assert.equal(readZoomFactor(fakeContainer({ zoom: 0.7 })), 0.7);
  assert.equal(readZoomFactor(fakeContainer({ zoom: 1.25 })), 1.25);
});

console.log("\n▶ 滚动换算（核心回归）");
await test("zoom=1：滚动量 = 视觉差值 - offset", () => {
  const container = fakeContainer({ top: 100, scrollTop: 0, zoom: 1 });
  const el = fakeEl({ top: 500 }); // 视觉差 400
  scrollToElementInContainer(container, el, { offset: 10 });
  assert.equal(container.calls.length, 1, "应产生一次滚动");
  assert.equal(container.calls[0].top, 390, `期望 400-10=390，实际 ${container.calls[0].top}`);
});

await test("zoom=0.7：滚动量按布局像素放大（400 视觉 → ~571 布局）", () => {
  const container = fakeContainer({ top: 100, scrollTop: 0, zoom: 0.7 });
  const el = fakeEl({ top: 500 });
  scrollToElementInContainer(container, el, { offset: 0 });
  // 400 / 0.7 = 571.43
  assert.ok(Math.abs(container.calls[0].top - 400 / 0.7) < 0.01, `期望 ${400 / 0.7}，实际 ${container.calls[0].top}`);
});

await test("旧实现的错误结果必须被明确排除（不能被写成 400）", () => {
  const container = fakeContainer({ top: 100, scrollTop: 0, zoom: 0.7 });
  const el = fakeEl({ top: 500 });
  scrollToElementInContainer(container, el, { offset: 0 });
  assert.notEqual(container.calls[0].top, 400, "zoom≠1 时不得直接使用视觉差值");
});

await test("在已有 scrollTop 基础上累加（相对滚动）", () => {
  const container = fakeContainer({ top: 100, scrollTop: 1000, zoom: 0.5 });
  const el = fakeEl({ top: 400 }); // 视觉差 300 → 布局 600
  scrollToElementInContainer(container, el, { offset: 0 });
  assert.equal(container.calls[0].top, 1600);
});

await test("center 模式：按容器高度居中，并做 zoom 换算", () => {
  const container = fakeContainer({ top: 100, height: 600, scrollTop: 0, zoom: 0.5 });
  const el = fakeEl({ top: 500, height: 100 }); // 视觉 delta = 400 - (600-100)/2 = 400-250 = 150 → 布局 300
  scrollToElementInContainer(container, el, { center: true });
  assert.equal(container.calls[0].top, 300);
});

await test("容器不可滚动时退化为 scrollIntoView", () => {
  const container = fakeContainer({ top: 100, clientHeight: 600, scrollHeight: 600, zoom: 1 });
  const el = fakeEl({ top: 200 });
  scrollToElementInContainer(container, el, { offset: 10 });
  assert.ok(el.__calls[0]?.scrollIntoView, "不可滚动容器应走 scrollIntoView");
  assert.equal(container.calls.length, 0, "不可滚动容器不应改 scrollTop");
});

await test("滚动目标不为负（顶部对齐）", () => {
  const container = fakeContainer({ top: 500, scrollTop: 0, zoom: 1 });
  const el = fakeEl({ top: 100 }); // delta = -400
  scrollToElementInContainer(container, el, { offset: 16 });
  assert.equal(container.calls[0].top, 0, "负数应夹到 0");
});

console.log("\n▶ 调用方契约（静态检查）");
await test("DocxViewer 不再自行计算滚动差值", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "client/src/components/DocxViewer.jsx"), "utf8");
  assert.match(src, /scrollToElementInContainer\(host, el/, "目录/页码滚动应走共享换算");
  assert.match(src, /scrollToElementInContainer\(hostRef\.current, el/, "跳页滚动应走共享换算");
  assert.doesNotMatch(src, /host\.scrollTop \+ \(rect\.top - base\.top\)/, "不应再出现未换算的视觉差值");
});
await test("CommentMarker 不再自行计算滚动差值，且按批注 id 匹配锚点", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "client/src/components/CommentMarker.jsx"), "utf8");
  assert.match(src, /scrollToElementInContainer\(scroller, el/, "批注滚动应走共享换算");
  assert.doesNotMatch(src, /scroller\.scrollTop \+ delta/, "不应再直接用视觉 delta 改 scrollTop");
  assert.match(src, /const anchors = new Map\(\)/, "锚点应按 id 建 Map");
  assert.match(src, /anchorNodeOf\(anchors, comment\?\.id\)/, "应按 comment.id 精确匹配锚点");
  assert.doesNotMatch(src, /anchors\[index\]/, "不得再用数组下标定位批注");
  assert.match(src, /start of comment\|comment/, "应解析 start/ref 两类注释标记");
});
await test("服务端批注回传 id 与 anchoredTo", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "server/index.mjs"), "utf8");
  assert.match(src, /id: String\(c\.format\?\.id \?\? c\.id \?\? ""\)/, "批注应回传 commentId");
  assert.match(src, /anchoredTo: String\(c\.format\?\.anchoredTo/, "批注应回传锚点段落");
  assert.match(src, /function cleanQuoted/, "应有引号清洗（officecli --json 会二次包裹引号）");
});

console.log(failed ? "\n文档定位测试：失败" : "\n文档定位测试：全部通过");
process.exit(failed ? 1 : 0);
