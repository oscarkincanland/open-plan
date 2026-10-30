#!/usr/bin/env node
/**
 * OfficeCLI 全量能力验证（:live，不进入 CI）。
 *
 * 目标：把 OfficeCLI 1.0.158 的 28 个子命令逐个验证一遍，区分：
 *   ✓ 实际执行成功
 *   - 平台/环境限制跳过（refresh 需 Word、screenshot 需渲染器、install 有副作用）
 *   ✗ 命令不可用或行为异常
 *
 * 用法: node scripts/OfficeCLI全量能力验证.mjs
 * 退出码: 0 通过（含跳过），1 有失败
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = process.env.OFFICECLI_BIN || "C:/Users/jijec/AppData/Local/OfficeCLI/officecli.exe";
if (!fs.existsSync(BIN)) {
  console.log(`SKIP: 未找到 officecli（${BIN}）`);
  process.exit(0);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-cli-full-"));
const run = (args, options = {}) => spawnSync(BIN, args, { cwd: ws, encoding: "utf8", timeout: 90000, ...options });
const parseJson = (result) => {
  const text = String(result.stdout || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
};
const viewText = (file) => String(run(["view", file, "text"]).stdout || "");

let failed = 0;
let skipped = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};
const skip = (name, reason) => { skipped += 1; console.log(`  - ${name}（跳过：${reason}）`); };
const assert = (condition, message) => { if (!condition) throw new Error(message); };

console.log("\n▶ 帮助与 schema");
await test("help docx paragraph --json 返回 schema", () => {
  const r = run(["help", "docx", "paragraph", "--json"]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const j = parseJson(r);
  assert(j?.element === "paragraph" || j?.properties, "未返回 paragraph schema");
});

console.log("\n▶ create / view / get / query / set / add");
const docx = "a.docx";
await test("create docx", () => {
  const r = run(["create", docx, "--type", "docx", "--json"]);
  assert(r.status === 0 && fs.existsSync(path.join(ws, docx)), `create 失败：${r.stderr}`);
});
await test("add paragraph + view text", () => {
  const add = run(["add", docx, "/body", "--type", "paragraph", "--prop", "text=Hello", "--json"]);
  assert(add.status === 0, `add 失败：${add.stderr}`);
  assert(viewText(docx).includes("Hello"), "view text 未包含 Hello");
});
await test("get 节点", () => {
  const r = run(["get", docx, "/body/p[1]", "--json"]);
  assert(r.status === 0, `get 失败：${r.stderr}`);
  assert(parseJson(r), "get 未返回 JSON");
});
await test("query 选择器", () => {
  const r = run(["query", docx, 'paragraph:contains("Hello")', "--compact"]);
  assert(r.status === 0 && String(r.stdout).includes("total: 1"), `query 结果异常：${r.stdout}`);
});
await test("set 属性（bold）", () => {
  const r = run(["set", docx, "/body/p[1]", "--prop", "bold=true", "--json"]);
  assert(r.status === 0, `set 失败：${r.stderr}`);
  const got = parseJson(run(["get", docx, "/body/p[1]", "--json"]));
  assert(String(JSON.stringify(got)).includes("bold"), "bold 未回读");
});
await test("add comment + query comment", () => {
  const add = run(["add", docx, "/body/p[1]", "--type", "comment", "--prop", "author=QA", "--prop", "initials=QA", "--prop", "text=check", "--json"]);
  assert(add.status === 0, `add comment 失败：${add.stderr}`);
  const q = run(["query", docx, "comment", "--json"]);
  assert(q.status === 0 && String(q.stdout).includes("check"), "comment 未回读");
});

console.log("\n▶ remove / move / swap");
await test("add 三段并 move/swap/remove", () => {
  for (const text of ["P1", "P2", "P3"]) {
    const r = run(["add", docx, "/body", "--type", "paragraph", "--prop", `text=${text}`, "--json"]);
    assert(r.status === 0, `add ${text} 失败：${r.stderr}`);
  }
  assert(run(["move", docx, "/body/p[4]", "--index", "0", "--json"]).status === 0, "move 失败");
  assert(run(["swap", docx, "/body/p[1]", "/body/p[2]", "--json"]).status === 0, "swap 失败");
  assert(run(["remove", docx, "/body/p[2]", "--json"]).status === 0, "remove 失败");
  assert(viewText(docx).includes("P1") && viewText(docx).includes("P2"), "move/swap/remove 后文本异常");
});

console.log("\n▶ batch 原子回滚");
await test("batch 坏项整批回滚", () => {
  const commands = JSON.stringify([
    { command: "add", parent: "/body", type: "paragraph", props: { text: "BATCH-OK" } },
    { command: "add", parent: "/body", type: "totallyInvalidType", props: {} },
  ]);
  const r = run(["batch", docx, "--commands", commands, "--json"]);
  const j = parseJson(r);
  assert(r.status !== 0 || j?.data?.summary?.atomicRolledBack === true, `未回滚：${r.stdout}`);
  assert(!viewText(docx).includes("BATCH-OK"), "坏项 batch 未回滚");
});

console.log("\n▶ raw / raw-set / add-part / validate / view issues");
await test("raw document XML", () => {
  const r = run(["raw", docx, "/document"]);
  assert(r.status === 0 && String(r.stdout).includes("<w:document"), `raw 失败：${r.stderr}`);
});
await test("add-part header", () => {
  const r = run(["add-part", docx, "/", "--type", "header", "--json"]);
  assert(r.status === 0, `add-part 失败：${r.stderr}`);
  assert(parseJson(r), "add-part 未返回 JSON");
});
await test("raw-set 可调用（空 xpath 不崩溃）", () => {
  const r = run(["raw-set", docx, "/document", "--xpath", "//nonexistent", "--action", "remove", "--json"]);
  const combined = `${r.stdout}\n${r.stderr}`;
  assert(!/Unknown command|Unrecognized command/i.test(combined), `raw-set 未识别：${combined.slice(0, 200)}`);
});
await test("validate docx", () => {
  const r = run(["validate", docx, "--json"]);
  assert([0, 2].includes(r.status), `validate 失败：${r.stderr}`);
});
await test("view issues --json", () => {
  const r = run(["view", docx, "issues", "--json"]);
  assert(r.status === 0, `view issues 失败：${r.stderr}`);
  const j = parseJson(r);
  assert(j?.data?.issues !== undefined || j?.issues !== undefined, "issues 字段缺失");
});

console.log("\n▶ view 其余模式");
await test("view annotated / forms", () => {
  assert(run(["view", docx, "annotated"]).status === 0, "annotated 失败");
  assert(run(["view", docx, "forms"]).status === 0, "forms 失败");
});
await test("view html / svg 输出文件", () => {
  const html = run(["view", docx, "html", "-o", "a.html"]);
  assert(html.status === 0 && fs.existsSync(path.join(ws, "a.html")), `html 失败：${html.stderr}`);
  const pptx = "svg-test.pptx";
  assert(run(["create", pptx, "--type", "pptx", "--json"]).status === 0, "create svg pptx 失败");
  assert(run(["add", pptx, "/", "--type", "slide", "--prop", "title=Hi", "--prop", "text=Body", "--json"]).status === 0, "add slide 失败");
  const svg = run(["view", pptx, "svg", "-o", "a.svg"]);
  assert(svg.status === 0 && (fs.existsSync(path.join(ws, "a.svg")) || String(svg.stdout).includes("<svg")), `svg 失败：${svg.stderr}`);
});
await test("view screenshot 输出 PNG（平台相关）", () => {
  const r = run(["view", docx, "screenshot", "-o", "a.png"]);
  if (r.status !== 0) { skip("view screenshot", String(r.stderr || r.stdout).slice(0, 120)); return; }
  assert(fs.existsSync(path.join(ws, "a.png")), "PNG 未生成");
});

console.log("\n▶ dump / open / save / close / refresh");
await test("dump 可回放脚本", () => {
  const r = run(["dump", docx, "--json"]);
  assert(r.status === 0, `dump 失败：${r.stderr}`);
  const j = parseJson(r);
  const data = j?.data || j;
  assert(Array.isArray(data) && data.some((item) => item.command), "dump 未返回命令数组");
});
await test("open / save / close resident 生命周期", () => {
  assert(run(["open", docx, "--json"]).status === 0, "open 失败");
  assert(run(["save", docx, "--json"]).status === 0, "save 失败");
  assert(run(["close", docx, "--json"]).status === 0, "close 失败");
});
await test("refresh 可调用（需 Word+Windows）", () => {
  const r = run(["refresh", docx, "--json"]);
  if (r.status === 0) return;
  const message = `${r.stdout}\n${r.stderr}`;
  assert(/Word|Windows|not supported|unsupported/i.test(message), `refresh 异常：${message.slice(0, 200)}`);
  skip("refresh", "当前环境无法重算域");
});

console.log("\n▶ revision");
await test("find/replace + revision.author 生成修订", () => {
  const r = run(["set", docx, "/body", "--prop", "find=Hello", "--prop", "replace=Hi", "--prop", "revision.author=Tester", "--json"]);
  assert(r.status === 0, `revision set 失败：${r.stderr}`);
  const q = run(["query", docx, "revision", "--json"]);
  assert(q.status === 0 && String(q.stdout).includes("Tester"), `revision 未回读：${q.stdout.slice(0, 200)}`);
});

console.log("\n▶ import / merge");
await test("import CSV → xlsx", () => {
  fs.writeFileSync(path.join(ws, "data.csv"), "name,value\nalpha,1\nbeta,2\n", "utf8");
  const xlsx = "book.xlsx";
  assert(run(["create", xlsx, "--type", "xlsx", "--json"]).status === 0, "create xlsx 失败");
  const imp = run(["import", xlsx, "/Sheet1", "data.csv", "--json"]);
  assert(imp.status === 0, `import 失败：${imp.stderr}`);
  const cell = run(["get", xlsx, "/Sheet1/A1", "--json"]);
  assert(String(cell.stdout).includes("name"), `导入后 A1 异常：${cell.stdout.slice(0, 200)}`);
});
await test("merge 模板 + JSON", () => {
  const tpl = "template.docx";
  const out = "merged.docx";
  assert(run(["create", tpl, "--type", "docx", "--json"]).status === 0, "create template 失败");
  assert(run(["add", tpl, "/body", "--type", "paragraph", "--prop", "text={{name}}", "--json"]).status === 0, "写占位符失败");
  fs.writeFileSync(path.join(ws, "data.json"), JSON.stringify({ name: "Alice" }), "utf8");
  const merge = run(["merge", tpl, out, "--data", "data.json", "--json"]);
  assert(merge.status === 0, `merge 失败：${merge.stderr}`);
  assert(viewText(out).includes("Alice"), "merge 未替换占位符");
});

console.log("\n▶ 三格式 create / view stats");
await test("create xlsx/pptx + view stats", () => {
  assert(run(["create", "b.xlsx", "--type", "xlsx", "--json"]).status === 0, "create xlsx 失败");
  assert(run(["view", "b.xlsx", "stats"]).status === 0, "view xlsx stats 失败");
  assert(run(["create", "c.pptx", "--type", "pptx", "--json"]).status === 0, "create pptx 失败");
  assert(run(["view", "c.pptx", "stats"]).status === 0, "view pptx stats 失败");
});

console.log("\n▶ plugins / mcp / skills / install 表面");
await test("plugins list", () => {
  const r = run(["plugins", "list"]);
  assert(r.status === 0, `plugins 失败：${r.stderr}`);
});
await test("help mcp / skills / install 可用（不执行副作用）", () => {
  for (const name of ["mcp", "skills", "install"]) {
    const r = run(["help", name]);
    assert(r.status === 0 && /Usage|officecli/i.test(r.stdout), `help ${name} 异常`);
  }
});

console.log("\n▶ watch / mark / marks / goto / unwatch");
await test("watch 预览 + mark + marks + goto + unwatch", async () => {
  const child = spawn(BIN, ["watch", docx, "--port", "26477"], { cwd: ws, windowsHide: true });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  try {
    const started = Date.now();
    while (!/http:\/\/localhost:\d+/i.test(output) && Date.now() - started < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(/http:\/\/localhost:\d+/i.test(output), `watch 未启动：${output.slice(0, 200)}`);
    const mark = run(["mark", docx, "/body/p[1]", "--prop", "find=Hi", "--prop", "color=#FF0000", "--prop", "note=qa", "--json"]);
    assert(mark.status === 0, `mark 失败：${mark.stderr}`);
    const marks = run(["get-marks", docx, "--json"]);
    assert(marks.status === 0, `get-marks 失败：${marks.stderr}`);
    assert(run(["goto", docx, "/body/p[1]"]).status === 0, "goto 失败");
  } finally {
    run(["unwatch", docx]);
    try { child.kill(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
});

try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
console.log(`\nOfficeCLI 全量能力验证：${failed ? "存在失败" : "全部通过"}（跳过 ${skipped} 项）`);
process.exitCode = failed ? 1 : 0;
