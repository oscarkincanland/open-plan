#!/usr/bin/env node
/**
 * 记忆召回测试
 * 覆盖：manifest / 关键词选择 / 预算截断 / 异步选择器 / 回退
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRecallContext, buildRecallContextSync, formatManifest, scanMemoryManifest, selectMemoriesByKeyword } from "../server/记忆召回.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-memory-"));
const memoryDir = path.join(workspace, "memory");
fs.mkdirSync(memoryDir, { recursive: true });
fs.writeFileSync(path.join(memoryDir, "project.md"), "---\nname: project\ndescription: OD 项目背景\nmetadata:\n  type: project_fact\n---\n金东农村公路网规划，重点是 OD 分析。\n");
fs.writeFileSync(path.join(memoryDir, "feedback.md"), "---\nname: feedback\ndescription: 用户偏好中文输出\nmetadata:\n  type: user_preference\n---\n用户偏好中文、简洁输出。\n");
fs.writeFileSync(path.join(memoryDir, "lesson.md"), "---\nname: lesson\ndescription: 记忆召回经验\nmetadata:\n  type: lesson\n---\n长任务先做进度小结。\n");

test("manifest 扫描全部记忆且描述不含正文", () => {
  const manifest = scanMemoryManifest(workspace);
  assert.equal(manifest.length, 3);
  assert.ok(manifest.some((item) => item.file === "project.md" && item.type === "project_fact"));
  assert.equal(manifest[0].source, "workspace.memory");
  const text = formatManifest(manifest);
  assert.ok(text.includes("project.md"));
  assert.ok(!text.includes("金东农村公路网规划"));
});

test("关键词选择命中相关记忆", () => {
  const manifest = scanMemoryManifest(workspace);
  const selected = selectMemoriesByKeyword(manifest, "OD 分析 项目");
  assert.equal(selected[0].file, "project.md");
});

test("同步召回注入正文与时效警告", () => {
  const recall = buildRecallContextSync({ workspace, query: "OD 分析" });
  assert.ok(recall.selected.includes("project.md"));
  assert.ok(recall.text.includes("OD 分析"));
  assert.ok(recall.text.includes("可能过时"));
  assert.equal(recall.fallback, true);
});

test("预算截断标记", () => {
  const recall = buildRecallContextSync({ workspace, query: "OD", maxBytes: 30, perFileBytes: 20 });
  assert.equal(recall.truncated, true);
  assert.ok(recall.injectedBytes <= 200);
});

test("异步选择器与回退", async () => {
  const selected = await buildRecallContext({
    workspace,
    query: "偏好",
    selector: async (manifest) => [manifest.find((item) => item.file === "feedback.md").file],
  });
  assert.deepEqual(selected.selected, ["feedback.md"]);
  const fallback = await buildRecallContext({
    workspace,
    query: "OD",
    selector: async () => { throw new Error("no schema"); },
  });
  assert.equal(fallback.fallback, true);
  assert.ok(fallback.selected.length >= 1);
});

setTimeout(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}, 100);
