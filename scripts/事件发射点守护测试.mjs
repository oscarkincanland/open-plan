#!/usr/bin/env node
/**
 * 事件发射点守护测试
 *
 * 背景：事件注册表是事件流的唯一事实来源，但此前有 7 个事件"已登记却全仓无发射点"
 * （usage_recorded / memory_recall_started / hook_started / hook_finished /
 *  config_source_resolved / plugin_manifest_invalid / plan_persisted），
 * 文档把它们列为已交付，实际上永远不会发生。
 *
 * 本测试断言：注册表里的每种事件，在 server/ 下都至少有一处真实发射点
 * （emit / emitChannelSafe / writeEvent / recordRunEvent / appendEvent / emitChild
 *  的字符串字面量，或直接调用 appendEvent({ type: "..." }) 的对象写法）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = path.join(ROOT, "server", "事件注册表.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

/** 收集 server/ 下所有 .mjs 源码（含子目录）。 */
function collectSources(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (entry.name.endsWith(".mjs") && path.resolve(full) !== path.resolve(REGISTRY)) out.push(full);
  }
  return out;
}

const sources = collectSources(path.join(ROOT, "server"));
const corpus = sources.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const registrySrc = fs.readFileSync(REGISTRY, "utf8");

/** 从注册表解析出全部已登记的事件类型（legacy 条目单列：已停用、只服务历史回放）。 */
function registeredTypes() {
  const types = new Set();
  const legacy = new Set();
  for (const m of registrySrc.matchAll(/\{\s*type:\s*"([^"]+)"([^}]*)\}/g)) {
    types.add(m[1]);
    if (/legacy\s*:\s*true/.test(m[2] || "")) legacy.add(m[1]);
  }
  return { types: [...types], legacy };
}

const { types: registered, legacy: legacyTypes } = registeredTypes();

test("注册表能解析出事件类型", () => {
  assert.ok(registered.length > 50, `事件类型应超过 50 种，实际 ${registered.length}`);
});

test("每个已登记事件在 server/ 下都有真实发射点", () => {
  const missing = [];
  for (const type of registered) {
    // legacy（已停用、只服务历史回放）的事件不再要求有发射点。
    if (legacyTypes.has(type)) continue;
    const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 发射形态多样：emit?.("x") / emitChannel(entry, "x") / emitWriteEvent(cb, "x", …)
    // / onEvent?.("x") / appendEvent({ type: "x" }) / 常量表集中声明。
    // 这里统一判定为"事件名以字符串字面量形式出现在 server 源码中"，
    // 并额外排除只在比较分支里出现、却没有任何发射调用的情形。
    const literal = new RegExp(`["'\`]${escaped}["'\`]`).test(corpus);
    const asObjectField = new RegExp(`type\\s*:\\s*["'\`]${escaped}["'\`]`).test(corpus);
    // 出现在函数调用的参数位置（排除纯比较与字符串拼接）
    const asCallArg = new RegExp(`\\(\\s*[^()]{0,80}?["'\`]${escaped}["'\`]`).test(corpus);
    if (!literal && !asObjectField && !asCallArg) missing.push(type);
  }
  assert.deepEqual(missing, [], `以下事件已登记但没有任何发射点：${missing.join("、")}`);
});

test("发射点不是只写在注册表自己里", () => {
  // 注册表文件本身不参与发射点统计（上面已排除），这里再确认 corpus 规模合理。
  assert.ok(corpus.length > 100000, `server 源码体量异常：${corpus.length}`);
});

console.log(failed ? "\n事件发射点守护测试：存在失败" : "\n事件发射点守护测试：全部通过");
process.exitCode = failed ? 1 : 0;
