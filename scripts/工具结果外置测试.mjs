#!/usr/bin/env node
/**
 * 工具结果外置测试
 * 覆盖：阈值边界 / head-tail 预览 / 文件可回溯 / Pi 结果形状 / 清理
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupToolResults, externalizeText, externalizeToolResultPayload, listToolResults, previewText } from "../server/工具结果外置.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-tool-result-"));

test("未超阈值不外置", () => {
  const out = externalizeText({ text: "hello", runId: "run1", baseDir, maxInlineBytes: 1024 });
  assert.equal(out.externalized, false);
  assert.equal(out.text, "hello");
});

test("超阈值外置并保留预览", () => {
  const text = "A".repeat(4096);
  const out = externalizeText({ text, runId: "run1", baseDir, maxInlineBytes: 1024, toolName: "read", toolCallId: "tc1" });
  assert.equal(out.externalized, true);
  assert.ok(out.path && fs.existsSync(out.path));
  assert.ok(out.text.startsWith("A".repeat(100)));
  assert.ok(out.text.includes("工具结果已外置"));
  assert.equal(out.bytes, 4096);
});

test("tail 预览保留末尾", () => {
  const text = "HEAD" + "x".repeat(4096) + "TAIL";
  const out = externalizeText({ text, runId: "run1", baseDir, maxInlineBytes: 64, direction: "tail", toolName: "bash" });
  assert.equal(out.externalized, true);
  assert.ok(out.text.includes("TAIL"));
});

test("Pi 结果形状被替换且 details 记录外置", () => {
  const result = {
    content: [{ type: "text", text: "B".repeat(4096) }],
    details: { ok: true },
  };
  const out = externalizeToolResultPayload(result, { runId: "run1", baseDir, maxInlineBytes: 1024, toolName: "officecli", toolCallId: "tc2" });
  assert.equal(out.details.externalizedResults.length, 1);
  assert.ok(out.content[0].text.includes("工具结果已外置"));
  assert.equal(out.details.ok, true);
});

test("按 UTF-8 字节截断不会超出预算太多", () => {
  const text = "中".repeat(1000);
  const preview = previewText(text, 100, "head");
  assert.ok(Buffer.byteLength(preview, "utf8") <= 100);
});

test("清理 Run 外置结果", () => {
  assert.ok(listToolResults("run1", baseDir).length >= 1);
  const cleaned = cleanupToolResults("run1", baseDir);
  assert.equal(cleaned.ok, true);
  assert.equal(listToolResults("run1", baseDir).length, 0);
});

fs.rmSync(baseDir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
