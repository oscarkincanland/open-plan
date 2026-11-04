#!/usr/bin/env node
/**
 * bash 写锁范围测试（2026-11-04）
 *
 * 守护：同一工作区并发两个任务时，A 任务写自己的产物不应阻塞 B 任务清理
 * 自己的临时文件；同一文件的写仍然互斥。无法静态推导的命令保守回退工作区锁。
 *
 * 用法：node scripts/bash写锁测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashWriteTargets } from "../server/bash写锁.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-bash-lock-"));
process.env.OAW_WRITE_LOCK_DIR = path.join(tmp, ".locks");
const { acquireWriteLock, releaseWriteLock } = await import("../server/写入协调.mjs");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const ws = tmp;
const rel = (target) => path.relative(ws, target).replace(/\\/g, "/");

console.log("\n▶ 命令推导");
test("rm 只锁被删文件/目录，不锁整个工作区", () => {
  assert.deepEqual(bashWriteTargets("rm -rf .work", { cwd: ws, workspace: ws }).map(rel), [".work"]);
  assert.deepEqual(bashWriteTargets("rm .work/a.tmp .work/b.tmp", { cwd: ws, workspace: ws }).map(rel).sort(), [".work/a.tmp", ".work/b.tmp"]);
});
test("通配符锁父目录，不会只锁字面量", () => {
  assert.deepEqual(bashWriteTargets("rm -rf .work/*", { cwd: ws, workspace: ws }).map(rel), [".work"]);
  assert.deepEqual(bashWriteTargets("rm -rf *", { cwd: ws, workspace: ws }).map(rel), [""]);
});
test("mv 锁源和目标；cp 只锁目标", () => {
  assert.deepEqual(bashWriteTargets("mv 旧名.docx 新名.docx", { cwd: ws, workspace: ws }).map(rel).sort(), ["新名.docx", "旧名.docx"]);
  assert.deepEqual(bashWriteTargets("cp 报告.docx 报告_副本.docx", { cwd: ws, workspace: ws }).map(rel), ["报告_副本.docx"]);
});
test("重定向 / tee / sed -i / dd of=", () => {
  assert.deepEqual(bashWriteTargets("echo hi > out.md", { cwd: ws, workspace: ws }).map(rel), ["out.md"]);
  assert.deepEqual(bashWriteTargets("printf x | tee log.txt", { cwd: ws, workspace: ws }).map(rel), ["log.txt"]);
  assert.deepEqual(bashWriteTargets("sed -i 's/a/b/' 草稿.md", { cwd: ws, workspace: ws }).map(rel), ["草稿.md"]);
  assert.deepEqual(bashWriteTargets("dd if=a of=b.bin", { cwd: ws, workspace: ws }).map(rel), ["b.bin"]);
});
test("cd 后的相对路径按新目录解析", () => {
  assert.deepEqual(bashWriteTargets("cd sub && rm x.md", { cwd: ws, workspace: ws }).map(rel), ["sub/x.md"]);
});
test("只读命令不需要写锁", () => {
  assert.deepEqual(bashWriteTargets("ls -la", { cwd: ws, workspace: ws }), []);
  assert.deepEqual(bashWriteTargets("find . -name '*.md'", { cwd: ws, workspace: ws }), []);
});
test("无法推导的脚本命令保守回退工作区根", () => {
  assert.deepEqual(bashWriteTargets("node build.js", { cwd: ws, workspace: ws }), [path.resolve(ws)]);
  assert.deepEqual(bashWriteTargets("bash -c 'echo x > y'", { cwd: ws, workspace: ws }), [path.resolve(ws)]);
});

console.log("\n▶ 并发隔离");
test("A 写产物、B 清理 .work 临时文件互不冲突", () => {
  const product = path.join(ws, "金东区农村公路网布局规划_汇报PPT大纲.md");
  const lockA = acquireWriteLock({ workspace: ws, targetPath: product, runId: "run_a", kind: "write" });
  const targetsB = bashWriteTargets("rm .work/build.tmp", { cwd: ws, workspace: ws });
  assert.deepEqual(targetsB.map(rel), [".work/build.tmp"]);
  const locksB = targetsB.map((target) => acquireWriteLock({ workspace: ws, targetPath: target, runId: "run_b", kind: "bash" }));
  assert.equal(locksB.length, 1);
  locksB.forEach(releaseWriteLock);
  releaseWriteLock(lockA);
});
test("同一文件仍互斥", () => {
  const file = path.join(ws, "同一文件.md");
  const lockA = acquireWriteLock({ workspace: ws, targetPath: file, runId: "run_a", kind: "write" });
  assert.throws(
    () => acquireWriteLock({ workspace: ws, targetPath: file, runId: "run_b", kind: "bash" }),
    (error) => error.code === "WRITE_CONFLICT",
  );
  releaseWriteLock(lockA);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\nbash 写锁范围测试：存在失败项" : "\nbash 写锁范围测试：全部通过（8 例）");
process.exit(failed ? 1 : 0);
