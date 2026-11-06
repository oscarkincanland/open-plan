#!/usr/bin/env node
/**
 * 打包便携版（ZIP）——NSIS 安装器在受限环境不可用时的等价交付物。
 *
 * 为什么需要：electron-builder 的 nsis / portable 目标依赖 NSIS 的 makensis，
 * 而 makensis 需要对整个安装包建立 ~120MB 的内存映射文件。在某些受限环境
 * （沙箱、部分杀软、受限账户）会以 `Internal compiler error #12345: error creating mmap`
 * 失败——此时安装器做不出来，但「可直接运行的目录」已经由 `--dir` 产出。
 * 本脚本把该目录压成 zip，用户解压后双击 GuiJu.exe 即可使用（免安装）。
 *
 * 用法:
 *   node scripts/桌面/打包便携版.mjs                # 用默认 dist-app/win-unpacked
 *   node scripts/桌面/打包便携版.mjs --dir <目录>    # 指定已打包目录
 *   node scripts/桌面/打包便携版.mjs --out <zip>     # 指定输出路径
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : "";
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version || "0.0.0";
const sourceDir = path.resolve(argOf("--dir") || path.join(ROOT, "desktop", "dist-app", "win-unpacked"));
const outFile = path.resolve(argOf("--out") || path.join(ROOT, "desktop", "dist-app", `GuiJu-${version}-portable-x64.zip`));

if (!fs.existsSync(path.join(sourceDir, "GuiJu.exe"))) {
  console.error(`未找到可运行产物：${path.join(sourceDir, "GuiJu.exe")}`);
  console.error("请先执行：npm run desktop:pack");
  process.exit(1);
}

// Compress-Archive 对 >2GB 或大量文件较慢，这里用 .NET 的 ZipFile 更快且稳定
const ps = [
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `$src = '${sourceDir.replace(/'/g, "''")}'`,
  `$out = '${outFile.replace(/'/g, "''")}'`,
  "if (Test-Path $out) { Remove-Item $out -Force }",
  "[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $out, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
  "Write-Output ('ZIP_OK ' + (Get-Item $out).Length)",
].join("; ");

console.log(`源目录：${sourceDir}`);
console.log(`输出：  ${outFile}`);
const startedAt = Date.now();
const stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
  encoding: "utf8",
  maxBuffer: 1 << 26,
});
const sizeMatch = String(stdout).match(/ZIP_OK (\d+)/);
const bytes = sizeMatch ? Number(sizeMatch[1]) : (fs.existsSync(outFile) ? fs.statSync(outFile).size : 0);
if (!bytes) {
  console.error("压缩失败");
  process.exit(1);
}
console.log(`完成：${(bytes / 1024 / 1024).toFixed(1)} MB，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log("使用：解压后双击 GuiJu.exe（免安装；用户数据在 %APPDATA%/open-plan）");
