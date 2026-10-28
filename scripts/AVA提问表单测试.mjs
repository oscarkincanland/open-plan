#!/usr/bin/env node
/**
 * AVA Schema 提问表单测试（v0.13.5）
 *
 * 守护：
 *   1) ask_user 支持 fields（text/select/radio/checkbox/file）；
 *   2) 事件载荷携带 fields，回答接口支持 values；
 *   3) 前端渲染表单、必填校验并序列化为文本回答。
 *
 * 用法：node scripts/AVA提问表单测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const agent = read("server/agent.mjs");
const index = read("server/index.mjs");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const styles = read("client/src/styles.css");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("ask_user 声明 fields 参数与五种字段类型", () => {
  assert.match(agent, /fields: Type\.Optional\(Type\.Array\(Type\.Object\(\{/);
  for (const type of ["text", "select", "radio", "checkbox", "file"]) {
    assert.match(agent, new RegExp(`Type\\.Literal\\("${type}"\\)`), `缺少字段类型 ${type}`);
  }
  assert.match(agent, /const fields = \(Array\.isArray\(params\.fields\)/);
  assert.match(agent, /\.slice\(0, 12\)/);
});

test("ask_user 事件与持久化携带 fields", () => {
  assert.match(agent, /\.\.\.\(fields\.length \? \{ fields \} : \{\}\)/);
  assert.match(agent, /options: opts,\n\s+\.\.\.\(fields\.length \? \{ fields \} : \{\}\),\n\s+status: "pending"/);
});

test("回答接口支持 values 并序列化", () => {
  assert.match(index, /const \{ client, thread, answer, values \} = req\.body \|\| \{\}/);
  assert.match(index, /values && typeof values === "object"/);
  assert.match(index, /Object\.entries\(values\)/);
});

test("前端渲染表单并按字段回填", () => {
  assert.match(chatPanel, /const fields = Array\.isArray\(block\.fields\) \? block\.fields : \[\]/);
  assert.match(chatPanel, /const submitForm = \(\) =>/);
  assert.match(chatPanel, /field\.type === "select"/);
  assert.match(chatPanel, /field\.type === "radio"/);
  assert.match(chatPanel, /field\.type === "checkbox"/);
  assert.match(chatPanel, /field\.type === "file"/);
  assert.match(chatPanel, /field\.required \? " \*" : ""/);
  assert.match(chatPanel, /\.\.\.\(Array\.isArray\(data\.fields\) && data\.fields\.length \? \{ fields: data\.fields \} : \{\}\)/);
});

test("表单样式与待处理条提示存在", () => {
  assert.match(styles, /\.ask-form \{/);
  assert.match(styles, /\.ask-field-input \{/);
  assert.match(chatPanel, /pending-action-form-hint/);
});

console.log(failed ? "\nAVA Schema 提问表单测试：存在失败项" : "\nAVA Schema 提问表单测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
