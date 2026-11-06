#!/usr/bin/env node
/**
 * 决策记录索引守护测试
 *
 * 覆盖（文档管理规范 §8「不允许孤儿文档」）：
 *   1. 索引里的每条 ADR 链接都指向真实文件；
 *   2. 目录里的每份 ADR 都被索引收录；
 *   3. 没有 0 字节的 ADR（曾出现 fb4f07ca 把 0016 覆盖成空文件的事故）；
 *   4. 每份 ADR 有状态行，且"被替代"的记录指向存在的替代文档；
 *   5. ADR 编号唯一（曾出现两条分支各自占用 0012/0013/0014，Git 只在索引表报冲突，
 *      同号不同文的 ADR 文件会静默并存，必须由本测试拦下）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIR = path.join(ROOT, "docs", "决策记录");
const INDEX = path.join(ADR_DIR, "决策记录索引.md");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const indexSrc = fs.readFileSync(INDEX, "utf8");
const links = [...indexSrc.matchAll(/\((0\d{3}-[^)]+\.md)\)/g)].map((m) => m[1]);
const files = fs.readdirSync(ADR_DIR).filter((f) => /^\d{4}-.*\.md$/.test(f));

test("索引收录了全部 ADR", () => {
  const orphan = files.filter((f) => !links.includes(f));
  assert.deepEqual(orphan, [], `以下 ADR 未被索引收录：${orphan.join("、")}`);
});

test("索引链接都指向真实文件", () => {
  const missing = links.filter((f) => !fs.existsSync(path.join(ADR_DIR, f)));
  assert.deepEqual(missing, [], `以下索引链接指向的文件不存在：${missing.join("、")}`);
});

test("没有 0 字节的 ADR", () => {
  const empty = files.filter((f) => fs.statSync(path.join(ADR_DIR, f)).size === 0);
  assert.deepEqual(empty, [], `以下 ADR 是空文件：${empty.join("、")}`);
});

test("每份 ADR 都有状态与日期", () => {
  // 既有 ADR 的日期有三种写法（`日期：`、`记录日期：`，或写在状态行里），只要求可识别，
  // 不强行统一历史文档的头部风格。
  const missing = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(ADR_DIR, file), "utf8");
    if (!/状态[:：]/.test(src)) { missing.push(`${file}(缺状态)`); continue; }
    const hasDate = /(记录日期|日期)[:：]\s*\d{4}-\d{2}-\d{2}/.test(src)
      || /状态[:：][^\n]*\d{4}-\d{2}-\d{2}/.test(src);
    if (!hasDate) missing.push(`${file}(缺日期)`);
  }
  assert.deepEqual(missing, [], `以下 ADR 缺少头部元信息：${missing.join("、")}`);
});

test("标注「被替代」的 ADR 指向存在的替代文档", () => {
  const bad = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(ADR_DIR, file), "utf8");
    const replaced = src.match(/被\s*(\d{4})\s*替代/);
    if (!replaced) continue;
    const target = files.find((f) => f.startsWith(replaced[1] + "-"));
    if (!target) bad.push(`${file} → 替代文档 ${replaced[1]} 不存在`);
  }
  assert.deepEqual(bad, [], bad.join("；"));
});

test("索引头部状态与更新日期齐全", () => {
  assert.match(indexSrc, /状态：/);
  assert.match(indexSrc, /更新：/);
  assert.match(indexSrc, /基线：/);
});

test("ADR 编号唯一（不允许同号不同文）", () => {
  const byNumber = new Map();
  for (const file of files) {
    const number = file.slice(0, 4);
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push(file);
  }
  const duplicated = [...byNumber.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([number, list]) => `${number}: ${list.join("、")}`);
  assert.deepEqual(duplicated, [], `以下 ADR 编号重复：${duplicated.join("；")}`);
});

console.log(failed ? "\n决策记录索引守护测试：存在失败" : "\n决策记录索引守护测试：全部通过");
process.exitCode = failed ? 1 : 0;
