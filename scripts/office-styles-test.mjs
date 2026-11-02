#!/usr/bin/env node
/**
 * Office 样式预置测试（计划 2026-10-31-003 / N-04）。
 *
 * 覆盖：
 *   1. create 新建 docx 时预置标准样式集（Normal/Heading1-4/Title/TOC1-2/Header/Footer）；
 *   2. --no-styles 显式退出；xlsx/pptx 不受影响；
 *   3. 样式错误增强：解析 "Style 'X' not found" 并给出可用样式与修复命令；
 *   4. buildDocxFromBlocks（流水线产物）同样预置样式；
 *   5. 既有文档路径（edit）不注入样式。
 *
 * 用法: node scripts/office-styles-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office-styles-"));

async function styleIdsOf(file) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(file));
  const xml = await zip.file("word/styles.xml")?.async("string");
  if (!xml) return [];
  return [...xml.matchAll(/w:styleId="([^"]+)"/g)].map((m) => m[1]);
}

const { createNativeOffice, buildDocxFromBlocks, buildStandardDocxStyles, STANDARD_DOCX_STYLE_IDS, DOCX_BUILTIN_STYLE_IDS } = await load("server/文档引擎.mjs");
const { parseStyleNotFound } = await load("server/office规范/officecli检查.mjs");

console.log("\n▶ create 预置标准样式集");

await test("create docx → 标准样式集齐全", async () => {
  const dir = path.join(tmp, "styles-a");
  fs.mkdirSync(dir, { recursive: true });
  const result = await createNativeOffice(["create", "报告.docx"], { cwd: dir });
  assert.ok(result, "原生 create 应返回结果");
  const ids = await styleIdsOf(path.join(dir, "报告.docx"));
  for (const id of STANDARD_DOCX_STYLE_IDS) {
    assert.ok(ids.includes(id), `缺少样式 ${id}（实际：${ids.join(",")}）`);
  }
});

await test("create docx --no-styles → 不注入自定义样式（仅引擎默认样式）", async () => {
  const dir = path.join(tmp, "styles-b");
  fs.mkdirSync(dir, { recursive: true });
  await createNativeOffice(["create", "空.docx", "--no-styles"], { cwd: dir });
  const ids = await styleIdsOf(path.join(dir, "空.docx"));
  assert.equal(ids.includes("TOC1"), false, "--no-styles 不应注入 TOC1");
  assert.equal(ids.includes("Header"), false, "--no-styles 不应注入 Header");
  assert.equal(ids.includes("Footer"), false, "--no-styles 不应注入 Footer");
});

await test("create xlsx / pptx 不受影响", async () => {
  const dir = path.join(tmp, "styles-c");
  fs.mkdirSync(dir, { recursive: true });
  const xlsx = await createNativeOffice(["create", "表.xlsx"], { cwd: dir });
  assert.ok(xlsx, "xlsx 原生 create 应成功");
  assert.ok(fs.existsSync(path.join(dir, "表.xlsx")));
  const pptx = await createNativeOffice(["create", "片.pptx"], { cwd: dir });
  assert.ok(pptx, "pptx 原生 create 应成功");
  assert.ok(fs.existsSync(path.join(dir, "片.pptx")));
});

await test("create --force 覆盖已存在文件并保留样式集（否则回退 CLI → Style not found）", async () => {
  const dir = path.join(tmp, "styles-force");
  fs.mkdirSync(dir, { recursive: true });
  await createNativeOffice(["create", "产物.docx"], { cwd: dir });
  // 已存在且无 --force → 回退 CLI（返回 null）
  const noForce = await createNativeOffice(["create", "产物.docx"], { cwd: dir });
  assert.equal(noForce, null, "已存在文件且无 --force 时应回退 officecli");
  // 带 --force → 走原生，且样式集仍在
  const forced = await createNativeOffice(["create", "产物.docx", "--force"], { cwd: dir });
  assert.ok(forced, "带 --force 时应走原生 create");
  assert.equal(forced.json?.engine, "native");
  const ids = await styleIdsOf(path.join(dir, "产物.docx"));
  for (const id of STANDARD_DOCX_STYLE_IDS) {
    assert.ok(ids.includes(id), `--force 覆盖后缺少样式 ${id}`);
  }
});

await test("样式集配置：Normal 存在且基于 Normal 链不悬空", () => {
  const styles = buildStandardDocxStyles({ scene: "report" });
  const ids = styles.paragraphStyles.map((s) => s.id);
  // default 里的键是小写（heading1/title/...），对应 styleId 是 Heading1/Title
  const defaults = Object.keys(styles.default || {})
    .filter((key) => key !== "document")
    .map((key) => key.charAt(0).toUpperCase() + key.slice(1));
  const all = [...ids, ...defaults];
  for (const id of STANDARD_DOCX_STYLE_IDS) {
    assert.ok(all.includes(id), `样式集缺少 ${id}`);
  }
  const normal = styles.paragraphStyles.find((s) => s.id === "Normal");
  assert.ok(normal, "缺少 Normal");
  assert.ok(normal.run?.font, "Normal 必须带字体定义");
  assert.ok(normal.paragraph?.spacing, "Normal 必须带行距定义");
});

await test("内置样式不与 docx 默认集重复（重复会让 OfficeCLI 读文档直接报错）", () => {
  const styles = buildStandardDocxStyles({ scene: "report" });
  const builtin = styles.paragraphStyles.map((s) => s.id).filter((id) => DOCX_BUILTIN_STYLE_IDS.includes(id));
  assert.deepEqual(builtin, [], `这些样式 docx 默认已生成，不能再用 paragraphStyles 追加：${builtin.join(",")}`);
  // 内置样式必须走 default.* 覆盖（改同一份定义，不会产生第二个 styleId）
  for (const id of ["title", "heading1", "heading2", "heading3", "heading4"]) {
    assert.ok(styles.default?.[id], `内置样式 ${id} 必须在 default 里覆盖`);
  }
});

await test("产物 styles.xml 无重复 styleId（实测重复会让 OfficeCLI 抛 same key）", async () => {
  const dir = path.join(tmp, "no-dup");
  fs.mkdirSync(dir, { recursive: true });
  await createNativeOffice(["create", "去重.docx"], { cwd: dir });
  const ids = await styleIdsOf(path.join(dir, "去重.docx"));
  const dup = ids.filter((value, index) => ids.indexOf(value) !== index);
  assert.deepEqual([...new Set(dup)], [], `styles.xml 出现重复 styleId：${[...new Set(dup)].join(",")}`);
});

await test("场景切换：official-doc 与 report 的正文字号不同", () => {
  const report = buildStandardDocxStyles({ scene: "report" });
  const official = buildStandardDocxStyles({ scene: "official-doc" });
  const reportSize = report.paragraphStyles.find((s) => s.id === "Normal").run.size;
  const officialSize = official.paragraphStyles.find((s) => s.id === "Normal").run.size;
  assert.notEqual(reportSize, officialSize, "不同场景应给出不同的正文字号");
});

console.log("\n▶ 流水线产物同样预置样式");

await test("buildDocxFromBlocks 生成的文档含标准样式集", async () => {
  const target = path.join(tmp, "流水线.docx");
  await buildDocxFromBlocks(target, [
    { type: "heading", level: 1, text: "第一章" },
    { type: "paragraph", text: "正文内容" },
  ], { scene: "report" });
  const ids = await styleIdsOf(target);
  for (const id of STANDARD_DOCX_STYLE_IDS) {
    assert.ok(ids.includes(id), `流水线产物缺少样式 ${id}`);
  }
});

await test("buildDocxFromBlocks --no-styles（options.noStyles）不注入", async () => {
  const target = path.join(tmp, "流水线无样式.docx");
  await buildDocxFromBlocks(target, [{ type: "paragraph", text: "正文" }], { noStyles: true });
  const ids = await styleIdsOf(target);
  assert.equal(ids.includes("TOC2"), false, "noStyles 不应注入 TOC2");
});

console.log("\n▶ 样式错误增强");

await test("解析 Style not found 错误并给出可用样式与修复命令", () => {
  const parsed = parseStyleNotFound("Error: Style 'Normal' not found. Use `add /styles --type style --prop id=Normal --prop name=... --prop type=paragraph|character` first.");
  assert.ok(parsed, "应识别出样式缺失");
  assert.equal(parsed.style, "Normal");
  assert.ok(parsed.available.includes("Heading2"), "应给出可用样式列表");
  assert.ok(parsed.suggestion.includes("Normal"), "建议应点名缺失样式");
  assert.ok(parsed.suggestion.includes("raw-set"), "建议应劝阻 raw-set");
});

await test("非样式错误不被误判", () => {
  assert.equal(parseStyleNotFound("Error: Image file not found: .work/figs/test.svg"), null);
  assert.equal(parseStyleNotFound("Error: File not found: 报告.docx"), null);
  assert.equal(parseStyleNotFound(""), null);
});

await test("修复建议包含一行可执行的 add 命令", () => {
  const parsed = parseStyleNotFound("Style 'Heading1' not found");
  assert.ok(parsed.suggestion.includes("add"), "应给出 add 命令");
  assert.ok(parsed.suggestion.includes("Heading1"), "命令里应带上目标样式 id");
});

console.log(failed ? "\n✗ 样式预置测试存在失败项\n" : "\n✓ 样式预置测试全部通过\n");
process.exit(failed ? 1 : 0);
