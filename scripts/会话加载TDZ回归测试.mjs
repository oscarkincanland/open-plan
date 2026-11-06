#!/usr/bin/env node
/**
 * 会话加载 TDZ 回归测试。
 *
 * ## 背景（2026-11-02）
 *
 * 用户反馈"切换不了会话"，界面报：
 *   `加载会话失败: Cannot access 'Yn' before initialization`
 *
 * 实测堆栈落在压缩包的会话加载分支；还原源码后是**同一函数里先用后声明**：
 * 第 1520 行读 `resumeResult`，而它的 `const resumeResult = await resumePromise;`
 * 在第 1593 行。块级作用域变量在声明前处于 TDZ，读取即抛 ReferenceError——
 * **每次切会话必炸**。
 *
 * 成因是收敛合并（ee641737）的冲突误判：把"恢复失败立即标只读"的写法搬了过来，
 * 却丢了它前面的 `await`；而另一条分支（082e7bea 会话加载解耦）为了让历史先显示，
 * 特意把 await 移到后面。两者拼在一起就成了 TDZ。
 *
 * ## 本测试守护的三条
 *
 *   1. 不允许在声明之前读 `resumeResult`（本次 bug）；
 *   2. 早期分支不得改成"先 await resume"——那会退回"切会话要等恢复"的旧行为；
 *   3. 早期只读判断必须走 `resumeSettled`（结算标记），保证"恢复失败尽早标只读"的原意不丢。
 *
 * 说明：这是**结构断言**（读源码），不是运行时验证；运行时验证由人工/浏览器冒烟完成。
 * 之所以不用通用 TDZ 静态检查：仓库没有可用的 JS 解析器（无 acorn/@babel），
 * 正则启发式在同一文件上会产出上百条解构/跨作用域误报，得不偿失。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const DECL = "const resumeResult = await resumePromise;";
const declIndex = source.indexOf(DECL);
const earlyIndex = source.indexOf("setSessionResumeError(resumeSettled && !resumeSettled.ok");

test("resumeResult 有且只声明一次", () => {
  assert.ok(declIndex > 0, "找不到 const resumeResult = await resumePromise;");
  assert.equal(source.split(DECL).length - 1, 1, "声明只能出现一次");
});

test("声明之前不得读取 resumeResult（本次 TDZ 的直接原因）", () => {
  const before = source.slice(0, declIndex);
  // 注释里提到这个名字是允许的；这里只禁止真实引用。
  const code = before.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(
    code.includes("resumeResult"),
    false,
    "resumeResult 在声明之前被引用：块级作用域变量此时处于 TDZ，运行时会抛 Cannot access ... before initialization",
  );
});

test("历史优先显示：早期分支不得等待 resume", () => {
  assert.ok(earlyIndex > 0, "找不到早期只读判断（setSessionResumeError(resumeSettled...)）");
  // 直接看本函数区间：从 resumePromise 的声明到早期只读判断之间。
  // 不能从文件开头切——那里还有 retrySessionResume 等其它函数，其中的 await 与本分支无关。
  const promiseDecl = source.indexOf("const resumePromise = resumeAgentThread(");
  assert.ok(promiseDecl > 0, "找不到 resumePromise 的声明");
  assert.ok(promiseDecl < earlyIndex, "早期只读判断应在 resumePromise 声明之后");
  assert.ok(earlyIndex < declIndex, "早期只读判断应在 await resumePromise 之前");
  const between = source.slice(promiseDecl, earlyIndex)
    // 注释里提到 await resumePromise 是说明性的，不算真实等待。注释剥掉再判断。
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(/await\s+resumePromise/.test(between), false, "早期分支不得 await resumePromise（会让切会话重新等恢复）");
});

test("早期只读判断走结算标记 resumeSettled", () => {
  const settleDecl = source.indexOf("let resumeSettled = null;");
  assert.ok(settleDecl > 0, "缺少 resumeSettled 结算标记");
  assert.ok(settleDecl < earlyIndex, "结算标记必须在早期判断之前声明");
  assert.match(source, /\.then\(\(result\) => \{\s*\n\s*resumeSettled = result;/, "resumePromise 结算后要写入标记");
});

test("关键失败路径带上堆栈（否则只剩一句 message，无法定位）", () => {
  assert.match(source, /window\.__oawLastSessionError = \{ message: e\?\.message, stack: e\?\.stack/, "缺少会话加载失败的堆栈快照");
  assert.match(source, /console\.error\("\[会话加载\]", e\)/, "失败时应把完整错误打到控制台");
});

if (failed) {
  console.error("\n会话加载 TDZ 回归测试：存在失败项");
  process.exit(1);
}
console.log("\n会话加载 TDZ 回归测试：全部通过");
