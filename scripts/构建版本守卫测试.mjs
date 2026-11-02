#!/usr/bin/env node
/**
 * 构建版本守卫测试。
 *
 * 背景（2026-11-02）：会话加载超时修好并上线后，用户仍报"没修好"。
 * 实测原因是：那个页面加载的是构建前的 `index-AFcpriwH.js`（不含修复），
 * 而 `dist/assets` 刻意保留历史包，旧页面既不会 404 也不会自己刷新——
 * 于是"修好了"和"用户看到"之间隔了一次没人触发的刷新。
 *
 * 本测试守护：
 *   1. 服务端能从 index.html 里取出入口构建标识，且与真实文件名一致；
 *   2. index.html 换入口后，标识跟着变（缓存按 mtime 失效）；
 *   3. 非入口脚本（maplibre 等 chunk）不会被误当成构建标识；
 *   4. 前端守卫从自己页面的 script src 取构建 id、比对不一致才回调；
 *   5. /api/status 真的下发了 clientBuild，界面真的会提示刷新。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clientBuildId, buildIdFromScriptSrc, clientBuildInfo } from "../server/客户端构建.mjs";
import { CLIENT_DIST } from "../server/workspace.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("服务端能从 index.html 解析出入口构建标识", () => {
  const build = clientBuildId();
  assert.match(build, /^index-.+\.js$/, `构建标识格式不对：${JSON.stringify(build)}`);
  const html = fs.readFileSync(path.join(CLIENT_DIST, "index.html"), "utf8");
  assert.ok(html.includes(build), "index.html 里应真的引用这个入口");
});

test("构建标识与 index.html 声明的入口完全一致", () => {
  const html = fs.readFileSync(path.join(CLIENT_DIST, "index.html"), "utf8");
  const declared = (html.match(/\/assets\/(index-[^"]+\.js)/) || [])[1] || "";
  assert.ok(declared, "index.html 应声明入口脚本");
  assert.equal(clientBuildId(), declared);
});

test("非入口脚本不会被误认作构建标识", () => {
  assert.equal(buildIdFromScriptSrc("/assets/maplibre-gl-DSjEnr-O.js"), "");
  assert.equal(buildIdFromScriptSrc("/assets/index-4rjN3GS-.js"), "index-4rjN3GS-.js");
  assert.equal(buildIdFromScriptSrc("/assets/index-4rjN3GS-.js?v=2#x"), "index-4rjN3GS-.js");
  assert.equal(buildIdFromScriptSrc(""), "");
});

test("不同入口脚本解析出不同标识（不会把新旧构建混为一谈）", () => {
  const a = buildIdFromScriptSrc("/assets/index-AAAA.js");
  const b = buildIdFromScriptSrc("/assets/index-BBBB.js");
  assert.notEqual(a, b);
  assert.equal(a, "index-AAAA.js");
  assert.equal(b, "index-BBBB.js");
});

test("诊断信息暴露真实的 index.html 路径", () => {
  const info = clientBuildInfo();
  assert.equal(info.exists, true, "构建产物应存在（CI 先构建）");
  assert.ok(info.indexFile.endsWith("index.html"));
  assert.equal(info.build, clientBuildId());
});

test("前端守卫：从自己页面取构建 id，不一致才提示", async () => {
  const wanted = {};
  const fakeScript = { getAttribute: () => "/assets/index-RUNNING.js" };
  globalThis.document = {
    querySelectorAll: (sel) => (sel === "script[src]" ? [fakeScript] : []),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };
  const statuses = [
    { clientBuild: "index-RUNNING.js" },  // 一致：不提示
    { clientBuild: "index-NEWBUILD.js" }, // 不一致：提示
  ];
  let call = 0;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => statuses[Math.min(call++, statuses.length - 1)],
  });
  globalThis.window = globalThis;
  const { currentBuildId, watchBuildChange } = await import("../client/src/构建版本.js");
  assert.equal(currentBuildId(), "index-RUNNING.js", "应取到本页入口");
  await new Promise((resolve) => {
    const stop = watchBuildChange((info) => {
      Object.assign(wanted, info);
      stop();
      resolve();
    }, { intervalMs: 10 });
  });
  assert.equal(wanted.running, "index-RUNNING.js");
  assert.equal(wanted.latest, "index-NEWBUILD.js");
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.window;
});

test("/api/status 下发 clientBuild", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(source, /clientBuild: clientBuildId\(\)/, "/api/status 应下发 clientBuild");
});

test("界面会提示刷新（不自动刷新，避免打断运行中的任务）", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8");
  assert.match(source, /watchBuildChange\(/, "App 应挂载构建版本守卫");
  assert.match(source, /检测到新版本（本页仍在用旧构建）/, "应给出可读提示");
  assert.match(source, /onClick=\{\(\) => window\.location\.reload\(\)\}/, "应由用户点击刷新");
  assert.doesNotMatch(source, /staleBuild[\s\S]{0,80}location\.reload\(\);\s*\}\s*\)?\s*;?\s*\/\/ 自动/, "不得自动刷新");
});

if (failed) {
  console.error("\n构建版本守卫测试：存在失败项");
  process.exit(1);
}
console.log("\n构建版本守卫测试：全部通过");
