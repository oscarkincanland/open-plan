#!/usr/bin/env node
/**
 * 并行写锁回归测试（2026-11-04 并发验收修复）。
 *
 * 背景（实测事故）：用户同时在两个会话生成同一份 PPT，另一个会话持有金东工作区
 * 写锁期间，PPT master 会话连 `git --version`、`command -v git`、`ls` 等只读命令
 * 都会去抢工作区写锁，各白等 20 秒后返回「写入范围与其他任务冲突」——并行任务
 * 完全无法开展。修复三件事：
 *   1. 只读判定按子命令细分（git status/log/rev-parse、command -v、node -v 等放行）；
 *   2. bash 写锁按命令推导真实目标（已有 server/bash写锁.mjs，本测试锁定行为）；
 *   3. 写锁等待超时错误带上「占用任务 + 已等待时长 + 可重试指引」。
 *
 * 覆盖：
 *   A. isReadonlyBash 只读/写分类（git/node/python/npm/command/rm/重定向）；
 *   B. bashWriteTargets 目标推导（重定向/cd/rm/cp/mv/sed-i/dd/tee/通配符/回退）；
 *   C. 锁语义（跨 Run 不同文件不冲突、同文件超时提示、同 Run 重入、目录父子重叠）；
 *   D. 接线契约（agent 使用 withBashWriteLocks；超时提示含引导）。
 *
 * 用法: node scripts/并行写锁回归测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 读取 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");

const { isReadonlyBash } = await import(new URL(`file:///${ROOT.replace(/\\/g, "/")}/server/office规范/执行闸门.mjs`).href);
const { bashWritePlan, bashWriteTargets } = await import(new URL(`file:///${ROOT.replace(/\\/g, "/")}/server/bash写锁.mjs`).href);
const { acquireWriteLock, acquireWriteLockWithRetry, releaseWriteLock } = await import(new URL(`file:///${ROOT.replace(/\\/g, "/")}/server/写入协调.mjs`).href);

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};

console.log("\n▶ A. 只读命令判定（git/command/node/python/npm）");

test("git 只读子命令放行，写子命令仍按写处理", () => {
  for (const cmd of ["git --version", "git status", "git log --oneline -3", "git rev-parse --show-toplevel", "git diff", "git show HEAD", "git ls-files"]) {
    assert.equal(isReadonlyBash(cmd), true, `${cmd} 应为只读`);
  }
  for (const cmd of ["git commit -m x", "git push", "git clone https://x", "git checkout .", "git reset --hard"]) {
    assert.equal(isReadonlyBash(cmd), false, `${cmd} 应按写处理`);
  }
});

test("command -v / node -v / python --version / npm --version 放行", () => {
  assert.equal(isReadonlyBash("command -v git; command -v python; echo done"), true);
  assert.equal(isReadonlyBash("node -v"), true);
  assert.equal(isReadonlyBash("node --version"), true);
  assert.equal(isReadonlyBash("python3 --version"), true);
  assert.equal(isReadonlyBash("npm --version"), true);
  assert.equal(isReadonlyBash("npm ls"), true);
  // 执行脚本仍按写处理
  assert.equal(isReadonlyBash("node app.js"), false);
  assert.equal(isReadonlyBash("python3 scripts/run.py"), false);
  assert.equal(isReadonlyBash("npm run build"), false);
});

test("普通读写命令判定不受影响", () => {
  assert.equal(isReadonlyBash("ls -la && echo ok"), true);
  assert.equal(isReadonlyBash("grep -rn issue src"), true);
  assert.equal(isReadonlyBash("echo hi > a.md"), false);
  assert.equal(isReadonlyBash("rm -rf x"), false);
  assert.equal(isReadonlyBash("cat a | tee b"), false);
});

console.log("\n▶ B. bash 写目标推导");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-writelock-"));
fs.mkdirSync(path.join(ws, "sub"), { recursive: true });
const targets = (cmd, cwd = ws) => bashWriteTargets(cmd, { cwd, workspace: ws });
const rel = (p) => path.relative(ws, p).replace(/\\/g, "/");

test("重定向 / cd 链 / rm / cp / mv / sed -i / dd / tee 都能推导真实文件", () => {
  assert.deepEqual(targets("echo hi > a.md").map(rel), ["a.md"]);
  assert.deepEqual(targets("cd sub && echo hi > b.md").map(rel), ["sub/b.md"]);
  assert.deepEqual(targets("rm a.md b.md").map(rel).sort(), ["a.md", "b.md"]);
  assert.deepEqual(targets("cp src.md dst.md").map(rel), ["dst.md"]);
  assert.deepEqual(targets("mv old.md new.md").map(rel).sort(), ["new.md", "old.md"]);
  assert.deepEqual(targets("sed -i 's/a/b/' f.md").map(rel), ["f.md"]);
  assert.deepEqual(targets("dd if=in.bin of=out.bin").map(rel), ["out.bin"]);
  assert.deepEqual(targets("echo x | tee -a log.txt").map(rel), ["log.txt"]);
});

test("通配符锁父目录；无法推导时只标记 unscoped", () => {
  assert.deepEqual(targets("rm -rf .work/*").map(rel), [".work"]);
  assert.deepEqual(targets("node app.js"), []);
  assert.equal(bashWritePlan("node app.js", { cwd: ws, workspace: ws }).unscoped, true);
  assert.deepEqual(targets("bash -c 'echo hi > x'"), []);
  assert.equal(bashWritePlan("bash -c 'echo hi > x'", { cwd: ws, workspace: ws }).reason, "shell_wrapper");
  const commit = bashWritePlan("git commit -m x", { cwd: ws, workspace: ws });
  assert.deepEqual(commit.targets, [path.join(path.resolve(ws), ".git")]);
  assert.equal(commit.unscoped, false);
});

test("只读命令不产生写目标", () => {
  assert.deepEqual(targets("ls -la"), []);
  assert.deepEqual(targets("cat a.md"), []);
});

console.log("\n▶ C. 写锁语义");

await testAsync("跨 Run 写不同文件：互不阻塞", async () => {
  const tokenA = acquireWriteLock({ workspace: ws, targetPath: path.join(ws, "a.md"), runId: "run_a", threadId: "t_a", kind: "file" });
  const tokenB = acquireWriteLock({ workspace: ws, targetPath: path.join(ws, "b.md"), runId: "run_b", threadId: "t_b", kind: "file" });
  releaseWriteLock(tokenB);
  releaseWriteLock(tokenA);
});

await testAsync("同一 Run 重入不冲突", async () => {
  const t1 = acquireWriteLock({ workspace: ws, targetPath: path.join(ws, "c.md"), runId: "run_a", threadId: "t_a", kind: "file" });
  const t2 = acquireWriteLock({ workspace: ws, targetPath: path.join(ws, "c.md"), runId: "run_a", threadId: "t_a", kind: "file" });
  assert.equal(t2.reentrant, true);
  releaseWriteLock(t2);
  releaseWriteLock(t1);
});

await testAsync("同文件跨 Run：超时错误带占用任务与重试指引", async () => {
  const t1 = acquireWriteLock({ workspace: ws, targetPath: path.join(ws, "d.md"), runId: "run_a", threadId: "thread_owner_1", kind: "file" });
  try {
    await assert.rejects(
      () => acquireWriteLockWithRetry({ workspace: ws, targetPath: path.join(ws, "d.md"), runId: "run_b", threadId: "thread_waiter_2", kind: "file" }, { timeoutMs: 400, intervalMs: 50 }),
      (error) => {
        assert.equal(error.code, "WRITE_CONFLICT");
        assert.equal(error.details?.retryable, true);
        assert.match(error.message, /已等待 \d+ 秒/, "错误应说明已等待时长");
        assert.match(error.message, /占用任务/, "错误应指出占用任务");
        assert.match(error.message, /可稍后重试/, "错误应给出重试指引");
        return true;
      },
    );
  } finally {
    releaseWriteLock(t1);
  }
});

await testAsync("目录锁与子文件重叠即冲突", async () => {
  const t1 = acquireWriteLock({ workspace: ws, targetPath: path.join(ws, "sub"), runId: "run_a", threadId: "t_a", kind: "file" });
  try {
    await assert.rejects(
      () => acquireWriteLockWithRetry({ workspace: ws, targetPath: path.join(ws, "sub", "x.md"), runId: "run_b", threadId: "t_b", kind: "file" }, { timeoutMs: 300, intervalMs: 50 }),
      (error) => error.code === "WRITE_CONFLICT",
    );
  } finally {
    releaseWriteLock(t1);
  }
});

console.log("\n▶ D. 接线契约");

test("agent 的 bash 写锁使用命令目标推导（withBashWriteLocks + bashWritePlan）", () => {
  const agent = 读取("server", "agent.mjs");
  assert.match(agent, /import \{ bashWritePlan \} from "\.\/bash写锁\.mjs"/, "agent 应引入 bash 写目标推导");
  assert.match(agent, /bashWritePlan\(command, \{ cwd: cwd \|\| ctx\.workspace, workspace: ctx\.workspace \}\)/, "bash 写锁应按命令目标加锁");
  assert.match(agent, /write_scope_unknown/, "无法推导时应发 write_scope_unknown 事件");
});

test("只读判定含 git 子命令白名单与 command -v 分支", () => {
  const gate = 读取("server", "office规范", "执行闸门.mjs");
  assert.match(gate, /GIT_READONLY_SUBCOMMANDS/, "缺少 git 只读子命令白名单");
  assert.match(gate, /command\\s\+-\[vV\]/, "缺少 command -v 只读分支");
  assert.match(gate, /py\(\?:thon3\?\)/, "缺少 python -V 兼容分支");
});

test("写锁超时提示含等待时长/占用任务/重试指引", () => {
  const coord = 读取("server", "写入协调.mjs");
  assert.match(coord, /已等待 \$\{seconds\} 秒/, "缺少等待时长提示");
  assert.match(coord, /占用任务 \$\{owner\}/, "缺少占用任务提示");
  assert.match(coord, /可稍后重试/, "缺少重试指引");
});

// 清理临时工作区
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}

console.log(failed ? "\n✗ 并行写锁回归测试存在失败" : "\n✓ 并行写锁回归测试全部通过");
process.exit(failed ? 1 : 0);
