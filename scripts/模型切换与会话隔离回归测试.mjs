#!/usr/bin/env node
/**
 * 模型切换与会话隔离回归测试（2026-11-10 / 计划 2026-11-10-006）。
 *
 * 背景：用户反馈"模型切换不成功"。排查结论：服务端链路正常（隔离实例 6/6 切换成功），
 * 失效根因在 ChatPanel 的回切 effect——全局偏好（oaw_model，localStorage 跨窗口共享）
 * 会把会话上报/服务端回退的模型强制覆盖，且会话模型缓存只在内存（刷新即丢）。
 *
 * 覆盖：
 *   A. 前端契约：回切 effect 已删除；会话模型 sessionStorage 缓存读写点齐备；
 *      回退/失败提示不自动消失；
 *   B. 服务端契约（隔离实例端到端）：/api/agent/model 两段式 spec 切换成功且
 *      runtime 状态即时更新。
 *
 * 用法: node scripts/模型切换与会话隔离回归测试.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
}

console.log("\n▶ A. 前端契约（回切闸门与会话模型缓存）");

const chatSource = read("client/src/components/ChatPanel.jsx");

test("旧的 selectedModel 自动回切 effect 已删除", () => {
  assert.ok(!chatSource.includes("void changeModel(selectedModel)"), "不得再出现 selectedModel 自动回切");
  assert.ok(!chatSource.includes("lastSelectedModelRef"), "lastSelectedModelRef 应随 effect 一并移除");
  assert.match(chatSource, /2026-11-10-005 模型切换修复/, "应保留修复说明注释");
});

test("会话模型 sessionStorage 缓存读写点齐备", () => {
  assert.match(chatSource, /oaw_thread_model_v1/, "缺少 oaw_thread_model_v1 缓存键");
  assert.match(chatSource, /function applyModelForSession[\s\S]{0,200}writeThreadModel\(threadId, id\)/s, "会话上报必须写缓存");
  assert.match(chatSource, /readThreadModelCache\(\)\[threadId\]/, "初始化 preferred 链必须读取缓存");
  // 缓存必须先于全局偏好：preferred 链中 storedThreadModel 出现在 saved 之前
  const preferred = chatSource.match(/const preferred = ([^;]+);/)?.[1] || "";
  assert.ok(preferred.indexOf("storedThreadModel") < preferred.indexOf("saved"), "会话缓存优先级必须高于全局偏好");
});

test("App 级 selectedModel 不再传入 ChatPanel", () => {
  const appSource = read("client/src/App.jsx");
  const chatPanelProps = appSource.slice(appSource.indexOf("<ChatPanel"), appSource.indexOf(">", appSource.indexOf("<ChatPanel")));
  assert.ok(!chatPanelProps.includes("selectedModel="), "ChatPanel 不应再接收 selectedModel prop");
  assert.match(chatSource, /oaw_model/, "全局偏好仍作为新会话默认（MODEL_KEY 保留）");
});

test("回退/失败提示持久显示（不自动消失）", () => {
  const start = chatSource.indexOf("const changeModel = async");
  const changeModelBody = chatSource.slice(start, start + 3500);
  assert.match(changeModelBody, /persistentMsg/, "changeModel 应使用持久提示变量");
  assert.ok(!/setTimeout\(\(\) => setModelMsg\(""\), 2500\);\s*\};/.test(changeModelBody.replace(/\s+/g, " ")), "不得在函数尾部无条件清除提示");
  assert.match(chatSource, /模型切换失败：\$.*（仍在用原模型）/, "model_switched failed 提示不得自动消失（无 setTimeout 清除）");
  const failedBranch = chatSource.slice(chatSource.indexOf('data.effective === "failed"'), chatSource.indexOf('data.effective === "failed"') + 400);
  assert.ok(!failedBranch.includes("setTimeout"), "failed 分支不得自动清除提示");
  assert.match(chatSource, /\{modelMsg \|\| `\$\{selectedProviderMeta\.label\}/, "模型触发器副标题应优先显示 modelMsg");
});

console.log("\n▶ B. 服务端契约（隔离实例端到端）");

async function serverContract() {
  const PORT = 30000 + Math.floor(Math.random() * 20000);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-model-test-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-model-ws-"));
  const server = spawn("node", ["server/index.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      OAW_RUNS_DIR: path.join(runtime, "runs"),
      OAW_WRITE_LOCK_DIR: path.join(runtime, "locks"),
      OAW_EVENT_DIR: path.join(runtime, "events"),
      OAW_INSTANCE_DIR: path.join(runtime, "instances"),
      OAW_GOAL_DIR: path.join(runtime, "goals"),
      OAW_DISABLE_RECOVERY: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let failedServer = 0;
  const j = (url, body) =>
    fetch(`http://localhost:${PORT}${url}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined)
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`http://localhost:${PORT}/api/models`)).ok; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error("server boot timeout");
    const catalog = await j("/api/models");
    const items = catalog.body?.models || [];
    test("模型目录非空且条目为两段式 id", () => {
      assert.ok(items.length > 0, "目录为空");
      for (const item of items.slice(0, 20)) assert.match(item.id, /^[^/]+\/.+$/, `条目 id 应为 provider/model 两段式：${item.id}`);
    });
    await j("/api/agent/new", { client: "test-client", thread: "test-thread-1", cwd: ws });
    let rt = null;
    for (let i = 0; i < 30 && !rt; i++) {
      const list = await j("/api/agent/runtimes");
      rt = (list.body?.runtimes || []).find((x) => x.key === "test-client::test-thread-1" && x.status !== "disposed");
      if (!rt) await new Promise((r) => setTimeout(r, 500));
    }
    test("测试 runtime 就绪", () => assert.ok(rt, "runtime 未出现"));
    const current = rt?.model ? `${rt.model.provider}/${rt.model.id}` : "";
    const target = (items.find((m) => m.id !== current && m.available !== false) || {}).id || "";
    test("存在可切换目标", () => assert.ok(target, "无其他可用模型"));
    if (target) {
      const sw = await j("/api/agent/model", { client: "test-client", thread: "test-thread-1", model: target });
      test("两段式 spec 切换成功（HTTP 200 + ok）", () => {
        assert.equal(sw.status, 200);
        assert.equal(sw.body?.ok, true, JSON.stringify(sw.body).slice(0, 200));
      });
      let nowSpec = "";
      for (let i = 0; i < 10; i++) {
        const list = await j("/api/agent/runtimes");
        const now = (list.body?.runtimes || []).find((x) => x.key === "test-client::test-thread-1" && x.status !== "disposed");
        nowSpec = now?.model ? `${now.model.provider}/${now.model.id}` : "?";
        if (nowSpec === target) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      test("runtime 模型状态即时更新", () => assert.equal(nowSpec, target, `runtime=${nowSpec} 期望=${target}`));
      const bad = await j("/api/agent/model", { client: "test-client", thread: "test-thread-1", model: `x/${target}` });
      test("错误拼法 spec 被拒绝（不静默成功）", () => assert.notEqual(bad.status, 200));
    }
  } catch (error) {
    failedServer = 1;
    console.error(`  ✗ 服务端契约: ${error?.message || error}`);
  } finally {
    server.kill();
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
  return failedServer;
}

const serverFailed = await serverContract();
if (serverFailed) failed = 1;

console.log(`\n${failed ? "✗ 测试失败" : "✓ 全部通过"}\n`);
process.exit(failed);
