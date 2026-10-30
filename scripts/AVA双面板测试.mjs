#!/usr/bin/env node
/**
 * AVA 双面板测试（v0.13.10）
 *
 * 守护：
 *   1) 双面板开关：顶栏工具菜单 checkbox、默认关（localStorage oaw_dual_pane）；
 *   2) 生效条件：两面板均开 + 非浏览器全屏 + 产物默认布局 + 非 ≤1280 窄屏（自动降级）；
 *   3) 布局：dual-pane 类下工作产物与浏览器并排、各自 Resizer 拖宽、宽度受 vw 上限约束；
 *   4) 可回退单面板：关闭开关或窄屏即回到现状单 tab 容器。
 *
 * 用法：node scripts/AVA双面板测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const app = read("client/src/App.jsx");
const styles = read("client/src/styles.css");
const icon = read("client/src/components/Icon.jsx");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("双面板开关：默认关、持久化、顶栏菜单 checkbox", () => {
  assert.match(app, /localStorage\.getItem\("oaw_dual_pane"\) === "on"/, "默认关闭（仅 on 时启用）");
  assert.match(app, /localStorage\.setItem\("oaw_dual_pane", value \? "on" : "off"\)/);
  assert.match(app, /role="menuitemcheckbox"\n\s*aria-checked=\{dualPanePref\}/);
  assert.match(app, /disabled=\{\!\(previewOpen && browserPanelOpen\)\}/, "两面板未同开时置灰");
  assert.match(icon, /^\s{2}columns: \(/m, "columns 图标已注册");
});

test("生效条件守卫（窄屏/全屏/布局降级）", () => {
  assert.match(app, /const dualPaneActive = dualPanePref && previewOpen && browserPanelOpen && !browserFullscreen && previewLayout === 0 && !narrowViewport;/);
  assert.match(app, /window\.matchMedia\("\(max-width: 1280px\)"\)/, "1280 断点监听");
  assert.match(app, /query\.addEventListener\?\.\("change", onChange\)/, "跨断点实时切换");
});

test("双面板布局：aside 挂类 + 两 body 同时可见", () => {
  assert.match(app, /\$\{dualPaneActive \? " dual-pane" : ""\}/);
  assert.match(app, /\(workspaceTab === "preview" \|\| dualPaneActive\) \? "" : "canvas-hidden"/, "工作产物 body 双面板下可见");
  assert.match(app, /\(workspaceTab === "browser" \|\| dualPaneActive\) \? "" : "canvas-hidden"/, "浏览器 body 双面板下可见");
});

test("各自拖宽：双面板下两个 Resizer 同时生效", () => {
  assert.match(app, /previewOpen && \(workspaceTab === "preview" \|\| dualPaneActive\) && <Resizer side="right" min=\{280\} max=\{680\} cssVar="--preview-w" \/>/);
  assert.match(app, /browserPanelOpen && \(workspaceTab === "browser" \|\| dualPaneActive\) && <Resizer side="right" min=\{340\} max=\{960\} cssVar="--browser-w" \/>/);
});

test("宽度约束 CSS：面板 vw 上限保证对话输入区不被压扁", () => {
  assert.match(styles, /\.app-canvas-slot\.dual-pane \{[^}]*max-width: 78vw;/);
  assert.match(styles, /\.app-canvas-slot\.dual-pane \.canvas-body-preview \{ flex: 0 0 min\(var\(--preview-w, 420px\), 34vw\); width: auto; \}/);
  assert.match(styles, /\.app-canvas-slot\.dual-pane \.canvas-body-browser \{ flex: 1 1 min\(var\(--browser-w, min\(48vw, 760px\)\), 44vw\); width: auto; min-width: 0;/);
  assert.match(styles, /\.app-canvas-slot\.dual-pane > \.app-canvas-head \{ flex: 0 0 100%; \}/, "页签行占满首行");
});

console.log(failed ? "\nAVA 双面板测试：存在失败项" : "\nAVA 双面板测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
