#!/usr/bin/env node
/**
 * 事件流回放窗口回归测试
 *
 * 覆盖：listEvents 的 truncated 判定必须对着“本次真正返回的窗口”计算。
 * 历史缺陷：只看全局最早序号（n < events[0].seq），当命中条数超过 limit
 * 而只能返回最后 max 条时不会标记截断 —— 前端因此静默丢失中间事件。
 *
 * 用法: node scripts/事件流回放窗口测试.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-回放窗口-"));
process.env.OAW_EVENT_DIR = dir;

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed = 1; console.error(`  ✗ ${msg}`); };
const check = (fn, msg) => { try { fn(); ok(msg); } catch (e) { fail(`${msg}: ${e.message}`); } };

try {
  const store = await import("../server/事件存储.mjs");

  // 造 50 条属于 client-A 的事件
  for (let i = 0; i < 50; i++) {
    store.appendEvent({ clientId: "client-A", threadId: "t1", type: "run_started", data: { i } });
  }
  // 另一个客户端 3 条，用于验证跨客户端不串味
  for (let i = 0; i < 3; i++) {
    store.appendEvent({ clientId: "client-B", threadId: "t2", type: "run_started", data: { i } });
  }

  console.log("\n▶ 回放窗口截断判定");

  const r1 = store.listEvents({ after: 0, clientId: "client-A", limit: 10 });
  check(() => assert.equal(r1.events.length, 10), "limit=10 只返回 10 条");
  check(() => assert.equal(r1.events[0].seq, 41), "返回窗口是最新的 10 条（seq 41 起）");
  check(() => assert.equal(r1.truncated, true), "被 limit 截断时 truncated=true（历史缺陷会漏报）");

  const r2 = store.listEvents({ after: 0, clientId: "client-A", limit: 2000 });
  check(() => assert.equal(r2.events.length, 50), "limit 足够时返回全部 50 条");
  check(() => assert.equal(r2.events[0].seq, 1), "返回窗口从 seq 1 开始");
  check(() => assert.equal(r2.truncated, false), "完整覆盖时不标记截断");

  const r3 = store.listEvents({ after: 40, clientId: "client-A", limit: 10 });
  check(() => assert.deepEqual(r3.events.map((e) => e.seq), [41, 42, 43, 44, 45, 46, 47, 48, 49, 50]), "游标 40 之后的 10 条全部返回");
  check(() => assert.equal(r3.truncated, false), "游标连续且未被裁掉时不标记截断");

  const r4 = store.listEvents({ after: 30, clientId: "client-A", limit: 10 });
  check(() => assert.equal(r4.events[0].seq, 41), "游标 30 之后只能返回最新 10 条");
  check(() => assert.equal(r4.truncated, true), "游标与返回窗口不连续时标记截断");

  const r5 = store.listEvents({ after: 0, clientId: "client-B", limit: 10 });
  check(() => assert.equal(r5.events.length, 3), "其他客户端事件不串味");
  check(() => assert.equal(r5.truncated, false), "条数未超限时不标记截断");

  // 不变量：truncated=false 时，返回窗口必须与游标连续（不允许静默跳号）；
  // 而窗口无法覆盖游标时，必须明确告知截断，客户端据此走重同步而不是继续向前翻页。
  console.log("\n▶ 静默跳号检查");
  let silentGap = null;
  for (const after of [0, 5, 30, 39, 40, 45, 50, 99]) {
    const page = store.listEvents({ after, clientId: "client-A", limit: 10 });
    const first = page.events[0]?.seq || 0;
    const contiguous = !page.events.length || first === after + 1 || (after === 0 && first === 1);
    if (!page.truncated && !contiguous) silentGap = { after, first };
  }
  check(() => assert.equal(silentGap, null), `truncated=false 时窗口与游标连续${silentGap ? `（after=${silentGap.after} 却从 ${silentGap.first} 开始）` : ""}`);
  const paged = store.listEvents({ after: 0, clientId: "client-A", limit: 10 });
  check(() => assert.equal(paged.truncated, true), "游标落后超过 limit 时明确告知截断（供前端触发重同步）");
} catch (error) {
  fail(`测试执行异常: ${error?.stack || error}`);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(failed ? "\n事件流回放窗口测试：失败" : "\n事件流回放窗口测试：全部通过");
process.exit(failed);
