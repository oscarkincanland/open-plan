#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHealthyPayload, restartDelayFor, shouldSkipForResume } from "./服务监督.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const supervisor = fs.readFileSync(path.join(ROOT, "scripts", "服务监督.mjs"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");

assert.equal(pkg.scripts.start, "node scripts/服务监督.mjs --background", "npm start 应使用跨平台后台监督器");
assert.equal(pkg.scripts["start:foreground"], "node scripts/服务监督.mjs --foreground", "前台启动应使用跨平台监督器");
assert.equal(isHealthyPayload({ ok: true, version: "0.11.11" }, "0.11.11"), true);
assert.equal(isHealthyPayload({ ok: true, version: "0.11.10" }, "0.11.11"), false, "服务版本不匹配不能误报健康");
assert.equal(isHealthyPayload({ ok: false, version: "0.11.11" }), false);
assert.deepEqual(restartDelayFor({ uptimeMs: 5_000, rapidFailures: 0 }), { failures: 1, delayMs: 3_000 });
assert.deepEqual(restartDelayFor({ uptimeMs: 31_000, rapidFailures: 4 }), { failures: 0, delayMs: 3_000 }, "稳定运行后清空快速崩溃计数");
assert.deepEqual(restartDelayFor({ uptimeMs: 5_000, rapidFailures: 4 }), { failures: 5, delayMs: 30_000 }, "连续快速崩溃应退避，避免重启风暴");
assert.match(supervisor, /HEALTH_FAILURE_LIMIT = 3/);
assert.match(supervisor, /STARTUP_GRACE_MS = 180_000/);
assert.match(server, /closeAllConnections/);
assert.match(server, /process\.on\("uncaughtException"/);

// M1：睡眠/唤醒宽限 + 只读状态探测
assert.equal(shouldSkipForResume({ now: 100_000, lastCheckAt: 99_000, intervalMs: 15_000 }), false, "正常间隔不应跳过");
assert.equal(shouldSkipForResume({ now: 200_000, lastCheckAt: 100_000, intervalMs: 15_000 }), true, "间隔跳变（睡眠/唤醒）应跳过本次健康判定");
assert.equal(shouldSkipForResume({ now: 200_000, lastCheckAt: 0, intervalMs: 15_000 }), false, "首次检查不跳过");
assert.match(supervisor, /shouldSkipForResume\(\{ now, lastCheckAt: previousCheckAt \}\)/);
assert.match(supervisor, /process\.argv\.includes\("--status"\)/);
assert.equal(pkg.scripts["service:status"], "node scripts/服务监督.mjs --status", "应提供只读状态探测命令");

console.log("macOS/跨平台服务监督回归：通过");
