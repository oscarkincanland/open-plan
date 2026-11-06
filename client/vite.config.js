import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ASSETS_DIR = fileURLToPath(new URL("./dist/assets", import.meta.url));
const ASSET_MAX_AGE_MS = 48 * 60 * 60_000;

/**
 * 清理 48 小时前的旧构建资源。
 *
 * build.emptyOutDir 关闭后，每次构建的 hash 资源都会保留，保证重建时仍开着
 * 旧页面的用户按需加载 lazy chunk 不 404（地图/知识库等模块最容易触发）。
 * 超过 48 小时、且已不被当前 index.html 引用的资源在这里删除，避免无限增长。
 */
function pruneOldAssets() {
  return {
    name: "oaw-prune-old-assets",
    apply: "build",
    closeBundle() {
      let names = [];
      try { names = fs.readdirSync(ASSETS_DIR); } catch { return; }
      let indexHtml = "";
      try { indexHtml = fs.readFileSync(path.join(ASSETS_DIR, "..", "index.html"), "utf8"); } catch {}
      const now = Date.now();
      for (const name of names) {
        const file = path.join(ASSETS_DIR, name);
        try {
          if (indexHtml.includes(`assets/${name}`)) continue;
          const stat = fs.statSync(file);
          if (stat.isFile() && now - stat.mtimeMs > ASSET_MAX_AGE_MS) fs.rmSync(file, { force: true });
        } catch {}
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pruneOldAssets()],
  define: {
    // shpjs → immediate 依赖浏览器全局 global（旧打包假设），此处兜底
    global: "globalThis",
  },
  resolve: {
    alias: {
      // shpjs → safe-buffer 依赖 Node 内置 buffer，用浏览器 polyfill 包替换
      buffer: "buffer/",
    },
  },
  server: {
    port: 3002,
    proxy: {
      "/api": "http://localhost:3002",
    },
  },
  build: {
    outDir: "dist",
    // 前端重建时保留上一版 hash 资源：仍开着旧页面的用户按需加载
    // （地图/知识库等 lazy chunk）不会 404。旧文件由 pruneOldAssets 兜底清理。
    emptyOutDir: false,
    chunkSizeWarningLimit: 1500,
  },
});
