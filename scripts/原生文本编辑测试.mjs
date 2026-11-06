#!/usr/bin/env node
/**
 * 原生文本编辑测试（2026-11-04）
 *
 * 守护「简单文本走原生、批注等精细操作走 CLI」的路由：
 *   1) docx 段落文本/标题样式 set 走原生；
 *   2) docx 普通段落 add 走原生；
 *   3) 批注/图片/表格 add 仍要求 CLI；
 *   4) 原生写回后 view text 能读到新内容。
 *
 * 用法：node scripts/原生文本编辑测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { needsCli, runNativeOfficeCommand } from "../server/文档引擎.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-native-text-"));
const file = path.join(tmp, "测试.docx");
const rel = "测试.docx";

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (error) => { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); },
);

async function makeDoc() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun("原始第一段")] }),
        new Paragraph({ children: [new TextRun("原始第二段")] }),
      ],
    }],
  });
  fs.writeFileSync(file, await Packer.toBuffer(doc));
}

console.log("\n▶ 路由矩阵");
await test("set 段落文本/样式 → 原生", () => {
  assert.equal(needsCli("set", ["set", "a.docx", "/body/p[1]", "--prop", "text=新"]).needsCli, false);
  assert.equal(needsCli("set", ["set", "a.docx", "/body/p[1]", "--prop", "style=Heading1"]).needsCli, false);
});
await test("add 普通段落 → 原生；批注/图片/表格 → CLI", () => {
  assert.equal(needsCli("add", ["add", "a.docx", "/body", "--type", "paragraph", "--prop", "text=新"]).needsCli, false);
  assert.equal(needsCli("add", ["add", "a.docx", "/body", "--type", "comment", "--prop", "text=x"]).needsCli, true);
  assert.equal(needsCli("add", ["add", "a.docx", "/body", "--type", "image", "--prop", "image=x.png"]).needsCli, true);
  assert.equal(needsCli("add", ["add", "a.docx", "/body", "--type", "table"]).needsCli, true);
});
await test("set 批注/复杂属性仍走 CLI", () => {
  assert.equal(needsCli("set", ["set", "a.docx", "/comments/comment[1]", "--prop", "text=x"]).needsCli, true);
  assert.equal(needsCli("set", ["set", "a.docx", "/body/p[1]", "--prop", "bold=true"]).needsCli, true);
});

console.log("\n▶ 原生写回");
await test("set 段落文本 + 标题样式", async () => {
  await makeDoc();
  const result = await runNativeOfficeCommand(["set", rel, "/body/p[1]", "--prop", "text=新的第一段", "--prop", "style=Heading1"], { cwd: tmp });
  assert.ok(result, "应命中原生 set");
  assert.equal(result.engine, "native");
  assert.equal(result.code, 0);
  const view = await runNativeOfficeCommand(["view", rel, "text"], { cwd: tmp });
  assert.match(view.text, /新的第一段/);
  assert.doesNotMatch(view.text, /原始第一段/);
  const xml = await (await import("jszip")).default.loadAsync(fs.readFileSync(file)).then((zip) => zip.file("word/document.xml").async("string"));
  assert.match(xml, /w:pStyle w:val="Heading1"/);
});
await test("add 段落追加到正文", async () => {
  await makeDoc();
  const result = await runNativeOfficeCommand(["add", rel, "/body", "--type", "paragraph", "--prop", "text=新增的段落"], { cwd: tmp });
  assert.ok(result, "应命中原生 add");
  assert.equal(result.engine, "native");
  const view = await runNativeOfficeCommand(["view", rel, "text"], { cwd: tmp });
  assert.match(view.text, /新增的段落/);
  assert.match(view.text, /原始第二段/);
});

console.log("\n▶ 边界");
await test("段落不存在时返回可读错误", async () => {
  await makeDoc();
  const result = await runNativeOfficeCommand(["set", rel, "/body/p[99]", "--prop", "text=x"], { cwd: tmp });
  assert.ok(result);
  assert.equal(result.code, 1);
  assert.match(result.text, /段落不存在/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\n原生文本编辑测试：存在失败项" : "\n原生文本编辑测试：全部通过（7 例）");
process.exit(failed ? 1 : 0);
