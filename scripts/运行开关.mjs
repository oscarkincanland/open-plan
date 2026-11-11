#!/usr/bin/env node
/**
 * 运行开关命令行（2026-11-11）：读写 `.oaw/runtime-flags.json` 里的持久化开关。
 *
 * 为什么需要：开关优先级是「环境变量 > 持久化文件 > 代码默认」。过去只认环境变量，
 * 服务换个终端/快捷方式启动，创作画布等能力就会"时有时无"。持久化文件让本机选择
 * 跨重启生效，同时仍然默认关（不主动写文件 = 与历史基线一致）。
 *
 * 用法：
 *   node scripts/运行开关.mjs list
 *   node scripts/运行开关.mjs get creativeCanvas
 *   node scripts/运行开关.mjs set creativeCanvas on
 *   node scripts/运行开关.mjs set creativeCanvas off
 *
 * 注意：修改后需重启服务（npm run stop && npm run start）才会生效；
 * 环境变量仍然优先于文件，排查时先看 `list` 输出的来源列。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, ".oaw", "runtime-flags.json");

/** 语义名 → 环境变量名（列表里同时展示两者，便于排查启动环境）。 */
function flagEnvName(key) {
  return `OAW_${String(key).replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

function readFlags() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeFlags(flags) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(flags, null, 2)}\n`, "utf8");
}

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

function describe(key) {
  const envName = flagEnvName(key);
  const envRaw = String(process.env[envName] ?? "").trim().toLowerCase();
  const stored = readFlags()[key];
  if (envRaw) return { key, envName, effective: TRUTHY.has(envRaw), source: "env" };
  if (typeof stored === "boolean") return { key, envName, effective: stored, source: "file" };
  return { key, envName, effective: false, source: "default" };
}

const [command, key, value] = process.argv.slice(2);
const flags = readFlags();

if (!command || command === "list") {
  const keys = new Set([...Object.keys(flags), "creativeCanvas"]);
  console.log(`持久化文件：${FILE}`);
  for (const item of [...keys].sort().map(describe)) {
    console.log(`  ${item.key.padEnd(22)} ${item.effective ? "开" : "关"}  (${item.source}${item.source === "env" ? ` ← ${item.envName}` : ""})`);
  }
  process.exit(0);
}

if (command === "get" && key) {
  const item = describe(key);
  console.log(`${item.key}: ${item.effective ? "开" : "关"} (${item.source})`);
  process.exit(0);
}

if (command === "set" && key) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!TRUTHY.has(raw) && !FALSY.has(raw)) {
    console.error(`值必须是 on/off（收到：${value}）`);
    process.exit(2);
  }
  const next = { ...flags, [key]: TRUTHY.has(raw) };
  writeFlags(next);
  const item = describe(key);
  console.log(`已写入 ${FILE}：${key} = ${TRUTHY.has(raw) ? "开" : "关"}`);
  console.log(`当前生效来源：${item.source}${item.source === "env" ? `（环境变量 ${item.envName} 优先，文件值要等环境变量清掉才生效）` : ""}`);
  console.log("重启服务后生效：npm run stop && npm run start");
  process.exit(0);
}

console.error("用法：node scripts/运行开关.mjs list | get <名称> | set <名称> on|off");
process.exit(2);
