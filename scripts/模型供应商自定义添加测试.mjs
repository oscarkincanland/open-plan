#!/usr/bin/env node
/**
 * 模型供应商自主添加与自定义模型管理回归（计划 2026-11-11-002）
 *
 * 覆盖（L1 源码契约，不启动服务、不读凭据）：
 *   D1 模型页从零新建自定义供应商入口（左栏底部 / 全部供应商 / 空态）
 *   D2 新增模型支持声明 视觉/推理 能力，并透传到保存 payload
 *   D3 模型选择浮层「管理模型与供应商」与搜索空态添加入口
 *   D4 /api/agent/custom-provider 标记 legacy，前端统一走 /api/agent/model-configs
 *   以及 App/SettingsPanel 的 intent 透传、样式存在、关键校验分支。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const page = read("client/src/components/模型设置页.jsx");
const chat = read("client/src/components/ChatPanel.jsx");
const app = read("client/src/App.jsx");
const settings = read("client/src/components/SettingsPanel.jsx");
const css = read("client/src/styles.css");
const server = read("server/index.mjs");
const requirements = read("REQUIREMENTS.md");
const design = read("DESIGN.md");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}

console.log("▶ D1 自定义供应商入口");
check("模型页提供 startBlankProvider 空白草稿", () => {
  assert.match(page, /const startBlankProvider = \(\) => \{/);
  assert.match(page, /setSelection\(\{ type: "new", id: "" \}\)/);
  assert.match(page, /models: \[\]/);
});
check("三处入口：左栏底部 / 全部供应商 / 空态", () => {
  const matches = page.match(/onClick=\{startBlankProvider\}/g) || [];
  assert.ok(matches.length >= 3, `入口数量应 ≥3，实际 ${matches.length}`);
  assert.match(page, /自定义供应商/);
});
check("新建时同名供应商转为打开现有配置，不静默覆盖", () => {
  assert.match(page, /selection\.type === "new" && configs\.some/);
  assert.match(page, /已存在，已为你打开现有配置/);
});
check("保存走统一 /api/agent/model-configs（不依赖 custom-provider）", () => {
  assert.match(page, /saveAgentModelConfig\(payload\)/);
  assert.doesNotMatch(page, /agentCustomProvider/);
});

console.log("▶ D2 模型能力字段");
check("新增模型表单包含 支持图片 / 支持推理", () => {
  assert.match(page, /支持图片/);
  assert.match(page, /支持推理/);
  assert.match(page, /newModel\.vision === true/);
  assert.match(page, /newModel\.reasoning !== false/);
});
check("addDraftModel 使用表单能力字段并重置", () => {
  assert.match(page, /reasoning: newModel\.reasoning !== false, vision: newModel\.vision === true/);
  assert.match(page, /setNewModel\(\{ id: "", name: "", contextWindow: "", vision: false, reasoning: true \}\)/);
});

console.log("▶ D3 模型浮层入口");
check("ChatPanel 接收 onOpenModelSettings 并提供打开函数", () => {
  assert.match(chat, /onOpenModelSettings/);
  assert.match(chat, /const openModelSettings = \(mode = "manage"\)/);
  assert.match(chat, /onOpenModelSettings\(mode\)/);
});
check("浮层底部提供 管理模型与供应商 / 添加供应商", () => {
  assert.match(chat, /model-pop-footer/);
  assert.match(chat, /管理模型与供应商/);
  assert.match(chat, /添加供应商/);
});
check("搜索空态提供添加模型/供应商入口", () => {
  assert.match(chat, /ct-pop-add-model/);
  assert.match(chat, /\+ 添加模型 \/ 供应商/);
});
check("App 提供 modelPageIntent 并透传 ChatPanel / SettingsPanel", () => {
  assert.match(app, /modelPageIntent/);
  assert.match(app, /const openModelSettings = \(mode = "manage"\) => \{/);
  assert.match(app, /setSettingsSection\("providers"\)/);
  assert.match(app, /onOpenModelSettings=\{openModelSettings\}/);
  assert.match(app, /modelPageIntent=\{modelPageIntent\}/);
});
check("SettingsPanel 将 intent 透传给模型设置页", () => {
  assert.match(settings, /modelPageIntent = null/);
  assert.match(settings, /intent=\{modelPageIntent\}/);
});

console.log("▶ D4 后端契约与 legacy 标注");
check("POST /api/agent/model-configs 支持任意 provider + 多模型", () => {
  assert.match(server, /app\.post\("\/api\/agent\/model-configs"/);
  assert.match(server, /function validateModelConfigInput/);
  assert.match(server, /const provider = String\(input\.provider \|\| ""\)\.trim\(\)/);
});
check("模型能力 vision/reasoning 由服务端保留", () => {
  assert.match(server, /reasoning: item\?\.reasoning !== false/);
  assert.match(server, /input: item\?\.vision === true \? \["text", "image"\] : \["text"\]/);
});
check("/api/agent/custom-provider 已标注 legacy 且前端无调用", () => {
  assert.match(server, /legacy（2026-11-11-002）/);
  const api = read("client/src/api.js");
  assert.match(api, /agentCustomProvider/);
  const usages = [page, chat, app, settings].filter((text) => /agentCustomProvider/.test(text));
  assert.equal(usages.length, 0, "前端组件不应再调用 legacy custom-provider");
});

console.log("▶ 样式与文档");
check("新入口样式使用既有令牌类", () => {
  assert.match(css, /\.model-pop-footer/);
  assert.match(css, /\.ct-pop-add-model/);
  assert.doesNotMatch(css, /\.model-pop-footer[^}]*#[0-9a-fA-F]{3,6}/, "不应新增硬编码色值");
});
check("PRD R15 与 DESIGN §7.1 已同步", () => {
  assert.match(requirements, /从零新建任意自定义供应商/);
  assert.match(requirements, /无需重启服务即出现在 `\/api\/models`/);
  assert.match(design, /自定义供应商与模型（2026-11-11-002）/);
});

if (failed) {
  console.log(`\n模型供应商自定义添加测试：${failed} 项失败`);
  process.exit(1);
}
console.log("\n模型供应商自定义添加测试：全部通过");
