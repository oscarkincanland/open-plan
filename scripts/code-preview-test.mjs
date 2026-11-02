#!/usr/bin/env node
/**
 * P3 源码预览契约测试：
 * 服务端扩展名分类（代码/文本/HTML）、2MB 截断与二进制拒绝；
 * DocViewer 懒加载 CodeViewer、预览/源码切换；CodeViewer 只读。
 *
 * 用法: node scripts/code-preview-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const preview = await import(pathToFileURL(path.join(ROOT, "server/preview-types.mjs")).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-code-preview-"));

console.log("\n▶ 服务端分类");

test("代码扩展名进入源码类型，Markdown/HTML/SVG 不进入", () => {
  for (const ext of ["js", "mjs", "ts", "tsx", "jsx", "py", "json", "css", "yml", "sh", "ps1", "sql", "go", "rs", "c", "cpp"]) {
    assert.equal(preview.isCodeExt(ext), true, `${ext} 应为代码`);
  }
  for (const ext of ["html", "htm", "svg", "md", "markdown", "txt", "csv", "docx", "pdf"]) {
    assert.equal(preview.isCodeExt(ext), false, `${ext} 不应进入代码类型`);
  }
  assert.equal(preview.isTextExt("md"), true);
  assert.equal(preview.isTextExt("csv"), true);
  assert.equal(preview.isTextExt("js"), false);
});

test("语言映射覆盖常用格式，未知回退 text", () => {
  assert.equal(preview.codeLanguageFor("js"), "javascript");
  assert.equal(preview.codeLanguageFor("tsx"), "tsx");
  assert.equal(preview.codeLanguageFor("py"), "python");
  assert.equal(preview.codeLanguageFor("json"), "json");
  assert.equal(preview.codeLanguageFor("md"), "markdown");
  assert.equal(preview.codeLanguageFor("unknown"), "text");
});

console.log("\n▶ 读取与截断");

test("普通文本读取", () => {
  const file = path.join(tmp, "a.js");
  fs.writeFileSync(file, "const a = 1;\n");
  const result = preview.readTextPreview(file);
  assert.equal(result.binary, undefined);
  assert.equal(result.text, "const a = 1;\n");
  assert.equal(result.truncated, false);
});

test("超过上限时截断并标记", () => {
  const file = path.join(tmp, "big.py");
  fs.writeFileSync(file, "x".repeat(5000));
  const result = preview.readTextPreview(file, 1024);
  assert.equal(result.text.length, 1024);
  assert.equal(result.truncated, true);
});

test("含 NUL 的文件判为二进制", () => {
  const file = path.join(tmp, "b.bin");
  fs.writeFileSync(file, Buffer.from([0x41, 0x00, 0x42]));
  assert.equal(preview.readTextPreview(file).binary, true);
});

test("UTF-16 LE/BE 与 GBK 中文可读", () => {
  const le = path.join(tmp, "le.txt");
  fs.writeFileSync(le, Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]));
  assert.equal(preview.readTextPreview(le).text, "中文");
  assert.equal(preview.readTextPreview(le).encoding, "utf-16le");
  const gbk = path.join(tmp, "gbk.txt");
  fs.writeFileSync(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  const gbkResult = preview.readTextPreview(gbk);
  assert.equal(gbkResult.text, "中文");
  assert.equal(gbkResult.encoding, "gb18030");
});

test("Markdown/HTML 预览上限高于源码视图", () => {
  assert.equal(preview.PREVIEW_TEXT_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(preview.PREVIEW_PREVIEW_MAX_BYTES, 10 * 1024 * 1024);
});

console.log("\n▶ 服务端与前端接线");

test("预览路由返回 kind=code 并带 language", () => {
  const index = read("server/index.mjs");
  assert.match(index, /import \{ PREVIEW_PREVIEW_MAX_BYTES, codeLanguageFor, isCodeExt, isTextExt, readTextPreview \} from "\.\/preview-types\.mjs"/);
  assert.match(index, /else if \(isCodeExt\(ext\)\)/);
  assert.match(index, /kind: "code", name: fileName, ext, language: codeLanguageFor\(ext\)/);
  assert.match(index, /else if \(isTextExt\(ext\)\)/);
});

test("DocViewer 懒加载 CodeViewer，并提供预览/源码切换", () => {
  const viewer = read("client/src/components/DocViewer.jsx");
  assert.match(viewer, /const CodeViewer = React\.lazy\(\(\) => import\("\.\/CodeViewer\.jsx"\)\)/);
  assert.match(viewer, /const \[sourceMode, setSourceMode\] = useState\(false\)/);
  assert.match(viewer, /doc\.kind === "code" &&/);
  assert.match(viewer, /sourceMode && \(doc\.kind === "text" \|\| doc\.kind === "htmlfile"\)/);
  assert.match(viewer, /预览方式/);
});

test("CodeViewer 只读、有行号与搜索", () => {
  const code = read("client/src/components/CodeViewer.jsx");
  assert.match(code, /EditorState\.readOnly\.of\(true\)/);
  assert.match(code, /EditorView\.editable\.of\(false\)/);
  assert.match(code, /lineNumbers\(\)/);
  assert.match(code, /search\(\{ top: true \}\)/);
  assert.match(code, /searchKeymap/);
  assert.doesNotMatch(code, /EditorView\.editable\.of\(true\)/);
});

test("预览能力矩阵登记源码类型，依赖已声明", () => {
  const capability = read("client/src/预览能力.js");
  assert.match(capability, /CODE_CAPABILITY/);
  assert.match(capability, /源码 · 只读/);
  const pkg = JSON.parse(read("package.json"));
  for (const dep of ["@codemirror/state", "@codemirror/view", "@codemirror/language", "@codemirror/search", "@codemirror/language-data"]) {
    assert.ok(pkg.dependencies?.[dep], `package.json 缺少 ${dep}`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(failed ? "\n✗ 源码预览测试存在失败" : "\n✓ 源码预览测试全部通过");
process.exitCode = failed ? 1 : 0;
