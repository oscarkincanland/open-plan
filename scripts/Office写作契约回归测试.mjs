#!/usr/bin/env node
/**
 * Office 写作契约回归（CI 第 18 步）。
 * 串行运行：四路由 / 澄清闸门 / 版式规范 / 模板链路 / 验收规则 / 执行闸门。
 * 子脚本各自输出 ✓/✗，CI 包装器据此生成注解。
 *
 * 用法: node scripts/Office写作契约回归测试.mjs
 * 退出码: 0 全部通过，1 有失败
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scripts = [
  "Office路由与澄清测试.mjs",
  "Office澄清闸门测试.mjs",
  "Office排版规范测试.mjs",
  "Office模板链路测试.mjs",
  "Office验收规则测试.mjs",
  "Office执行闸门测试.mjs",
  "Office并发写入验证.mjs",
];

let failed = 0;
for (const name of scripts) {
  console.log(`\n▶ ${name}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit" });
  if (result.status !== 0) {
    failed = 1;
    console.error(`✗ ${name} 失败（exit ${result.status}）`);
  }
}

console.log(failed ? "\nOffice 写作契约回归：存在失败" : "\nOffice 写作契约回归：全部通过");
process.exitCode = failed ? 1 : 0;
