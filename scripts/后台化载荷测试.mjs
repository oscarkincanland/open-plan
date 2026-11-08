#!/usr/bin/env node
/**
 * 后台化载荷回归测试（D0-5）
 *
 * 背景：工具超过 120s 转后台时，旧实现把字符串传给 SDK 的
 * `BashOperations.exec({ onData: (data: Buffer) => void })`，触发
 * “The "input" argument must be an instance of ArrayBuffer or ArrayBufferView”，
 * 模型拿不到 jobId 只能重复执行（真实 Run 中 4 次 pip 各 120s 白等）。
 *
 * 本测试锁定：后台提示统一由 backgroundNotice() 返回 Buffer；agent.mjs 接线正确。
 *
 * 用法：node scripts/后台化载荷测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backgroundNotice } from "../server/后台任务.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("backgroundNotice 返回 Buffer（不是 string）", () => {
  const notice = backgroundNotice("job_abc123");
  assert.ok(Buffer.isBuffer(notice), "必须是 Buffer");
  assert.equal(typeof notice, "object");
});

test("后台提示包含 jobId、UTF-8 与 job_status 指引", () => {
  const notice = backgroundNotice("job_abc123");
  const text = notice.toString("utf8");
  assert.match(text, /\[BACKGROUNDED\]/);
  assert.match(text, /jobId=job_abc123/);
  assert.match(text, /job_status/);
  assert.equal(Buffer.byteLength(text, "utf8"), notice.length);
});

test("jobId 为空时有兜底，不抛错", () => {
  const text = backgroundNotice("").toString("utf8");
  assert.match(text, /jobId=\(unknown\)/);
});

test("agent.mjs 使用 Buffer 版后台提示，且不再保留旧字符串拼接", () => {
  const agent = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(agent, /options\?\.onData\?\.\(backgroundNotice\(job\.jobId\)\)/);
  assert.doesNotMatch(agent, /onData\?\.\(`\\n\[BACKGROUNDED\] jobId=\$\{job\.jobId\}/);
});

console.log(failed ? "\n后台化载荷测试：存在失败" : "\n后台化载荷测试：全部通过");
process.exit(failed);
