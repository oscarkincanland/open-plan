#!/usr/bin/env node
/**
 * 构建 Windows 安装包（NSIS），并把受限环境的坑固化进脚本。
 *
 * 为什么需要包装而不是直接 electron-builder：
 *   1. **缓存目录**：electron-builder 默认把 NSIS/winCodeSign 下载到
 *      `%LOCALAPPDATA%\electron-builder\Cache`，受限环境（沙箱/受限账户）写不进去，
 *      表现为 `mkdir ... Access is denied` → 必须改到工作区内（ELECTRON_BUILDER_CACHE）。
 *   2. **临时目录**：makensis 需要在 %TEMP% 建临时文件，受限环境同样被拒，
 *      表现为 `!tempfile: Unable to create temporary file!` 外加一串
 *      `Error in macro _Switch` 的连带错误 → 必须把 TMP/TEMP 指到工作区。
 *   3. **solid 压缩的内存映射**：makensis 对整体 solid 压缩会建 ~120MB mmap，
 *      受限环境报 `Internal compiler error #12345: error creating mmap`
 *      → 用 `--config.compression=store` 规避。
 *   4. **签名**：无证书时设 CSC_IDENTITY_AUTO_DISCOVERY=false，避免它去找证书。
 *
 * 用法:
 *   node scripts/桌面/构建安装包.mjs            # 已打包目录存在则复用，否则先 --dir 打包
 *   node scripts/桌面/构建安装包.mjs --repack   # 强制重新 --dir 打包
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const UNPACKED = path.join(DESKTOP, "dist-app", "win-unpacked");
const CACHE = path.join(DESKTOP, ".cache-builder");
const TMP = path.join(DESKTOP, ".nsis-tmp");
const args = new Set(process.argv.slice(2));

const ELECTRON_BIN = process.platform === "win32"
  ? path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe")
  : path.join(DESKTOP, "node_modules", "electron", "dist", "electron");

if (!fs.existsSync(ELECTRON_BIN)) {
  console.error("未找到 Electron 运行时可执行文件，请先：npm --prefix desktop install");
  process.exit(1);
}

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: CACHE,
  ELECTRON_CACHE: path.join(DESKTOP, ".cache-electron"),
  TMP,
  TEMP: TMP,
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  // Electron 若带 ELECTRON_RUN_AS_NODE，会被当成纯 Node 运行（GUI 起不来）
  ELECTRON_RUN_AS_NODE: undefined,
};
delete env.ELECTRON_RUN_AS_NODE;

/** 用 workspace 内的 electron-builder 可执行入口，避免依赖 npx 解析。 */
const builderCli = path.join(DESKTOP, "node_modules", "electron-builder", "cli.js");
function runBuilder(argsList) {
  const result = spawnSync(process.execPath, [builderCli, ...argsList], {
    cwd: DESKTOP,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\nelectron-builder 失败（退出码 ${result.status}）`);
    process.exit(result.status || 1);
  }
}

// 1) 前端必须已构建（桌面端加载 client/dist）
if (!fs.existsSync(path.join(ROOT, "client", "dist", "index.html"))) {
  console.error("缺少 client/dist/index.html —— 请先执行：npm run build");
  process.exit(1);
}

// 2) 需要时先目录级打包（--dir）
if (args.has("--repack") || !fs.existsSync(path.join(UNPACKED, "GuiJu.exe"))) {
  console.log("▶ 目录级打包（electron-builder --dir）…");
  runBuilder(["--win", "--dir", "--config", "electron-builder.yml"]);
} else {
  console.log("▶ 复用已有 dist-app/win-unpacked（如需重打加 --repack）");
}

// 3) 出安装包（复用已打包目录，store 压缩规避大 mmap）
console.log("▶ 生成 NSIS 安装包…");
runBuilder([
  "--win",
  "nsis",
  "--prepackaged",
  path.join("dist-app", "win-unpacked"),
  "--config",
  "electron-builder.yml",
  "--config.compression=store",
]);

// 4) 汇报产物
const releaseDir = path.join(DESKTOP, "dist-app");
const installers = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((n) => /Setup-.*\.exe$/i.test(n))
  : [];
if (!installers.length) {
  console.error("未找到安装包产物");
  process.exit(1);
}
for (const name of installers) {
  const size = fs.statSync(path.join(releaseDir, name)).size;
  console.log(`\n✅ 安装包：desktop/dist-app/${name}（${(size / 1024 / 1024).toFixed(1)} MB）`);
}
