#!/usr/bin/env node
/**
 * Office 并发写入验证（P1，确定性 L2，不依赖真实模型）。
 *
 * 场景：
 *   1. Word 与 PPT 两个任务写不同文件，锁按文件共存，两个 pipeline 同时完成；
 *   2. 工作区级锁仍会挡住文件锁（bash 兜底语义不变）。
 *
 * 用法: node scripts/Office并发写入验证.mjs
 * 退出码: 0 通过，1 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-office-concurrent-"));
process.env.OAW_WRITE_LOCK_DIR = path.join(workspace, ".locks");
const { acquireWriteLock, acquireWriteLockWithRetry, releaseWriteLock } = await import("../server/写入协调.mjs");
const { runEditorialPipeline } = await import("../server/编辑流水线.mjs");

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const docxPlanner = JSON.stringify({ title: "报告", sections: [{ title: "执行摘要", summary: "x" }] });
const docxWriter = JSON.stringify({ sections: [{ title: "执行摘要", blocks: [{ type: "paragraph", text: "这是正文内容，长度足够用于中文首行缩进检查。" }] }] });
const pptxPlanner = JSON.stringify({ title: "演示", slides: [{ title: "封面", points: ["a"] }] });
const pptxWriter = JSON.stringify({ slides: [{ title: "封面", bullets: ["a", "b"] }] });

const model = (planner, writer) => async (_prompt, { stage }) => (stage === "planner" ? planner : writer);

await test("Word 与 PPT 写不同文件可并行完成", async () => {
  const wordPath = path.join(workspace, "word.docx");
  const pptPath = path.join(workspace, "deck.pptx");
  const wordLock = acquireWriteLock({ workspace, targetPath: wordPath, runId: "run_word", kind: "editorial_pipeline" });
  const pptLock = acquireWriteLock({ workspace, targetPath: pptPath, runId: "run_ppt", kind: "editorial_pipeline" });
  try {
    assert.ok(wordLock?.key && pptLock?.key, "不同文件应能同时拿到锁");
    const [word, ppt] = await Promise.all([
      runEditorialPipeline({
        format: "docx", goal: "写一份报告", workspace, outputPath: "word.docx",
        scene: "report", modelReview: false, runModelTask: model(docxPlanner, docxWriter),
      }),
      runEditorialPipeline({
        format: "pptx", goal: "做一份 PPT", workspace, outputPath: "deck.pptx",
        modelReview: false, runModelTask: model(pptxPlanner, pptxWriter),
      }),
    ]);
    assert.equal(word.status, "completed", `Word 未完成：${word.issues?.join("；")}`);
    assert.equal(ppt.status, "completed", `PPT 未完成：${ppt.issues?.join("；")}`);
    assert.ok(fs.existsSync(wordPath), "Word 产物不存在");
    assert.ok(fs.existsSync(pptPath), "PPT 产物不存在");
  } finally {
    releaseWriteLock(wordLock);
    releaseWriteLock(pptLock);
  }
});

await test("工作区级锁仍挡住文件锁（bash 写命令兜底）", async () => {
  const rootLock = acquireWriteLock({ workspace, targetPath: workspace, runId: "run_bash", kind: "bash" });
  let message = "";
  try {
    await acquireWriteLockWithRetry(
      { workspace, targetPath: path.join(workspace, "blocked.docx"), runId: "run_blocked", kind: "officecli" },
      { timeoutMs: 400, intervalMs: 50 },
    );
  } catch (error) {
    message = `${error.code}: ${error.message}`;
  }
  releaseWriteLock(rootLock);
  assert.match(message, /WRITE_CONFLICT/, `应报 WRITE_CONFLICT，实际 ${message || "无错误"}`);
});

try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
console.log(failed ? "\nOffice 并发写入验证：存在失败" : "\nOffice 并发写入验证：全部通过");
process.exitCode = failed ? 1 : 0;
