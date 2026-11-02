#!/usr/bin/env node
/**
 * 前端分包失效恢复测试（地图等 lazy 模块崩溃防护）：
 * 1. 识别“重建后旧页面加载懒模块失败”的两类真实错误：
 *    - Failed to fetch dynamically imported module
 *    - Cannot read properties of undefined (reading 'default') + stack 指向 /assets/*.js
 * 2. 普通组件错误不得被误判为分包失效（否则会无限刷新）。
 * 3. 源码契约：DeferredModule 有局部错误边界；构建保留上一版资源。
 *
 * 用法: node scripts/chunk-recovery-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const { isStaleChunkError } = await import(pathToFileURL(path.join(ROOT, "client/src/分包恢复.js")).href);

console.log("\n▶ 分包失效识别");

test("动态 import 失败识别为分包失效", () => {
  assert.equal(isStaleChunkError(new Error("Failed to fetch dynamically imported module: http://x/assets/MapPanel-OLD.js")), true);
  assert.equal(isStaleChunkError(new Error("Importing a module script failed.")), true);
  assert.equal(isStaleChunkError(new Error("ChunkLoadError: Loading chunk 12 failed")), true);
});

test("React.lazy 的 reading 'default' + assets 栈识别为分包失效", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'default')");
  error.stack = "TypeError: Cannot read properties of undefined (reading 'default')\n    at n3 (http://127.0.0.1:3002/assets/index-COIcIhiY.js:10:3572)";
  assert.equal(isStaleChunkError(error), true);
});

test("没有 assets 栈的同名 TypeError 不误判", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'default')");
  error.stack = "TypeError: Cannot read properties of undefined (reading 'default')\n    at Component (http://127.0.0.1:3002/src/Component.jsx:10:2)";
  assert.equal(isStaleChunkError(error), false);
});

test("普通业务错误不误判", () => {
  assert.equal(isStaleChunkError(new Error("地图样式加载失败，请重试")), false);
  assert.equal(isStaleChunkError(null), false);
});

console.log("\n▶ 源码契约");

test("DeferredModule 使用局部错误边界，加载失败不再整页白屏", () => {
  const app = read("client/src/App.jsx");
  assert.match(app, /class ModuleBoundary extends React\.Component/);
  assert.match(app, /<ModuleBoundary label=\{label\}>\{children\}<\/ModuleBoundary>/);
  assert.match(app, /「\{this\.props\.label \|\| "模块"\}」加载失败/);
  assert.match(app, /重新加载模块/);
  assert.match(app, /componentDidCatch\(error, info\)[\s\S]{0,400}?isStaleChunkError\(error\)/);
});

test("构建保留上一版 hash 资源并清理 48 小时前的旧文件", () => {
  const vite = read("client/vite.config.js");
  assert.match(vite, /emptyOutDir: false/);
  assert.match(vite, /pruneOldAssets/);
  assert.match(vite, /ASSET_MAX_AGE_MS = 48 \* 60 \* 60_000/);
});

console.log(failed ? "\n✗ 前端分包恢复测试存在失败" : "\n✓ 前端分包恢复测试全部通过");
process.exitCode = failed ? 1 : 0;
