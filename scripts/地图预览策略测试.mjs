#!/usr/bin/env node
/**
 * 地图预览策略回归（计划 2026-11-09-002 §4.1）
 *
 * 覆盖 resolveMapPreviewAction 全分支：
 *   - 会话无 mapProject：有预览 close / 无预览 none；
 *   - 会话有 mapProject：无预览 open（activate 只由 userInitiated 决定）；
 *   - 已有预览：payload 相同 none；项目 / 会话 / 视口变化 update；
 *   - sessionId 一律取 session.id，payload.view 取 session.mapView 或 null；
 *   - 纯函数不修改入参、对 undefined/null 安全。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveMapPreviewAction,
  buildMapPreviewPayload,
  sameMapPreviewPayload,
  normalizePreviewView,
} from "../client/src/地图/预览策略.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label} -> ${error.message}`);
  }
}

const sessionA = {
  id: "session-a",
  threadId: "thread-a",
  mapProject: "yiwu-ai",
  mapView: { center: [120.1, 29.3], zoom: 11, bounds: [120.0, 29.2, 120.2, 29.4], regionName: "义乌市", updatedAt: 1000 },
};
const sessionB = { ...sessionA, id: "session-b", threadId: "thread-b", mapProject: "yiwu-ai" };
const sessionNoMap = { id: "session-c", threadId: "thread-c", mapProject: "" };

function previewTabOf(session) {
  return { id: "view:mapPreview", kind: "mapPreview", payload: buildMapPreviewPayload(session) };
}

console.log("▶ 无地图绑定");

test("无 mapProject 且无预览 -> none", () => {
  assert.deepEqual(resolveMapPreviewAction({ session: sessionNoMap, previewTab: null }), { type: "none" });
});

test("无 mapProject 且有预览 -> close", () => {
  const action = resolveMapPreviewAction({ session: sessionNoMap, previewTab: previewTabOf(sessionA) });
  assert.deepEqual(action, { type: "close" }, "切到无地图会话应关闭预览");
});

test("mapProject 只有空白也应视为未绑定", () => {
  assert.deepEqual(resolveMapPreviewAction({ session: { id: "s", mapProject: "   " }, previewTab: null }), { type: "none" });
});

console.log("▶ 打开分支（open）");

test("有 mapProject、无预览、userInitiated=true -> open + activate", () => {
  const action = resolveMapPreviewAction({ session: sessionA, previewTab: null, userInitiated: true });
  assert.equal(action.type, "open");
  assert.equal(action.activate, true, "显式点击要激活预览标签");
  assert.deepEqual(action.payload, {
    project: "yiwu-ai",
    view: sessionA.mapView,
    sessionId: "session-a",
  });
});

test("有 mapProject、无预览、被动事件 -> open 但不激活", () => {
  const action = resolveMapPreviewAction({ session: sessionA, previewTab: null });
  assert.equal(action.type, "open");
  assert.equal(action.activate, false, "事件驱动只补建，不抢用户当前视图");
});

test("payload.sessionId 取 session.id 而非 threadId", () => {
  const action = resolveMapPreviewAction({ session: sessionA, previewTab: null, userInitiated: true });
  assert.equal(action.payload.sessionId, "session-a");
  assert.notEqual(action.payload.sessionId, sessionA.threadId);
});

test("会话没有 mapView 时 payload.view 为 null", () => {
  const action = resolveMapPreviewAction({ session: { id: "s1", mapProject: "zhejiang-map" }, previewTab: null });
  assert.equal(action.payload.view, null);
});

console.log("▶ 已存在预览");

test("payload 完全相同 -> none", () => {
  const action = resolveMapPreviewAction({ session: sessionA, previewTab: previewTabOf(sessionA), userInitiated: true });
  assert.deepEqual(action, { type: "none" }, "相同 payload 不应重挂小地图");
});

test("项目变化 -> update", () => {
  const next = { ...sessionA, mapProject: "hangzhou-map" };
  const action = resolveMapPreviewAction({ session: next, previewTab: previewTabOf(sessionA), userInitiated: true });
  assert.equal(action.type, "update");
  assert.equal(action.payload.project, "hangzhou-map");
  assert.equal(action.activate, true);
});

test("同一项目不同会话 -> update（sessionId 不一致也算变化）", () => {
  const action = resolveMapPreviewAction({ session: sessionB, previewTab: previewTabOf(sessionA), userInitiated: false });
  assert.equal(action.type, "update");
  assert.equal(action.payload.sessionId, "session-b");
  assert.equal(action.activate, false, "被动同步不激活");
});

test("只有视口 updatedAt 变化 -> update", () => {
  const next = { ...sessionA, mapView: { ...sessionA.mapView, updatedAt: 2000 } };
  const action = resolveMapPreviewAction({ session: next, previewTab: previewTabOf(sessionA) });
  assert.equal(action.type, "update", "updatedAt 变化视为需要同步（触发预览重挂）");
});

test("只有视口 center 变化 -> update", () => {
  const next = { ...sessionA, mapView: { ...sessionA.mapView, center: [120.9, 30.1] } };
  const action = resolveMapPreviewAction({ session: next, previewTab: previewTabOf(sessionA) });
  assert.equal(action.type, "update");
});

test("会话丢失 mapView 而预览还带视口 -> update（view 归零）", () => {
  const next = { ...sessionA, mapView: null };
  const action = resolveMapPreviewAction({ session: next, previewTab: previewTabOf(sessionA) });
  assert.equal(action.type, "update");
  assert.equal(action.payload.view, null);
});

test("预览标签为其它 kind 时按无预览处理", () => {
  const action = resolveMapPreviewAction({
    session: sessionA,
    previewTab: { id: "view:doc", kind: "doc", payload: { project: "other", sessionId: "x", view: null } },
  });
  assert.equal(action.type, "open");
  assert.equal(action.payload.project, "yiwu-ai");
});

console.log("▶ 健壮性");

test("session 缺省安全", () => {
  assert.deepEqual(resolveMapPreviewAction({ session: null, previewTab: null }), { type: "none" });
  assert.deepEqual(resolveMapPreviewAction(), { type: "none" });
  assert.deepEqual(resolveMapPreviewAction({ session: undefined, previewTab: { kind: "mapPreview", payload: {} } }), { type: "close" });
});

test("纯函数不修改入参", () => {
  const session = { id: "s", mapProject: "p", mapView: { center: [120, 29], zoom: 9 } };
  const snapshot = JSON.stringify(session);
  const previewTab = previewTabOf(session);
  resolveMapPreviewAction({ session, previewTab, userInitiated: true });
  assert.equal(JSON.stringify(session), snapshot, "session 不应被修改");
  assert.equal(previewTab.payload.project, "p");
});

test("sameMapPreviewPayload 忽略白名单外噪声字段", () => {
  const left = { project: "p", sessionId: "s", view: { center: [120, 29], zoom: 9 } };
  const right = { project: "p", sessionId: "s", view: { center: [120, 29], zoom: 9, tempLayers: [{ id: "od" }] } };
  assert.equal(sameMapPreviewPayload(left, right), true, "临时层变化不应触发预览重挂");
  assert.equal(sameMapPreviewPayload(left, { ...right, sessionId: "other" }), false);
  assert.equal(sameMapPreviewPayload(null, right), false);
});

test("normalizePreviewView 过滤非法视口字段", () => {
  assert.deepEqual(normalizePreviewView({ center: [120, 29, 30], zoom: "abc" }), null);
  assert.deepEqual(normalizePreviewView(null), null);
  const normalized = normalizePreviewView({ center: ["120.1", "29.3"], zoom: "10.5", regionName: "义乌市" });
  assert.deepEqual(normalized.center, [120.1, 29.3]);
  assert.equal(normalized.zoom, 10.5);
  assert.equal(normalized.regionName, "义乌市");
});

console.log("▶ 接线可复用性");

test("预览策略模块无 React 依赖，供 App 与 Node 测试共用", () => {
  const source = fs.readFileSync(path.join(ROOT, "client/src/地图/预览策略.js"), "utf8");
  assert.ok(!/from\s+["']react["']/.test(source), "不应 import react");
  assert.match(source, /export function resolveMapPreviewAction/);
  assert.match(source, /export function buildMapPreviewPayload/);
});

console.log(`\n地图预览策略：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error.stack || failure.error.message}`);
  process.exit(1);
}
