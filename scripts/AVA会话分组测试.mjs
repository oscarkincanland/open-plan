#!/usr/bin/env node
/**
 * AVA 会话分组测试（v0.13.6）
 *
 * 守护：
 *   1) 会话列表支持 limit/cursor/groupBy=workspace；
 *   2) 前端 API 透传分页/分组参数；
 *   3) 侧栏可切换日期/工作区分组，每组默认 20 条并可展开。
 *
 * 用法：node scripts/AVA会话分组测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const index = read("server/index.mjs");
const api = read("client/src/api.js");
const sidebar = read("client/src/components/SessionSidebar.jsx");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("服务端支持 limit/cursor/groupBy", () => {
  assert.match(index, /Number\.parseInt\(req\.query\.limit, 10\)/);
  assert.match(index, /Number\.parseInt\(req\.query\.cursor, 10\)/);
  assert.match(index, /String\(req\.query\.groupBy \|\| ""\)/);
  assert.match(index, /groupBy === "workspace"/);
  assert.match(index, /nextCursor/);
  assert.match(index, /sessions: paged/);
});

test("服务端按工作区分组并返回 count", () => {
  assert.match(index, /const key = session\.projectId \|\| session\.cwd \|\| "ungrouped"/);
  assert.match(index, /label: session\.projectName \|\| session\.cwd \|\| "未分组"/);
  assert.match(index, /count: group\.sessions\.length/);
});

test("前端 API 透传分页/分组参数", () => {
  assert.match(api, /"limit", "cursor", "groupBy"/);
});

test("侧栏支持日期/工作区切换并持久化", () => {
  assert.match(sidebar, /localStorage\.getItem\("oaw_session_group"\)/);
  assert.match(sidebar, /localStorage\.setItem\("oaw_session_group", mode\)/);
  assert.match(sidebar, /groupMode === "date" \? "workspace" : "date"/);
  assert.match(sidebar, /分组：工作区/);
});

test("每个工作区默认 20 条并可展开", () => {
  assert.match(sidebar, /group\.sessions\.slice\(0, 20\)/);
  assert.match(sidebar, /还有 \$\{group\.sessions\.length - 20\} 条/);
  assert.match(sidebar, /expandedGroups\.has\(group\.key\)/);
});

console.log(failed ? "\nAVA 会话分组测试：存在失败项" : "\nAVA 会话分组测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
