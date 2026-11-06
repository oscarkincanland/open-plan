#!/usr/bin/env node
/**
 * 准备随包二进制（ADR 0024：LibreDWG 随包，ODA 不随包）。
 *
 * 背景：`bin/` 被 `.gitignore` 忽略（体积大、许可证独立），所以仓库里只保存
 * `bin/清单.json`（文件名 + 版本 + sha256 + 来源），构建前按清单准备并校验。
 *
 * 行为：
 *   1. 读取 `bin/清单.json`；
 *   2. 逐项检查 `bin/<path>` 是否存在且 sha256 匹配 → 跳过；
 *   3. 不匹配或缺失：有 `url` 则下载（Node 内置 fetch），否则打印手工放置指引；
 *   4. 任何一项校验失败 → 退出码 1（不允许带未知二进制出厂）。
 *
 * 用法:
 *   node scripts/桌面/准备随包二进制.mjs          检查并下载缺失项
 *   node scripts/桌面/准备随包二进制.mjs --check 只检查，不下载
 *   node scripts/桌面/准备随包二进制.mjs --write 把现有 bin/ 文件的 sha256 写回清单
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN_DIR = path.join(ROOT, "bin");
const MANIFEST = path.join(BIN_DIR, "清单.json");
const args = new Set(process.argv.slice(2));

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`未找到清单：${MANIFEST}`);
    console.error("请先创建 bin/清单.json（可运行 --write 由现有 bin/ 生成）。");
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    console.error(`清单解析失败：${error.message}`);
    process.exit(2);
  }
}

async function download(url, target) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(target, Buffer.from(arrayBuffer));
}

async function main() {
  const manifest = readManifest();
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (!items.length) {
    console.log("清单为空（items: []），无需准备。");
    return;
  }

  if (args.has("--write")) {
    for (const item of items) {
      const file = path.join(BIN_DIR, item.path);
      if (!fs.existsSync(file)) continue;
      item.sha256 = sha256(file);
      item.size = fs.statSync(file).size;
      item.checkedAt = new Date().toISOString();
    }
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`已写回 sha256：${MANIFEST}`);
    return;
  }

  let failed = 0;
  for (const item of items) {
    const file = path.join(BIN_DIR, item.path);
    const label = `${item.path}`;
    if (item.optional) { console.log(`  · ${label}（可选，跳过）`); continue; }
    if (fs.existsSync(file)) {
      const digest = sha256(file);
      if (!item.sha256) {
        console.log(`  ? ${label} 已存在但清单无 sha256（运行 --write 固化）`);
        continue;
      }
      if (digest !== item.sha256) {
        console.error(`  ✗ ${label} sha256 不匹配（实际 ${digest.slice(0, 12)}…，期望 ${item.sha256.slice(0, 12)}…）`);
        failed += 1;
        continue;
      }
      console.log(`  ✓ ${label} 校验通过`);
      continue;
    }
    if (args.has("--check")) {
      console.error(`  ✗ ${label} 缺失`);
      failed += 1;
      continue;
    }
    if (!item.url) {
      console.error(`  ✗ ${label} 缺失且清单无 url，请手工放置到 ${file}`);
      failed += 1;
      continue;
    }
    console.log(`  ↓ ${label} 下载中…`);
    try {
      await download(item.url, file);
      const digest = sha256(file);
      if (item.sha256 && digest !== item.sha256) {
        console.error(`  ✗ ${label} 下载后 sha256 不匹配`);
        failed += 1;
      } else {
        console.log(`  ✓ ${label} 下载并校验通过`);
      }
    } catch (error) {
      console.error(`  ✗ ${label} 下载失败：${error.message}`);
      failed += 1;
    }
  }

  if (failed) {
    console.error(`\n随包二进制准备失败（${failed} 项）。打包已中止。`);
    process.exit(1);
  }
  console.log("\n随包二进制准备完成。");
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
