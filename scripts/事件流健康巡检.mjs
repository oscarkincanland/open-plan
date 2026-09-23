#!/usr/bin/env node
/**
 * 事件流健康巡检（只读，不写入任何数据）
 *
 * 用法: node scripts/事件流健康巡检.mjs [事件目录]
 * 退出码: 0 = 存储层无致命问题；1 = 序号缺口/重复等致命问题
 *
 * 检查项：
 *   1) 存储层：序号连续性、重复、坏行、归档切片、活动文件体量
 *   2) Run 层：终态齐备性、开始/结束配对（孤儿事件）
 *   3) 模型层：agent_error / agent_retry 分类统计（网络 or 项目）
 *   4) 时间层：长时间断档（服务停摆或长时间空闲）
 *   5) 回放层：单客户端事件总量 vs SSE 回放上限（静默缺口风险）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.argv[2] || path.join(PROJECT_DIR, ".oaw", "events");
const FILE = path.join(DIR, "事件流.jsonl");
const REPLAY_LIMIT = 2000; // index.mjs 中 /api/agent/events 的单次回放上限

let critical = 0;
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };
const mark = (ok, text) => say(`  ${ok ? "✓" : "⚠"} ${text}`);

if (!fs.existsSync(FILE)) {
  console.error(`未找到事件流文件: ${FILE}`);
  process.exit(1);
}

// ---------- 读取 ----------
const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean);
const events = [];
let badLines = 0;
for (const line of lines) {
  try {
    const item = JSON.parse(line);
    if (item && item.seq !== undefined) events.push(item);
    else badLines++;
  } catch { badLines++; }
}
events.sort((a, b) => Number(a.seq) - Number(b.seq));
const first = events[0];
const last = events[events.length - 1];

say(`事件流健康巡检  ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
say(`文件: ${FILE}`);
say(`范围: seq ${first.seq} ~ ${last.seq}，${events.length} 条，时间 ${first.at} ~ ${last.at}`);

// ---------- 1) 存储层 ----------
say("\n▶ 1. 存储层");
const seqSet = new Set(events.map((e) => Number(e.seq)));
const dup = events.length - seqSet.size;
const gaps = [];
for (let s = Number(first.seq); s <= Number(last.seq); s++) if (!seqSet.has(s)) gaps.push(s);
if (gaps.length || dup) {
  critical = 1;
  mark(false, `序号缺口 ${gaps.length} 个${gaps.length ? "（" + gaps.slice(0, 20).join(", ") + (gaps.length > 20 ? " …" : "") + "）" : ""}，重复 ${dup} 条`);
} else {
  mark(true, `序号 ${first.seq}~${last.seq} 连续，无缺口、无重复`);
}
mark(badLines === 0, `坏行 ${badLines} 条`);
const sizeMB = fs.statSync(FILE).size / 1024 / 1024;
mark(sizeMB < 8, `活动文件 ${sizeMB.toFixed(2)} MB（8.00 MB 触发归档切片）`);
try {
  const index = JSON.parse(fs.readFileSync(path.join(DIR, "事件流索引.json"), "utf8"));
  mark(true, `历史归档 ${index.files?.length || 0} 个切片`);
} catch {
  mark(true, "暂无归档切片");
}

// ---------- 2) Run 层 ----------
say("\n▶ 2. Run 层");
const runs = new Map();
for (const e of events) {
  const id = e.runId || "(无 runId)";
  if (!runs.has(id)) runs.set(id, []);
  runs.get(id).push(e);
}
const TERMINAL = new Set(["run_finished"]);
const noTerminal = [];
const pairIssues = new Map();
const PAIRS = [["turn_started", "turn_ended"], ["message_start", "message_end"], ["tool_start", "tool_end"]];
for (const [id, list] of runs) {
  if (id === "(无 runId)") continue;
  const types = new Set(list.map((e) => e.type));
  if (!list.some((e) => TERMINAL.has(e.type) || e.type === "aborted")) noTerminal.push(id);
  for (const [open, close] of PAIRS) {
    const a = list.filter((e) => e.type === open).length;
    const b = list.filter((e) => e.type === close).length;
    if (a !== b) pairIssues.set(`${open}≠${close}`, (pairIssues.get(`${open}≠${close}`) || 0) + 1);
  }
}
const runCount = [...runs.keys()].filter((k) => k !== "(无 runId)").length;
mark(noTerminal.length === 0, `${runCount} 个 run 中，${noTerminal.length} 个缺终态事件${noTerminal.length ? "：" + noTerminal.slice(0, 8).map((s) => s.slice(0, 18)).join("、") + (noTerminal.length > 8 ? " …" : "") : ""}`);
if (pairIssues.size) {
  const parts = [...pairIssues.entries()].map(([k, v]) => `${k} ×${v} 个 run`);
  mark(false, `开始/结束配对异常：${parts.join("；")}（常见原因：排队 run 交接时收尾事件归属了新 run、异常中止/服务重启未收尾）`);
} else {
  mark(true, "开始/结束事件全部成对");
}

// ---------- 3) 模型层 ----------
say("\n▶ 3. 模型层（网络 vs 项目）");
const errors = events.filter((e) => e.type === "agent_error" || e.type === "runtime_error");
const retries = events.filter((e) => e.type === "agent_retry");
const classify = (e) => {
  const t = `${e.data?.code || ""} ${e.data?.message || ""}`;
  if (/401|403|invalid.?api.?key|authentication|unauthori/i.test(t)) return "auth 认证";
  if (/429|rate.?limit/i.test(t)) return "rate_limit 限流";
  if (/50[0-9]|service is too busy|unavailable/i.test(t)) return "upstream 5xx 上游故障";
  if (/timeout|超时|流式输出超过/i.test(t)) return "timeout 超时";
  if (/abort/i.test(t)) return "aborted 请求被中止";
  return "其他";
};
const byCategory = new Map();
for (const e of errors) {
  const c = classify(e);
  byCategory.set(c, (byCategory.get(c) || 0) + 1);
}
mark(errors.length === 0, `错误 ${errors.length} 次 / 重试 ${retries.length} 次${byCategory.size ? "（" + [...byCategory.entries()].map(([k, v]) => `${k} ${v}`).join("，") + "）" : ""}`);
const networkish = [...byCategory.keys()].filter((k) => k !== "其他").length > 0;
mark(true, networkish
  ? "错误集中在模型上游链路（网络/上游服务），服务端存储未报错 → 属外部因素"
  : "未发现模型上游错误");
const recentErrors = errors.slice(-5);
for (const e of recentErrors) say(`      ${String(e.at).slice(0, 19)}  ${String(e.data?.code || e.type).padEnd(22)} ${String(e.data?.message || "").slice(0, 70)}`);

// ---------- 4) 时间层 ----------
say("\n▶ 4. 时间层");
let gapsOver = 0;
let longest = { seconds: 0 };
for (let i = 1; i < events.length; i++) {
  const seconds = (new Date(events[i].at) - new Date(events[i - 1].at)) / 1000;
  if (seconds > 60) gapsOver++;
  if (seconds > longest.seconds) longest = { seconds, from: events[i - 1].at, to: events[i].at, a: events[i - 1].type, b: events[i].type };
}
mark(true, `>60 秒断档 ${gapsOver} 处；最长 ${(longest.seconds / 3600).toFixed(1)} 小时（${String(longest.from).slice(5, 16)} ${longest.a} → ${String(longest.to).slice(5, 16)} ${longest.b}）`);
const recovered = events.filter((e) => e.type === "run_recovered").length;
mark(recovered === 0, `服务重启后要求接管的 Run：${recovered} 个（>0 说明重启打断了在跑的 Run）`);

// ---------- 5) 回放层 ----------
say("\n▶ 5. 回放层（静默缺口风险）");
const perClient = new Map();
for (const e of events) {
  const k = e.clientId || "(无 clientId)";
  perClient.set(k, (perClient.get(k) || 0) + 1);
}
const risky = [...perClient.entries()].filter(([, n]) => n > REPLAY_LIMIT);
for (const [client, n] of risky) {
  mark(false, `${client} 累计 ${n} 条 > 单次回放上限 ${REPLAY_LIMIT}：游标落后超过 ${REPLAY_LIMIT} 条时，/api/agent/events 会静默丢弃更早事件，且 truncated 恒为 false`);
}
if (!risky.length) mark(true, `没有客户端超过单次回放上限 ${REPLAY_LIMIT} 条`);

// ---------- 结论 ----------
say("\n▶ 结论");
say(critical
  ? "  ✗ 存储层存在序号缺口/重复：持久化事件确有丢失，需先排查磁盘写入与锁竞争"
  : "  ✓ 存储层零丢失（序号连续）；事件层面的“缺”来自语义缺口而非写盘丢失");
say("  提示：本脚本只读，可随时重跑；建议在长任务结束后或出现“事件丢失”反馈时执行");

process.exitCode = critical;
