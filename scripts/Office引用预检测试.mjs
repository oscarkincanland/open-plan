#!/usr/bin/env node
/**
 * Office 引用预检测试（计划 2026-10-31-003 / N-06）。
 *
 * 覆盖：
 *   1. 引用抽取：--prop src=/image=/attachment=、位置参数、key=value 变体；
 *   2. 引号前缀变体不回归（"src=报告.md" 曾导致物化失败）；
 *   3. 非引用 prop（bold=true 等）不被误判为路径；
 *   4. 预检：磁盘存在 → 通过；磁盘与暂存区都没有 → 返回 missing 且不通过；
 *   5. 引用文件父目录自动创建。
 *
 * 用法: node scripts/Office引用预检测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-refs-"));
const { collectReferencedPaths, preflightOfficeReferences, ensureReferenceDirs, stripUnsupportedOptions } = await load("server/office参数.mjs");

console.log("\n▶ 引用抽取");

await test("--prop src= 形态被抽取", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--type", "markdown", "--prop", "src=ch01.md"]);
  assert.ok(refs.includes("ch01.md"), `应抽取出 ch01.md，实际 ${refs.join(",")}`);
});

await test("--prop image= 形态被抽取（实测漏掉导致 6 次 Image file not found）", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--prop", "image=figs/test.svg"]);
  assert.ok(refs.includes("figs/test.svg"), `应抽取出 figs/test.svg，实际 ${refs.join(",")}`);
});

await test("--prop attachment= 形态被抽取", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--prop", "attachment=附件/表1.xlsx"]);
  assert.ok(refs.includes("附件/表1.xlsx"), `应抽取出附件路径，实际 ${refs.join(",")}`);
});

await test("位置参数形态被抽取（图片直接跟在命令后）", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--type", "image", "figs/chart.png"]);
  assert.ok(refs.includes("figs/chart.png"), `应抽取出 figs/chart.png，实际 ${refs.join(",")}`);
});

await test("svg 扩展名被识别（实测 .work/figs/test.svg 找不到）", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--prop", "src=.work/figs/test.svg"]);
  assert.ok(refs.includes(".work/figs/test.svg"), `应抽取出 svg 路径，实际 ${refs.join(",")}`);
});

await test("key=value 变体（引号残留）被正确剥前缀", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--type", "markdown", "--prop", "src=\"ch01.md\""]);
  assert.ok(refs.includes("ch01.md"), `应剥掉引号与 key= 前缀，实际 ${refs.join(",")}`);
});

await test("非引用 prop 不被误判为路径", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--prop", "bold=true", "--prop", "text=正文"]);
  assert.equal(refs.includes("bold=true"), false);
  assert.equal(refs.includes("text=正文"), false);
});

await test("绝对路径与越界路径不被当作工作区引用", () => {
  const refs = collectReferencedPaths(["add", "报告.docx", "/", "--prop", "src=C:/Windows/x.md"]);
  assert.equal(refs.includes("C:/Windows/x.md"), false, "绝对路径应排除");
});

await test("--input 形态被抽取", () => {
  const refs = collectReferencedPaths(["import", "--input", "data.json"]);
  assert.ok(refs.includes("data.json"));
});

await test("抽取结果去重", () => {
  const refs = collectReferencedPaths([
    "add", "报告.docx", "/", "--prop", "src=a.md",
    "add", "报告.docx", "/", "--prop", "src=a.md",
  ]);
  assert.equal(refs.filter((item) => item === "a.md").length, 1);
});

await test("命令的目标文件不算引用（否则 create 会被误判为缺失）", () => {
  const create = collectReferencedPaths(["create", "新文档.docx"]);
  assert.equal(create.includes("新文档.docx"), false, "create 的目标文件不是引用");
  const add = collectReferencedPaths(["add", "报告.docx", "/", "--type", "markdown", "--prop", "src=ch01.md"]);
  assert.equal(add.includes("报告.docx"), false, "add 的目标文件不是引用");
  assert.ok(add.includes("ch01.md"), "真正的引用仍要被抽出来");
});

console.log("\n▶ 引用预检");

await test("磁盘上存在的引用 → 预检通过", () => {
  const dir = path.join(tmp, "exist");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ch01.md"), "# 第一章");
  const result = preflightOfficeReferences(["ch01.md"], dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

await test("磁盘上不存在的引用 → 返回 missing 且不通过", () => {
  const dir = path.join(tmp, "missing");
  fs.mkdirSync(dir, { recursive: true });
  const result = preflightOfficeReferences([".work/figs/test.svg"], dir);
  assert.equal(result.ok, false, "缺失引用必须不通过");
  assert.deepEqual(result.missing, [".work/figs/test.svg"]);
});

await test("暂存区里存在的路径视为存在（物化后不会误报）", () => {
  const dir = path.join(tmp, "staged");
  fs.mkdirSync(dir, { recursive: true });
  const result = preflightOfficeReferences(["ch01.md"], dir, ["ch01.md"]);
  assert.equal(result.ok, true, "已物化的路径不应报缺失");
});

await test("create 场景：目标文件不存在也放行（新建本就尚不存在）", () => {
  const dir = path.join(tmp, "create");
  fs.mkdirSync(dir, { recursive: true });
  const refs = collectReferencedPaths(["create", "新文档.docx"]);
  assert.deepEqual(refs, [], "create 不应产生任何引用");
  const result = preflightOfficeReferences(refs, dir);
  assert.equal(result.ok, true, "create 不得被引用预检阻断");
});

await test("父目录自动创建（figs/ 不存在时）", () => {
  const dir = path.join(tmp, "mkdir");
  fs.mkdirSync(dir, { recursive: true });
  const result = preflightOfficeReferences([".work/figs/test.svg"], dir);
  assert.ok(fs.existsSync(path.join(dir, ".work", "figs")), "父目录应被创建");
  assert.ok(result.createdDirs.length > 0, "应报告创建了哪些目录");
});

await test("父目录创建不越界（../ 之外的绝对路径被跳过）", () => {
  const dir = path.join(tmp, "escape");
  fs.mkdirSync(dir, { recursive: true });
  const created = ensureReferenceDirs(["../outside/a.md", "C:/temp/b.md"], dir);
  assert.equal(created.length, 0, "越界路径不应建目录");
});

await test("预检不修改工作区外的任何文件", () => {
  const dir = path.join(tmp, "safe");
  fs.mkdirSync(dir, { recursive: true });
  const before = fs.readdirSync(path.dirname(dir)).length;
  preflightOfficeReferences(["../x.md"], dir);
  assert.equal(fs.readdirSync(path.dirname(dir)).length, before, "不应在父目录创建文件");
});

console.log("\n▶ 子命令选项合法性（--compact 只在 query 有效）");

await test("get 上的 --compact 被剥掉（实测误用 9 次导致命令失败）", () => {
  const result = stripUnsupportedOptions(["get", "报告.docx", "/body/p[1]", "--compact", "--json"]);
  assert.equal(result.stripped.includes("--compact"), true, "应记录被剥掉的选项");
  assert.equal(result.args.includes("--compact"), false, "剥离后不应再含 --compact");
  assert.ok(result.args.includes("--json"), "合法选项必须保留");
  assert.ok(result.args.includes("/body/p[1]"), "位置参数必须保留");
});

await test("query 上的 --compact / --fields 保留", () => {
  const result = stripUnsupportedOptions(["query", "报告.docx", "paragraph", "--compact", "--fields", "style"]);
  assert.deepEqual(result.stripped, [], "query 支持 --compact/--fields，不应剥");
  assert.ok(result.args.includes("--compact"));
  assert.ok(result.args.includes("--fields"));
});

await test("set 上的 --find / --replace 保留", () => {
  const result = stripUnsupportedOptions(["set", "报告.docx", "/", "--find", "a", "--replace", "b"]);
  assert.deepEqual(result.stripped, []);
});

await test("view 上的 -o 保留，get 上的 --depth 保留", () => {
  assert.deepEqual(stripUnsupportedOptions(["view", "报告.docx", "html", "-o", "out.html"]).stripped, []);
  assert.deepEqual(stripUnsupportedOptions(["get", "报告.docx", "/", "--depth", "3"]).stripped, []);
});

await test("未知命令不做处理（保守放行）", () => {
  const result = stripUnsupportedOptions(["somecmd", "a.docx", "--whatever"]);
  assert.deepEqual(result.stripped, [], "未知命令不应被干预");
  assert.equal(result.args.length, 3);
});

console.log(failed ? "\n✗ 引用预检测试存在失败项\n" : "\n✓ 引用预检测试全部通过\n");
process.exit(failed ? 1 : 0);