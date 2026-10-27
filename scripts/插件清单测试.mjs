#!/usr/bin/env node
/**
 * 插件清单测试
 * 覆盖：构建/写入/读取 / 哈希校验 / 内容变更检测 / 入口校验
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, manifestPathFor, readManifest, validateManifest, writeManifest } from "../server/插件清单.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-plugin-"));
fs.writeFileSync(path.join(root, "index.mjs"), "export const x = 1;\n");
fs.writeFileSync(path.join(root, "helper.mjs"), "export const y = 2;\n");

test("构建清单包含入口与哈希", () => {
  const manifest = buildManifest({ name: "demo", version: "1.0.0", root, entry: "index.mjs", permissions: ["read"], dependencies: { pi: "1.1.0" } });
  assert.equal(manifest.name, "demo");
  assert.equal(manifest.entry, "index.mjs");
  assert.ok(manifest.rootHash);
  assert.ok(manifest.entryHash);
  assert.equal(manifest.fileCount, 2);
});

test("写入/读取清单", () => {
  const manifest = buildManifest({ name: "demo", version: "1.0.0", root, entry: "index.mjs" });
  writeManifest(manifest, root);
  assert.ok(fs.existsSync(manifestPathFor(root)));
  assert.equal(readManifest(root).name, "demo");
});

test("清单校验通过", () => {
  const manifest = readManifest(root);
  assert.equal(validateManifest(manifest, { root }).ok, true);
});

test("内容变更后校验失败", () => {
  const manifest = readManifest(root);
  fs.appendFileSync(path.join(root, "helper.mjs"), "// changed\n");
  const result = validateManifest(manifest, { root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.includes("rootHash")));
});

test("缺少清单返回错误", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-plugin-empty-"));
  fs.writeFileSync(path.join(empty, "index.mjs"), "export {};\n");
  const result = validateManifest(null, { root: empty });
  assert.equal(result.ok, false);
  fs.rmSync(empty, { recursive: true, force: true });
});

fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
