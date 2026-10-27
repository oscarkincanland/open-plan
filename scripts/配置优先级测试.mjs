#!/usr/bin/env node
/**
 * 配置优先级测试
 * 覆盖：优先级顺序 / 资源发现 / 同名冲突
 */
import assert from "node:assert/strict";
import { CONFIG_PRIORITY, describeConfigPriority, discoverResources, pickFirstByName, resolveConfigValue, sourceRank } from "../server/配置来源.mjs";
import { skillRootCandidates } from "../server/资源发现.mjs";

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("优先级顺序为 cli > env > session > project > user > default", () => {
  const order = CONFIG_PRIORITY.map((item) => item.source);
  assert.deepEqual(order, ["cli", "env", "session", "project", "user", "default"]);
  assert.ok(sourceRank("cli") > sourceRank("env"));
  assert.ok(sourceRank("env") > sourceRank("default"));
});

test("resolveConfigValue 取最高优先级已定义值", () => {
  const result = resolveConfigValue({
    name: "model",
    sources: { default: "d", user: "u", project: undefined, env: "e", cli: null },
  });
  assert.equal(result.value, "e");
  assert.equal(result.source, "env");
});

test("未定义时返回 undefined 且 source=null", () => {
  const result = resolveConfigValue({ name: "x", sources: { env: undefined, default: null } });
  assert.equal(result.value, undefined);
  assert.equal(result.source, null);
});

test("资源发现顺序与去重", () => {
  const list = discoverResources({
    explicit: ["/a"],
    user: ["/u1", "/u2"],
    workspace: ["/w"],
    extra: ["/a", "/x"],
  });
  assert.deepEqual(list.map((item) => item.path), ["/a", "/u1", "/u2", "/w", "/x"]);
  assert.equal(list[0].source, "cli");
});

test("同名资源先到先得并记录冲突", () => {
  const { chosen, conflicts } = pickFirstByName([
    { name: "a", source: "cli" },
    { name: "a", source: "user" },
    { name: "b", source: "project" },
  ]);
  assert.equal(chosen.length, 2);
  assert.equal(chosen[0].source, "cli");
  assert.equal(conflicts.length, 1);
});

test("技能根目录读取侧带 source/kind", () => {
  const roots = skillRootCandidates({ agentDir: "/app/agent", userProfile: "/home/u", projectDir: "/work/proj" });
  assert.ok(roots.length >= 6);
  assert.ok(roots.every((item) => item.source && item.kind && Number.isFinite(item.rank)));
  const kinds = roots.map((item) => item.kind);
  assert.ok(kinds.includes("user.agents"));
  assert.ok(kinds.includes("project.pi"));
  assert.ok(roots.findIndex((item) => item.kind === "user.agents") < roots.findIndex((item) => item.kind === "project.pi"));
});

test("优先级描述可读", () => {
  const text = describeConfigPriority().join("\n");
  assert.ok(text.includes("cli"));
  assert.ok(text.includes("default"));
});

process.exitCode = failed ? 1 : 0;
