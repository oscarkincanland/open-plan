#!/usr/bin/env node
/**
 * 文档预览性能治理测试（2026-11-06）：守护 Word 慢的四条确定性成因。
 *
 * 覆盖：
 *   1. 预览缓存（预览缓存.mjs）：指纹失效、LRU 字节预算、命中不重复生产
 *   2. raw 路由允许条件请求（不再 no-store 全量重下）
 *   3. 批注/高保真 HTML 走缓存
 *   4. DocxViewer 大小预算 / EMF 短路 / 开关只切 CSS / 破图检测不阻塞首屏
 *
 * 用法: node scripts/预览性能测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

console.log("\n▶ 预览缓存（server/预览缓存.mjs）");
const { createPreviewCache } = await import("../server/预览缓存.mjs");

await test("同一指纹只生产一次（第二次命中缓存）", async () => {
  const cache = createPreviewCache();
  let calls = 0;
  const stat = { mtimeMs: 1000, size: 64 };
  const producer = async () => { calls += 1; return "payload"; };
  assert.equal(await cache.resolve("k", stat, producer), "payload");
  assert.equal(await cache.resolve("k", stat, producer), "payload");
  assert.equal(calls, 1, "第二次应命中缓存，不得重复生产");
  assert.equal(cache.stats().hits, 1);
});

await test("文件指纹变化（mtime/size）自动失效", async () => {
  const cache = createPreviewCache();
  let calls = 0;
  const producer = async () => { calls += 1; return `v${calls}`; };
  assert.equal(await cache.resolve("k", { mtimeMs: 1000, size: 64 }, producer), "v1");
  assert.equal(await cache.resolve("k", { mtimeMs: 2000, size: 64 }, producer), "v2", "mtime 变化应 miss");
  assert.equal(await cache.resolve("k", { mtimeMs: 2000, size: 99 }, producer), "v3", "size 变化应 miss");
  assert.equal(calls, 3);
});

await test("不同 key 互不干扰（批注与高保真 HTML 各走各的）", async () => {
  const cache = createPreviewCache();
  const stat = { mtimeMs: 1, size: 1 };
  assert.equal(await cache.resolve("office-comments", stat, async () => "c"), "c");
  assert.equal(await cache.resolve("office-html", stat, async () => "h"), "h");
  assert.equal(cache.peek("office-comments", stat), "c");
  assert.equal(cache.peek("office-html", stat), "h");
});

await test("超出条目上限淘汰最旧（LRU）", async () => {
  const cache = createPreviewCache({ maxEntries: 2, maxBytes: 1024 });
  const mk = (n) => ({ mtimeMs: n, size: 1 });
  await cache.resolve("k", mk(1), async () => "a");
  await cache.resolve("k", mk(2), async () => "b");
  await cache.resolve("k", mk(3), async () => "c");
  assert.equal(cache.peek("k", mk(1)), undefined, "最旧条目应被淘汰");
  assert.equal(cache.peek("k", mk(3)), "c", "最新条目应保留");
  assert.equal(cache.stats().entries, 2);
});

await test("超出字节预算不缓存（大对象不撑爆内存）", async () => {
  const cache = createPreviewCache({ maxEntries: 8, maxBytes: 10 });
  const stat = { mtimeMs: 1, size: 1 };
  const big = "x".repeat(100);
  await cache.resolve("k", stat, async () => big, { measure: (v) => v.length });
  assert.equal(cache.peek("k", stat), undefined, "超预算对象不得进入缓存");
  assert.equal(cache.stats().entries, 0);
});

await test("producer 抛错不污染缓存", async () => {
  const cache = createPreviewCache();
  const stat = { mtimeMs: 1, size: 1 };
  await assert.rejects(() => cache.resolve("k", stat, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(cache.peek("k", stat), undefined);
});

console.log("\n▶ 服务端接线");
await test("raw 路由允许条件请求（304），不再 no-store", () => {
  const src = read("server/index.mjs");
  const raw = src.slice(src.indexOf("原始文件流"), src.indexOf("app.get(/^\\/api\\/doc\\/(.+)\\/text$/")); 
  assert.ok(raw.length > 0, "应能定位 raw 路由");
  assert.match(raw, /Cache-Control", "private, max-age=0, must-revalidate"/, "raw 应允许重校验");
  assert.doesNotMatch(raw, /setHeader\("Cache-Control", "no-store/, "raw 不应再发 no-store 响应头（否则每次全量重下）");
  assert.match(raw, /res\.sendFile\(p\)/, "仍应走 sendFile（ETag/Last-Modified 由它生成）");
});

await test("批注与高保真 HTML 走预览缓存", () => {
  const src = read("server/index.mjs");
  assert.match(src, /import \{ previewCache \} from "\.\/预览缓存\.mjs"/, "应引入预览缓存");
  assert.match(src, /previewCache\.resolve\("office-html", stat/, "高保真 HTML 应缓存");
  assert.match(src, /previewCache\.resolve\("office-comments", stat/, "批注查询应缓存");
  // 缓存键必须来自文件指纹，不能用路径本身（否则文件改动后读到旧内容）
  assert.match(src, /const stat = await fs\.promises\.stat\(p\)/, "缓存键应取文件 stat 指纹");
});

console.log("\n▶ DocxViewer 性能契约");
await test("大小预算：超阈值切高保真，不硬渲染", () => {
  const src = read("client/src/components/DocxViewer.jsx");
  assert.match(src, /const DOCX_NATIVE_MAX_BYTES = 25 \* 1024 \* 1024/, "应有 25MB 预算常量");
  assert.match(src, /declaredSize > DOCX_NATIVE_MAX_BYTES/, "应按 content-length 判定");
  assert.match(src, /setRenderMode\("office"\)/, "超限应自动切高保真");
  assert.match(src, /res\.body\?\.cancel\(\)/, "超限应取消响应体，避免白下载");
});

await test("EMF/WMF 短路：识别矢量图并跳过 base64 重渲染", () => {
  const src = read("client/src/components/DocxViewer.jsx");
  assert.match(src, /async function countVectorOnlyMedia/, "应有 EMF/WMF 识别");
  assert.match(src, /word\\\/media\\\/\.\+\\\.\(\?:emf\|wmf\)/, "识别应覆盖 emf 与 wmf");
  assert.match(src, /if \(vectorOnlyCount\) \{ setImageNotice/, "命中矢量图应只提示，不重渲染");
});

await test("破图检测不阻塞首屏（ready 在前，校验在后）", () => {
  const src = read("client/src/components/DocxViewer.jsx");
  const readyIdx = src.indexOf("onPreviewState?.(vectorOnlyCount ? PREVIEW_STATE.PARTIAL : PREVIEW_STATE.READY)");
  const asyncIdx = src.indexOf("void (async () => {");
  assert.ok(readyIdx > 0, "应先标记 ready");
  assert.ok(asyncIdx > readyIdx, "图片校验应排到 ready 之后");
  assert.doesNotMatch(src, /await brokenImages\(6000\)/, "不应再在主链路里等 6 秒");
});

await test("批注/修订开关只切 CSS，不进 renderAsync 选项", () => {
  const src = read("client/src/components/DocxViewer.jsx");
  assert.match(src, /renderComments: true/, "批注应始终渲染");
  assert.match(src, /renderChanges: true/, "修订应始终渲染");
  assert.doesNotMatch(src, /renderComments: showComments/, "开关不得再影响渲染");
  assert.doesNotMatch(src, /renderChanges: showChanges/, "开关不得再影响渲染");
  assert.match(src, /classList\.toggle\("oaw-hide-comments", !showComments\)/, "应切 CSS 类");
  assert.match(src, /classList\.toggle\("oaw-hide-changes", !showChanges\)/, "应切 CSS 类");
  // 依赖里不应再有 showComments/showChanges，否则点开关仍会重渲染
  const deps = src.slice(src.indexOf("}, [urls, fileIdentity, applyFitWidth"), src.indexOf("}, [urls, fileIdentity, applyFitWidth") + 120);
  assert.doesNotMatch(deps, /showComments|showChanges/, "renderDoc 依赖不得包含开关状态");
  const css = read("client/src/styles.css");
  assert.match(css, /\.oaw-docx-host\.oaw-hide-comments \.oaw-docx-comment-ref/, "应有隐藏批注样式");
  assert.match(css, /\.oaw-docx-host\.oaw-hide-changes del/, "应有隐藏修订样式");
});

await test("缓存模块不落盘、不进 .oaw（纯内存）", () => {
  const src = read("server/预览缓存.mjs");
  assert.doesNotMatch(src, /writeFileSync|fs\.promises\.write/, "缓存不得写盘");
  assert.doesNotMatch(src, /\.oaw/, "缓存不得写入 .oaw 运行时目录");
});

console.log(failed ? "\n预览性能测试：失败" : "\n预览性能测试：全部通过");
process.exit(failed ? 1 : 0);
