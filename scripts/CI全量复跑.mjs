#!/usr/bin/env node
/**
 * CI 全量复跑：按 .github/workflows/ci.yml 里声明的步骤逐个执行并统计红绿。
 *
 * 用途：
 *   1. 本地/CI 前一次性复跑全部步骤，替代人工逐条执行；
 *   2. 发现"CI 引用了已删除的脚本"这类配置漂移（脚本缺失会被单独报出）。
 *
 * 退出码：0 = 全部通过；1 = 有失败或脚本缺失。
 * 用法：node scripts/CI全量复跑.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI_FILE = path.join(ROOT, ".github", "workflows", "ci.yml");

if (!fs.existsSync(CI_FILE)) {
  console.error(`找不到 CI 配置：${CI_FILE}`);
  process.exit(2);
}
const ci = fs.readFileSync(CI_FILE, "utf8");
const suites = [...ci.matchAll(/CI运行测试\.mjs\s+(\S+)/g)].map((m) => m[1]);
const unique = [...new Set(suites)];
if (!unique.length) {
  console.error("CI 配置里没有解析到测试步骤");
  process.exit(2);
}
console.log(`CI 声明测试步骤 ${unique.length} 个`);

const failed = [];
const missing = [];
for (const suite of unique) {
  const file = path.join(ROOT, "scripts", `${suite}.mjs`);
  if (!fs.existsSync(file)) {
    missing.push(suite);
    console.log(`  ✗ ${suite}（脚本缺失）`);
    continue;
  }
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code === 0) {
    console.log(`  ✓ ${suite}`);
  } else {
    failed.push(suite);
    console.log(`  ✗ ${suite}（退出码 ${code}）`);
  }
}

console.log(`\n通过 ${unique.length - failed.length - missing.length} / 失败 ${failed.length} / 脚本缺失 ${missing.length}`);
if (failed.length) console.log(`失败：${failed.join("、")}`);
if (missing.length) console.log(`脚本缺失：${missing.join("、")}`);
process.exit(failed.length || missing.length ? 1 : 0);
