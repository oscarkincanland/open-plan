#!/usr/bin/env node
/**
 * 提交门禁检查（2026-11-17 P1-1）
 *
 * 依据：AGENTS.md §7.0（文档先行）+ §7.1（提交门禁）+ ADR 0013。
 * 背景（见 docs/audits/2026-11-17-全仓缺陷复盘/00-复盘报告.md §6.1）：
 *   闸门上线后 27 个非文档提交里只有 6 个带计划（22%）；
 *   `2026-11-14-001/002` 两份计划文件甚至第一次出现就和实现进了同一个提交。
 *   靠自觉无法执行，必须机器可判。
 *
 * 检查项：
 *   R1（失败）新增 docs/plans/*.md 且同一提交改了 client/ 或 server/ → "计划与实现同提交"。
 *   R2（失败）提交信息声称的计划文件在本次提交里是**新增**却没有先落地 → 同 R1 的变体。
 *   R3（警告）改了 client/src 或 server/ 但没有测试文件伴随 → 提示补测试或说明。
 *   R4（警告）改了 client/ 或 server/ 但提交信息没有需求/缺陷/计划线索 → 提示写清依据。
 *
 * 用法：
 *   node scripts/提交门禁检查.mjs                 # 检查 HEAD
 *   node scripts/提交门禁检查.mjs <commit>
 *   node scripts/提交门禁检查.mjs --range origin/develop..HEAD
 *   npm run check:commit-gate
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rangeIndex = args.indexOf("--range");

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: PROJECT_DIR, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${gitArgs.join(" ")} 失败`);
  return result.stdout;
}

/** 逐提交读取：标题、正文、变更文件列表（含 A/M/D 状态）。 */
function readCommits(ref) {
  const listArgs = rangeIndex >= 0
    ? ["log", "--format=%H%x00%s%x00%b%x00===", args[rangeIndex + 1]]
    : ["log", "-1", "--format=%H%x00%s%x00%b%x00===", ref || "HEAD"];
  const raw = git(listArgs);
  return raw
    .split("===\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, subject, body] = chunk.split("\u0000");
      const nameStatus = git(["-c", "core.quotepath=false", "show", "--name-status", "--format=", hash])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, ...rest] = line.split("\t");
          return { status: status[0], file: rest[rest.length - 1] };
        });
      return { hash: hash.slice(0, 8), subject: subject || "", body: body || "", files: nameStatus };
    });
}

const PLAN_RE = /^docs\/plans\/.+\.md$/i;
const CODE_RE = /^(client\/src\/|server\/)/i;
const TEST_RE = /(scripts\/.+测试\.mjs|scripts\/.+回归测试\.mjs|\.test\.|\.spec\.)/i;
const CLUE_RE = /(docs\/plans\/|计划|R\d{1,2}\b|缺陷|修复|fix|feat|refactor|审查|规范)/i;

function checkCommit(commit) {
  const failures = [];
  const warnings = [];
  const addedPlans = commit.files.filter((item) => item.status === "A" && PLAN_RE.test(item.file));
  const touchedPlans = commit.files.filter((item) => PLAN_RE.test(item.file));
  const touchedCode = commit.files.filter((item) => CODE_RE.test(item.file) && item.status !== "D");
  const touchedTests = commit.files.filter((item) => TEST_RE.test(item.file));

  if (addedPlans.length && touchedCode.length) {
    failures.push(
      `计划与实现同提交：新增计划 ${addedPlans.map((item) => path.basename(item.file)).join("、")}`
      + `，同时改了 ${touchedCode.length} 个代码文件。请先单独提交计划（§7.0 文档先行），实现提交再引用计划号。`,
    );
  }
  if (touchedPlans.length && !addedPlans.length && touchedCode.length) {
    // 修改既有计划 + 改代码允许（同步口径），但若提交信息没有任何计划号线索则提示
    if (!/docs\/plans\/|20\d{2}-\d{2}-\d{2}-\d{3}/.test(`${commit.subject} ${commit.body}`)) {
      warnings.push("同一提交改了计划文档与代码，但提交信息未引用计划号/路径");
    }
  }
  if (touchedCode.length && !touchedTests.length) {
    warnings.push(`改了 ${touchedCode.length} 个代码文件但没有测试文件伴随（§7.1-2 要求新增行为/缺陷修复有测试）`);
  }
  if (touchedCode.length && !CLUE_RE.test(`${commit.subject} ${commit.body}`)) {
    warnings.push("提交信息没有需求编号/缺陷/计划线索（§7.1-1 功能明确）");
  }
  return { commit, failures, warnings };
}

const commits = readCommits(rangeIndex >= 0 ? "" : args[0]);
let failureCount = 0;
let warningCount = 0;
const lines = [];

for (const commit of commits) {
  const result = checkCommit(commit);
  const head = `  ${result.commit.hash} ${result.commit.subject.slice(0, 60)}`;
  if (!result.failures.length && !result.warnings.length) {
    lines.push(`${head}  ✓`);
    continue;
  }
  lines.push(head);
  for (const item of result.failures) {
    lines.push(`      ✗ ${item}`);
    failureCount += 1;
  }
  for (const item of result.warnings) {
    lines.push(`      ⚠ ${item}`);
    warningCount += 1;
  }
}

console.log(`\n▶ 提交门禁检查（${rangeIndex >= 0 ? args[rangeIndex + 1] : commits[0]?.hash || "HEAD"}，共 ${commits.length} 个提交）`);
console.log(lines.join("\n"));
if (!failureCount && !warningCount) console.log("  ✓ 全部提交满足「计划不与实现同提交」的最低约束");
else console.log(`\n  失败 ${failureCount} 项，警告 ${warningCount} 项`);
if (failureCount) {
  console.error("\n✗ 提交门禁检查失败：请拆分提交（计划先行），再提交实现");
  process.exit(1);
}
console.log("\n✓ 提交门禁检查通过（警告不阻塞，但请按 §7.1 补齐依据/测试）");
process.exit(0);
