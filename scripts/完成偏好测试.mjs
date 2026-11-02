#!/usr/bin/env node
/**
 * complete_task 运行偏好测试。
 *
 * 需求（2026-11-02）：调用 complete_task 默认关闭，并可在设置面板里开关。
 *
 * 关闭时的语义：
 *   - 不把 complete_task 放进会话的激活工具列表（模型看不到、调不到）；
 *   - 不追加"补一句完成声明"的强制收尾回合（省一次模型回合）；
 *   - 提示词里不再要求调用它（否则等于要求模型调用一个不存在的工具）；
 *   - Run 的完成语义退回"按终态推断"（server/运行轨迹.mjs 的 inferred 分支）。
 *
 * 静态白名单 server/task.mjs 里 complete_task 仍然保留（能力上限），
 * 只在运行时按偏好过滤——这样工具元数据契约表（白名单 ⇄ 元数据）不必改动。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在导入被测模块之前指定隔离的偏好文件，避免写到用户真实的 .oaw/preferences.json。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-pref-"));
const prefFile = path.join(tmpDir, "preferences.json");
process.env.OAW_PREFERENCES_FILE = prefFile;

const prefs = await import("../server/运行偏好.mjs");
const { toolPolicyForMode } = await import("../server/task.mjs");

const ROOT = path.resolve(import.meta.dirname, "..");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

test("默认关闭 complete_task", () => {
  assert.equal(prefs.readRuntimePreferences().completeTaskEnabled, false);
  assert.equal(prefs.completeTaskEnabled(), false);
});

test("保存后立即生效并能落盘读回", () => {
  const saved = prefs.saveRuntimePreferences({ completeTaskEnabled: true });
  assert.equal(saved.completeTaskEnabled, true);
  assert.equal(prefs.completeTaskEnabled(), true);
  assert.ok(fs.existsSync(prefFile), "偏好应落盘");
  const onDisk = JSON.parse(fs.readFileSync(prefFile, "utf8"));
  assert.equal(onDisk.completeTaskEnabled, true);
  prefs.saveRuntimePreferences({ completeTaskEnabled: false });
  assert.equal(prefs.completeTaskEnabled(), false);
});

test("未知字段被忽略（只接受白名单字段）", () => {
  prefs.saveRuntimePreferences({ completeTaskEnabled: true, 乱写字段: 1 });
  const stored = JSON.parse(fs.readFileSync(prefFile, "utf8"));
  assert.equal(stored.乱写字段, undefined);
  prefs.saveRuntimePreferences({ completeTaskEnabled: false });
});

test("对外视图不泄露文件路径", () => {
  const view = prefs.publicRuntimePreferences();
  assert.equal(typeof view.completeTaskEnabled, "boolean");
  assert.equal(JSON.stringify(view).includes(prefFile), false, "对外视图不应包含配置文件路径");
});

test("静态白名单仍保留 complete_task（能力上限不变，元数据契约表不必改）", () => {
  const agentTools = toolPolicyForMode("agent").tools;
  const reviewTools = toolPolicyForMode("review").tools;
  assert.ok(agentTools.includes("complete_task"), "Work 白名单应保留 complete_task");
  assert.ok(reviewTools.includes("complete_task"), "Review 白名单应保留 complete_task");
});

test("agent.mjs 按偏好过滤工具暴露", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(source, /import \{ completeTaskEnabled \} from "\.\/运行偏好\.mjs"/, "应引入运行偏好");
  assert.match(
    source,
    /\.filter\(\(name\) => completeTaskOn \|\| name !== "complete_task"\)/,
    "会话工具全集应按偏好过滤掉 complete_task",
  );
});

test("强制收尾提醒回合按偏好关闭", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.match(
    source,
    /if \(completeTaskEnabled\(\) && !entry\.pendingCompletion && entry\.toolStarted && !entry\.completionNudgeSent\)/,
    "收尾提醒回合必须受开关控制",
  );
});

test("提示词里的 complete_task 要求按偏好隐藏", () => {
  const agentSource = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
  assert.ok(
    agentSource.includes('completeTaskEnabled() ? ["- **显式收尾（complete_task）**'),
    "显式收尾提示必须按偏好隐藏",
  );
  const taskSource = fs.readFileSync(path.join(ROOT, "server", "task.mjs"), "utf8");
  assert.ok(
    taskSource.includes('completeTaskEnabled() ? ["6) 收尾：complete_task'),
    "写作工具书的收尾步骤必须按偏好隐藏",
  );
  assert.match(taskSource, /import \{ completeTaskEnabled \} from "\.\/运行偏好\.mjs"/,
    "task.mjs 应引入运行偏好");
});

test("设置面板提供开关", () => {
  const source = fs.readFileSync(path.join(ROOT, "client", "src", "components", "SettingsPanel.jsx"), "utf8");
  assert.match(source, /getRuntimePreferences/, "设置面板应读取运行偏好");
  assert.match(source, /saveRuntimePreferences\(\{ completeTaskEnabled: enabled \}\)/, "设置面板应保存运行偏好");
  assert.match(source, /要求调用 complete_task（默认关闭）/, "设置面板应有 complete_task 开关");
  const apiSource = fs.readFileSync(path.join(ROOT, "client", "src", "api.js"), "utf8");
  assert.match(apiSource, /export const getRuntimePreferences =/, "api.js 应导出偏好读取");
  assert.match(apiSource, /export const saveRuntimePreferences =/, "api.js 应导出偏好保存");
});

test("服务端提供偏好读写接口", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
  assert.match(source, /app\.get\("\/api\/runtime-preferences"/, "应有 GET 偏好接口");
  assert.match(source, /app\.patch\("\/api\/runtime-preferences"/, "应有 PATCH 偏好接口");
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (failed) {
  console.error("\ncomplete_task 运行偏好测试：存在失败项");
  process.exit(1);
}
console.log("\ncomplete_task 运行偏好测试：全部通过");
