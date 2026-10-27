#!/usr/bin/env node
/**
 * Office 生成回归测试（O-04 / O-17 / O-18 / O-19 / O-21 / O-22）。
 * 覆盖：blocks v2 版式一致性、目录/页码后处理、旧 blocks 兼容、批量/截图参数、流水线端到端。
 *
 * 用法: node scripts/Office生成回归测试.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { buildDocxFromBlocks, needsCli, runNativeOfficeCommand } from "../server/文档引擎.mjs";
import { runDocxQa } from "../server/office规范/验收规则.mjs";
import { runEditorialPipeline } from "../server/编辑流水线.mjs";
import { buildBatchArgs, buildScreenshotArgs } from "../server/office.mjs";

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (error) => { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); },
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-gen-"));
const blocks = [
  { type: "heading", text: "第一章 概述", level: 1 },
  { type: "paragraph", text: "这是正文段落，用于验证中文首行缩进、行距与字号设置是否稳定。" },
  { type: "table", rows: [["项目", "数值"], ["投资", "100"]] },
];

async function readXml(file, name = "word/document.xml") {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file(name);
  return entry ? entry.async("string") : "";
}

function layoutSnapshot(xml) {
  const sizes = [...new Set([...xml.matchAll(/<w:sz\b[^>]*w:val="(\d+)"/g)].map((m) => m[1]))].sort();
  const lines = [...new Set([...xml.matchAll(/<w:spacing\b[^>]*w:line="(\d+)"/g)].map((m) => m[1]))].sort();
  const indents = [...new Set([...xml.matchAll(/<w:ind\b[^>]*w:firstLine="(\d+)"/g)].map((m) => m[1]))].sort();
  const margins = [...xml.matchAll(/<w:pgMar\b[^>]*>/g)].map((m) => m[0]);
  return JSON.stringify({ sizes, lines, indents, margins });
}

console.log("\n▶ blocks v2 与版式一致性（6 例）");
await test("样式版生成成功且 QA 通过", async () => {
  const file = path.join(tmp, "styled.docx");
  const result = await buildDocxFromBlocks(file, blocks, {
    scene: "report", toc: true, pageNumbers: true,
    cover: { title: "测试文档标题", subtitle: "副标题" },
  });
  assert.equal(result.styled, true);
  const qa = await runDocxQa(file);
  assert.equal(qa.passed, true, JSON.stringify(qa.issues));
});
await test("封面标题写入产物", async () => {
  const file = path.join(tmp, "cover.docx");
  await buildDocxFromBlocks(file, blocks, { scene: "report", cover: { title: "测试文档标题" } });
  const view = await runNativeOfficeCommand(["view", file, "text"], { cwd: tmp });
  assert.ok(String(view.text).includes("测试文档标题"));
});
await test("目录域与 updateFields 写入", async () => {
  const file = path.join(tmp, "toc.docx");
  await buildDocxFromBlocks(file, blocks, { scene: "report", toc: true });
  const xml = await readXml(file);
  const settings = await readXml(file, "word/settings.xml");
  assert.ok(xml.includes("TOC"));
  assert.ok(/<w:updateFields\b/.test(settings));
});
await test("正文页码起始为 1", async () => {
  const file = path.join(tmp, "pageno.docx");
  await buildDocxFromBlocks(file, blocks, { scene: "report", pageNumbers: true });
  const xml = await readXml(file);
  assert.ok(/<w:pgNumType\b[^>]*w:start="1"/.test(xml));
});
await test("连续 3 次生成版式参数一致", async () => {
  const snapshots = [];
  for (let i = 0; i < 3; i += 1) {
    const file = path.join(tmp, `repeat-${i}.docx`);
    await buildDocxFromBlocks(file, blocks, { scene: "report", cover: { title: "测试文档标题" }, toc: true, pageNumbers: true });
    snapshots.push(layoutSnapshot(await readXml(file)));
  }
  assert.equal(snapshots[0], snapshots[1]);
  assert.equal(snapshots[1], snapshots[2]);
});
await test("旧 blocks（不传选项）仍可生成", async () => {
  const file = path.join(tmp, "legacy.docx");
  const result = await buildDocxFromBlocks(file, blocks);
  assert.equal(result.styled, false);
  const view = await runNativeOfficeCommand(["view", file, "text"], { cwd: tmp });
  assert.ok(String(view.text).includes("第一章 概述"));
});

console.log("\n▶ 原生路由与参数（5 例）");
await test("create --styled 走原生", () => {
  const result = needsCli("create", ["create", "a.docx", "--type", "docx", "--styled"]);
  assert.equal(result.needsCli, false);
});
await test("能力矩阵包含 create:styled", async () => {
  const { officeCapabilityMatrix } = await import("../server/文档引擎.mjs");
  assert.ok(officeCapabilityMatrix().docx.native.includes("create:styled"));
});
await test("批量参数包含 JSON 与 --best-effort", () => {
  const args = buildBatchArgs("a.docx", [{ command: "set", path: "/body/p[1]", props: { bold: true } }], { bestEffort: true });
  assert.equal(args[0], "batch");
  assert.ok(args.includes("--best-effort"));
  assert.ok(args[3].includes("bold"));
});
await test("批量默认原子模式（无 best-effort）", () => {
  const args = buildBatchArgs("a.docx", []);
  assert.equal(args.includes("--best-effort"), false);
});
await test("截图参数包含 -o", () => {
  assert.deepEqual(buildScreenshotArgs("a.docx", "a.png"), ["view", "a.docx", "screenshot", "-o", "a.png"]);
});

console.log("\n▶ 流水线端到端（4 例）");
const planner = JSON.stringify({ title: "测试报告", sections: [{ title: "执行摘要", summary: "要点" }] });
const writer = JSON.stringify({ sections: [{ title: "执行摘要", blocks: [{ type: "paragraph", text: "这是正文内容，长度足够用于中文首行缩进检查。" }] }] });
const model = async (_prompt, { stage }) => (stage === "planner" ? planner : writer);

await test("场景 + 封面 + 目录 + 页码 + QA → completed", async () => {
  const workspace = fs.mkdtempSync(path.join(tmp, "ws-"));
  const result = await runEditorialPipeline({
    format: "docx", goal: "写一份5页的报告，给主管部门看，使用工作区已有数据，风格正式严谨",
    workspace, scene: "report", cover: { title: "测试报告", docType: "report" }, toc: true, pageNumbers: true,
    qa: true, modelReview: false, runModelTask: model,
  });
  assert.equal(result.status, "completed");
  assert.ok(result.deliverable);
  assert.equal(result.scene.id, "report");
});
await test("输出路径越界 → 拒绝", async () => {
  const workspace = fs.mkdtempSync(path.join(tmp, "ws-"));
  await assert.rejects(
    () => runEditorialPipeline({ format: "docx", goal: "写报告", workspace, outputPath: "../escape.docx", modelReview: false, runModelTask: model }),
    /输出路径超出当前工作区/,
  );
});
await test("未传场景时自动选择", async () => {
  const workspace = fs.mkdtempSync(path.join(tmp, "ws-"));
  const result = await runEditorialPipeline({
    format: "docx", goal: "写一份公文通知", workspace, modelReview: false, runModelTask: model,
  });
  assert.equal(result.scene.id, "official-doc");
});
await test("旧调用（无新选项）保持兼容", async () => {
  const workspace = fs.mkdtempSync(path.join(tmp, "ws-"));
  const result = await runEditorialPipeline({ format: "docx", goal: "写一份说明", workspace, modelReview: false, runModelTask: model });
  assert.equal(result.status, "completed");
});

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
