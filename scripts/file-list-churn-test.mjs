#!/usr/bin/env node
/**
 * 文件列表抖动回归：
 * 1) listWorkspace 在 readdir→stat 期间文件/目录被删除时不抛异常（跳过消失条目）；
 * 2) /api/files 路由不再把文件抖动变成 HTML 500，而是结构化错误码；
 * 3) 前端 refreshFiles 有合并、重试与横幅节流。
 *
 * 用法: node scripts/file-list-churn-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listWorkspace } from "../server/workspace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-file-churn-"));
for (let i = 0; i < 80; i += 1) {
  fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
  fs.mkdirSync(path.join(dir, `d${i}`));
}

const child = spawn(process.execPath, [
  "-e",
  `const fs=require('fs'),p=require('path');const d=${JSON.stringify(dir)};const end=Date.now()+1800;while(Date.now()<end){for(let i=0;i<80;i++){try{fs.rmSync(p.join(d,'f'+i+'.txt'),{force:true})}catch{};try{fs.writeFileSync(p.join(d,'f'+i+'.txt'),'x')}catch{}}for(let i=0;i<80;i++){try{fs.rmSync(p.join(d,'d'+i),{recursive:true,force:true})}catch{};try{fs.mkdirSync(p.join(d,'d'+i))}catch{}}}`,
], { stdio: "ignore" });

console.log("\n▶ listWorkspace 抖动容错");
test("文件/目录持续删除重建时不抛异常", () => {
  let failures = [];
  for (let i = 0; i < 80; i += 1) {
    try {
      const files = listWorkspace(dir);
      assert.ok(Array.isArray(files));
    } catch (error) {
      failures.push(error.code || error.message);
    }
  }
  assert.deepEqual([...new Set(failures)], [], `出现异常: ${[...new Set(failures)].join(", ")}`);
});

child.kill();
await new Promise((resolve) => setTimeout(resolve, 200));

console.log("\n▶ 服务端与前端接线");

test("列表路由返回结构化错误，不落到 HTML 500", () => {
  const server = read("server/index.mjs");
  assert.match(server, /FILES_TRANSIENT/);
  assert.match(server, /FILES_NOT_FOUND/);
  assert.match(server, /文件列表暂时不可用/);
  assert.match(server, /listWorkspace\(target\)/);
  assert.match(server, /attempt < 2/);
});

test("refreshFiles 合并请求、重试一次、横幅只对连续失败显示", () => {
  const app = read("client/src/App.jsx");
  assert.match(app, /filesRefreshRef/);
  assert.match(app, /filesPendingDirRef/);
  assert.match(app, /isTransientFilesError/);
  assert.match(app, /filesFailureStreakRef\.current >= 2/);
  assert.match(app, /await wait\(400\)/);
  assert.match(app, /目录已不存在|currentDirRef\.current = ""/);
});

test("服务端不再对每个条目二次 stat", () => {
  const workspace = read("server/workspace.mjs");
  assert.doesNotMatch(workspace, /items\s*\.filter\(\(e\) => e\.isFile\(\)[\s\S]{0,200}statSync/);
  assert.match(workspace, /跳过该条/);
});

try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
console.log(failed ? "\n✗ 文件列表抖动测试存在失败" : "\n✓ 文件列表抖动测试全部通过");
process.exitCode = failed ? 1 : 0;
