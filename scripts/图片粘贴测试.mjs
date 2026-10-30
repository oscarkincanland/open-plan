#!/usr/bin/env node
/**
 * P4 粘贴图片契约测试：
 * 剪贴板回退、去重、8 张上限、命名、压缩收益摘要；
 * ChatPanel 必须走压缩/去重/上限，并在非视觉模型下二次确认。
 *
 * 用法: node scripts/图片粘贴测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function ok(message) { console.log(`  ✓ ${message}`); }
function bad(message) { console.error(`  ✗ ${message}`); failed = 1; }
function test(name, fn) {
  try { fn(); ok(name); } catch (error) { bad(`${name}: ${error.message}`); }
}

const mod = await import(new URL("../client/src/图片处理.js", import.meta.url).href);

const fakeFile = (name, size = 1000, type = "image/png", lastModified = 1) => ({ name, size, type, lastModified });

console.log("\n▶ 剪贴板与去重");

test("clipboardData.items 优先，files 回退", () => {
  const fromItems = mod.clipboardImageFiles({
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => fakeFile("a.png") }],
      files: [fakeFile("b.png")],
    },
  });
  assert.equal(fromItems.length, 1);
  assert.equal(fromItems[0].name, "a.png");
  const fromFiles = mod.clipboardImageFiles({ clipboardData: { items: [], files: [fakeFile("b.png")] } });
  assert.equal(fromFiles.length, 1);
  assert.equal(fromFiles[0].name, "b.png");
  assert.deepEqual(mod.clipboardImageFiles({}), []);
});

test("去重键区分同名不同内容", () => {
  assert.equal(mod.imageDedupeKey(fakeFile("a.png", 10, "image/png", 1)), mod.imageDedupeKey(fakeFile("a.png", 10, "image/png", 1)));
  assert.notEqual(mod.imageDedupeKey(fakeFile("a.png", 10, "image/png", 1)), mod.imageDedupeKey(fakeFile("a.png", 11, "image/png", 1)));
});

test("没有文件名时生成粘贴图片名称", () => {
  const name = mod.imageFileName(fakeFile("image.png", 10, "image/png"), new Date(2026, 9, 30, 9, 5, 7).getTime());
  assert.equal(name, "粘贴图片-20261030-090507.png");
  assert.equal(mod.imageFileName(fakeFile("截图.png"), 0), "截图.png");
});

test("最多 8 张，超出进入 rejected", () => {
  const list = Array.from({ length: 10 }, (_, i) => fakeFile(`a${i}.png`));
  const { kept, rejected } = mod.limitImages(list);
  assert.equal(kept.length, 8);
  assert.equal(rejected.length, 2);
  assert.equal(mod.IMAGE_MAX_COUNT, 8);
});

test("压缩收益摘要只在有意义时返回", () => {
  assert.equal(mod.compressionSummary([{ originalBytes: 1000, compressedBytes: 400 }]), "压缩 60%");
  assert.equal(mod.compressionSummary([{ originalBytes: 1000, compressedBytes: 990 }]), "");
  assert.equal(mod.compressionSummary([]), "");
});

console.log("\n▶ ChatPanel 接线");

test("粘贴/拖入走压缩、去重与上限，不再静默截断", () => {
  const panel = read("client/src/components/ChatPanel.jsx");
  assert.match(panel, /import \{ clipboardImageFiles, imageDedupeKey, imageFileName, limitImages, compressImage, compressionSummary \} from "\.\.\/图片处理\.js"/);
  assert.match(panel, /const \{ kept, rejected \} = limitImages\(imageFiles, remaining\)/);
  assert.match(panel, /await compressImage\(file\)/);
  assert.match(panel, /最多 8 张图片/);
  assert.doesNotMatch(panel, /for \(const f of Array\.from\(list\)\.slice\(0, 6\)\)/);
  assert.match(panel, /const files = clipboardImageFiles\(e\);/);
});

test("非视觉模型发送前二次确认", () => {
  const panel = read("client/src/components/ChatPanel.jsx");
  assert.match(panel, /!modelVision/);
  assert.match(panel, /不支持图片输入，继续发送可能失败。是否仍然发送/);
});

console.log(failed ? "\n✗ 粘贴图片测试存在失败" : "\n✓ 粘贴图片测试全部通过");
process.exitCode = failed ? 1 : 0;
