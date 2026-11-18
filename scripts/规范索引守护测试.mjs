#!/usr/bin/env node
/**
 * 长期规范索引守护测试
 *
 * 覆盖（文档管理规范 §8「AGENTS.md 第 10 节必须列出全部长期规范」「不允许孤儿文档」）：
 *   1. docs/规范/ 下的每份规范都被 AGENTS.md §10 索引；
 *   2. AGENTS.md §10 索引的每份规范都真实存在；
 *   3. 没有 0 字节的规范；
 *   4. 每份规范都有状态、基线、更新日期（文档管理规范 §4）；
 *   5. 状态为"生效"的规范必须真的被代码或已采纳 ADR 引用（草案不得被当作实施依据）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = path.join(ROOT, "docs", "规范");
const AGENTS = path.join(ROOT, "AGENTS.md");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const agents = fs.readFileSync(AGENTS, "utf8");
const indexSection = agents.split("## 10. 规范索引")[1]?.split("## 11.")[0] || "";
const specs = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith(".md"));
const linked = [...indexSection.matchAll(/docs\/规范\/([^)]+\.md)/g)].map((m) => m[1]);

test("全部长期规范都被 AGENTS.md §10 索引", () => {
  const orphan = specs.filter((f) => !linked.includes(f));
  assert.deepEqual(orphan, [], `以下规范未被索引：${orphan.join("、")}`);
});

test("索引的规范链接都指向真实文件", () => {
  const missing = linked.filter((f) => !fs.existsSync(path.join(SPEC_DIR, f)));
  assert.deepEqual(missing, [], `以下索引链接指向的文件不存在：${missing.join("、")}`);
});

test("没有 0 字节的规范", () => {
  const empty = specs.filter((f) => fs.statSync(path.join(SPEC_DIR, f)).size === 0);
  assert.deepEqual(empty, [], `以下规范是空文件：${empty.join("、")}`);
});

test("每份规范都有状态、版本、基线与更新日期", () => {
  const missing = [];
  for (const file of specs) {
    const src = fs.readFileSync(path.join(SPEC_DIR, file), "utf8");
    if (!/状态[:：]/.test(src)) missing.push(`${file}(缺状态)`);
    else if (!/版本[:：]/.test(src)) missing.push(`${file}(缺版本)`);
    else if (!/基线[:：]/.test(src)) missing.push(`${file}(缺基线)`);
    else if (!/更新[:：]/.test(src)) missing.push(`${file}(缺更新日期)`);
  }
  assert.deepEqual(missing, [], `以下规范缺少头部元信息：${missing.join("、")}`);
});

test("生效状态的规范都被代码或文档引用（不是孤儿）", () => {
  const unreferenced = [];
  const corpus = [
    ...["server", "client/src", "scripts"].flatMap((dir) => walk(path.join(ROOT, dir))),
    ...walk(path.join(ROOT, "docs")),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const file of specs) {
    const src = fs.readFileSync(path.join(SPEC_DIR, file), "utf8");
    const status = src.match(/状态[:：]\s*([^（(\n]+)/)?.[1]?.trim() || "";
    if (status !== "生效") continue;
    const name = file.replace(/\.md$/, "");
    if (!corpus.includes(name) && !corpus.includes(file)) unreferenced.push(file);
  }
  assert.deepEqual(unreferenced, [], `以下规范标为生效但无人引用：${unreferenced.join("、")}`);
});

test("规范引用的 test:* 都在 package.json 存在（未落地项白名单）", () => {
  // 已声明「随计划落地」但当前不存在的别名；新增白名单必须带原因与落地计划号。
  const DECLARED_PENDING = new Set(["test:e2e:live", "test:test-quality"]);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {};
  const sources = [AGENTS, ...specs.map((f) => path.join(SPEC_DIR, f))];
  const missing = new Set();
  for (const file of sources) {
    const src = fs.readFileSync(file, "utf8");
    for (const match of src.matchAll(/`?(test:[a-zA-Z0-9:_-]+)`?/g)) {
      const name = match[1].replace(/[.,，。)]+$/, "");
      if (name.endsWith(":") || name.endsWith("-")) continue; // 通配写法 test:map-* / test:memory*
      if (DECLARED_PENDING.has(name)) continue;
      // `test:memory 相关项` 这类族前缀写法：只要有同前缀脚本就算可解析。
      const asPrefix = Object.keys(scripts).some((key) => key.startsWith(`${name}-`) || key.startsWith(`${name}:`));
      if (!scripts[name] && !asPrefix) missing.add(`${path.basename(file)} → ${name}`);
    }
  }
  assert.deepEqual([...missing], [], `以下 test:* 在 package.json 不存在：${[...missing].join("、")}`);
});

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
      out.push(...walk(full));
    } else if (/\.(mjs|js|jsx|md|json)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

console.log(failed ? "\n规范索引守护测试：存在失败" : "\n规范索引守护测试：全部通过");
process.exitCode = failed ? 1 : 0;
