#!/usr/bin/env node
/**
 * 门禁已知失败校验（2026-11-17 P0-2）
 *
 * 背景（见 docs/audits/2026-11-17-全仓缺陷复盘/00-复盘报告.md §3.4）：
 *   仓库长期存在 40 处"既有失败"，提交说明靠一句"与本次无关"豁免。
 *   结果是新增回归和既有失败混在一起，**无法区分**——门禁名存实亡。
 *
 * 本脚本把"既有失败"变成一份**有签名、有责任人、有过期日**的清单：
 *   1) 基线里的套件如果失败，失败输出必须**包含基线登记的特征串**才算"已知"；
 *   2) 出现基线里没有的失败 → 视为新增回归，退出码 1；
 *   3) 基线套件意外通过 → 提示从基线移除（不阻塞）；
 *   4) 基线过期未清 → 退出码 1（防止"永久豁免"）。
 *
 * 用法：
 *   node scripts/已知失败校验.mjs                 # 校验
 *   node scripts/已知失败校验.mjs --update        # 按当前实际结果重写基线（会保留 owner/reason/expires）
 *   node scripts/已知失败校验.mjs --only ui-guard
 *   npm run test:known-failures
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(PROJECT_DIR, "scripts", "门禁已知失败基线.json");
const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const ONLY = (() => {
  const index = args.indexOf("--only");
  return index >= 0 ? args[index + 1] : "";
})();

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`找不到基线文件：${BASELINE_FILE}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
}

/** 从失败输出里抽一行"失败断言"作为签名候选（用于 --update 自动登记）。 */
function extractFailureLines(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("✗"))
    .map((line) => line.replace(/^✗\s*/, "").slice(0, 60));
}

function runSuite(suite) {
  const scriptPath = path.join(PROJECT_DIR, "scripts", `${suite.script}.mjs`);
  if (!fs.existsSync(scriptPath)) {
    return { status: "missing", code: 2, output: `脚本不存在：${suite.script}.mjs` };
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env, OAW_VERIFY_SUITE: suite.id },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return { status: result.status === 0 ? "pass" : "fail", code: result.status, output };
}

const baseline = loadBaseline();
const suites = baseline.suites.filter((suite) => !ONLY || suite.id.includes(ONLY) || suite.script.includes(ONLY));
if (!suites.length) {
  console.error(`没有匹配的套件：${ONLY}`);
  process.exit(2);
}

const rows = [];
const newFailures = [];
const expired = [];
const staleEntries = [];
const updated = [];

for (const suite of suites) {
  const result = runSuite(suite);
  const failureLines = extractFailureLines(result.output);

  if (result.status === "missing") {
    newFailures.push(`${suite.id}：脚本缺失（${suite.script}.mjs）`);
    rows.push({ suite: suite.id, expected: suite.expect, actual: "missing", verdict: "✗ 缺失" });
    continue;
  }

  if (UPDATE) {
    const next = {
      ...suite,
      expect: result.status,
      signatures: result.status === "fail" ? (failureLines.length ? failureLines : suite.signatures) : [],
    };
    updated.push(next);
    rows.push({ suite: suite.id, expected: suite.expect, actual: result.status, verdict: "已更新" });
    continue;
  }

  const expectFail = suite.expect === "fail";
  if (!expectFail && result.status === "fail") {
    newFailures.push(`${suite.id}：基线期望通过，实际失败（不是已知失败）`);
    rows.push({ suite: suite.id, expected: "pass", actual: "fail", verdict: "✗ 新增失败" });
    continue;
  }
  if (expectFail && result.status === "pass") {
    staleEntries.push(suite.id);
    rows.push({ suite: suite.id, expected: "fail", actual: "pass", verdict: "⚠ 已修复，请从基线移除" });
    continue;
  }
  if (!expectFail) {
    rows.push({ suite: suite.id, expected: "pass", actual: "pass", verdict: "✓" });
    continue;
  }

  // 期望失败：失败输出必须命中全部登记签名，否则视为"同套件但不同失败"= 新回归
  const missing = (suite.signatures || []).filter((signature) => !result.output.includes(signature));
  if (missing.length) {
    newFailures.push(`${suite.id}：出现未登记的新失败（未命中签名：${missing.join(" / ")}）\n      实际失败：${failureLines.join("；") || "(无 ✗ 行)"}`);
    rows.push({ suite: suite.id, expected: "fail", actual: "fail", verdict: "✗ 未登记的新失败" });
  } else {
    rows.push({ suite: suite.id, expected: "fail", actual: "fail", verdict: "✓ 已知" });
  }

  if (suite.expires && suite.expires < today()) {
    expired.push(`${suite.id}（过期日 ${suite.expires}，责任人 ${suite.owner || "未指定"}）`);
  }
}

// ---- 输出 ----
console.log("\n▶ 门禁已知失败校验");
console.log(`  基线：${path.relative(PROJECT_DIR, BASELINE_FILE)}　更新：${baseline.updatedAt || "-"}　今日：${today()}`);
for (const row of rows) {
  console.log(`  ${row.verdict.padEnd(22)} ${row.suite}（基线期望 ${row.expected} / 实际 ${row.actual}）`);
}
for (const suite of baseline.suites.filter((item) => !suites.includes(item))) {
  console.log(`  ○ 跳过（未选中）        ${suite.id}`);
}

let code = 0;
if (UPDATE) {
  const next = {
    ...baseline,
    updatedAt: today(),
    suites: baseline.suites.map((suite) => updated.find((item) => item.id === suite.id) || suite),
  };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`\n✓ 已重写基线：${next.suites.filter((item) => item.expect === "fail").length} 条已知失败 / ${next.suites.length} 条登记`);
  process.exit(0);
}
if (newFailures.length) {
  console.error(`\n✗ 发现 ${newFailures.length} 处"不是已知失败"的失败：`);
  for (const item of newFailures) console.error(`  - ${item}`);
  console.error("\n处理方式：修掉它；若确认是可接受的既有问题，请带上原因/责任人/过期日登记进基线（--update 可自动生成签名）。");
  code = 1;
}
if (expired.length) {
  console.error(`\n✗ ${expired.length} 条基线已过期，必须清零或重新评审：`);
  for (const item of expired) console.error(`  - ${item}`);
  code = 1;
}
if (staleEntries.length) {
  console.log(`\n⚠ ${staleEntries.length} 条基线已修复但未移除，请跑 --update 清理：${staleEntries.join("、")}`);
}
if (!code) console.log("\n✓ 已知失败校验通过：没有新增失败，基线未过期");
process.exit(code);
