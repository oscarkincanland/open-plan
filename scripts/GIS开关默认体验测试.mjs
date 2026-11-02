#!/usr/bin/env node
/**
 * GIS 交付能力默认体验测试（ADR 0017）
 *
 * 1. 未设置环境变量时，五个 GIS 交付开关默认 true；
 * 2. 显式 OAW_MAP_*=0 时关闭；
 * 3. 显式 =1 时开启；
 * 4. 外部数据适配与 MCP 桥仍默认关闭。
 *
 * 运行开关在模块加载时求值，因此用子进程分别取快照。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ON = ["mapReport", "mapExport", "mapPack", "mapTemplates", "mapBookmarks"];
const DEFAULT_OFF = ["dataAdapters", "amapMcpBridge"];

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  ✗ ${label} -> ${error.message}`);
  }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OAW_MAP_") || key === "OAW_DATA_ADAPTERS" || key === "OAW_AMAP_MCP_BRIDGE") delete env[key];
  }
  return { ...env, ...extra };
}

function snapshot(extra = {}) {
  const code = 'import { RUNTIME_FLAGS } from "./server/运行开关.mjs"; process.stdout.write(JSON.stringify(RUNTIME_FLAGS));';
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: cleanEnv(extra),
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

console.log("▶ GIS 开关默认体验");

check("未设置环境变量时五项 GIS 交付能力默认开启", () => {
  const flags = snapshot();
  for (const key of DEFAULT_ON) assert.equal(flags[key], true, `${key} 应默认 true`);
});

check("显式 OAW_MAP_*=0 关闭五项能力", () => {
  const flags = snapshot({
    OAW_MAP_REPORT: "0",
    OAW_MAP_EXPORT: "0",
    OAW_MAP_PACK: "0",
    OAW_MAP_TEMPLATES: "0",
    OAW_MAP_BOOKMARKS: "0",
  });
  for (const key of DEFAULT_ON) assert.equal(flags[key], false, `${key} 应可显式关闭`);
});

check("显式 OAW_MAP_*=1 保持开启", () => {
  const flags = snapshot({
    OAW_MAP_REPORT: "1",
    OAW_MAP_EXPORT: "1",
    OAW_MAP_PACK: "1",
    OAW_MAP_TEMPLATES: "1",
    OAW_MAP_BOOKMARKS: "1",
  });
  for (const key of DEFAULT_ON) assert.equal(flags[key], true, `${key} 应保持开启`);
});

check("外部数据适配与 MCP 桥仍默认关闭", () => {
  const flags = snapshot();
  for (const key of DEFAULT_OFF) assert.equal(flags[key], false, `${key} 应保持默认关闭`);
});

check("运行开关源码使用 readFlagDefault 且保留显式关闭语义", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "运行开关.mjs"), "utf8");
  assert.match(src, /export function readFlagDefault/);
  assert.match(src, /const FALSY = new Set\(\["0", "false", "off", "no"\]\)/);
  for (const name of ["OAW_MAP_REPORT", "OAW_MAP_EXPORT", "OAW_MAP_PACK", "OAW_MAP_TEMPLATES", "OAW_MAP_BOOKMARKS"]) {
    assert.match(src, new RegExp(`readFlagDefault\\("${name}", true\\)`), `${name} 应使用 readFlagDefault`);
  }
});

console.log(`\nGIS 开关默认体验：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) process.exit(1);
