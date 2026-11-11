#!/usr/bin/env node
/**
 * 模型斜线 ID 与 Command Code 套餐路由回归（计划 2026-11-11-003）。
 *
 * 覆盖（不联网、不读写真实凭据）：
 *   1. normalizeModelId 允许 deepseek/...、Qwen/...，仍拒绝空白/反斜线/路径穿越；
 *   2. fetchPlanModels 按 supported_endpoints 为 Command Code 模型选择 api/baseUrl；
 *   3. 无端点声明的旧套餐继续使用 preset 级 api/baseUrl；
 *   4. applyPlan 写入模型级 api/baseUrl/contextWindow，且 Key 只进凭据文件；
 *   5. 源码契约：两条保存路径共用 normalizeModelId。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-model-id-"));
process.env.PI_AGENT_DIR = tempDir;
process.env.OAW_DATA_DIR = tempDir;

const { normalizeModelId } = await import("../server/模型标识.mjs");
const { PLAN_PRESETS, fetchPlanModels, applyPlan } = await import("../server/套餐目录.mjs");
const { readModelsConfig, readCredentials } = await import("../server/Pi配置管理.mjs");

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
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}

console.log("▶ 模型 ID 规则");
check("允许带命名空间的模型 ID", () => {
  for (const id of [
    "deepseek/deepseek-v4-flash",
    "Qwen/Qwen3.8-27B",
    "inclusionai/ling-3.0-flash-sante:free",
    "gpt-5.6-luna",
    "a/b/c",
  ]) {
    assert.equal(normalizeModelId(id), id, `${id} 应通过`);
  }
});
check("拒绝空白、反斜线、首尾斜线与路径穿越", () => {
  for (const id of ["", "   ", "a b", "a\tb", "a\\b", "/a", "a/", "a//b", "a/../b", "a/./b", ".", "..", "a/.."]) {
    assert.equal(normalizeModelId(id), null, `${JSON.stringify(id)} 应被拒绝`);
  }
  assert.equal(normalizeModelId("  deepseek/deepseek-v4-flash  "), "deepseek/deepseek-v4-flash");
  assert.equal(normalizeModelId("x".repeat(161)), null);
});

console.log("▶ Command Code 套餐目录路由");
const sample = {
  object: "list",
  data: [
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context_length: 1000000, supported_endpoints: ["/messages"] },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", context_length: 1000000, supported_endpoints: ["/chat/completions", "/responses"] },
    { id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B", context_length: 262144, supported_endpoints: ["/chat/completions", "/responses"] },
    { id: "plain-model", name: "Plain Model", context_length: 128000 },
  ],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => sample });

check("Command Code 已登记为套餐", () => {
  assert.ok(PLAN_PRESETS.some((preset) => preset.planId === "command-code"));
});

await checkAsync("Claude 模型走 anthropic-messages + /provider", async () => {
  const models = await fetchPlanModels("command-code");
  const claude = models.find((model) => model.id === "claude-sonnet-5-5");
  assert.ok(claude);
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.baseUrl, "https://api.commandcode.ai/provider");
  assert.equal(claude.contextWindow, 1000000);
  assert.equal(claude.name, "Claude Sonnet 5.5");
});

await checkAsync("OpenAI 兼容模型走 openai-completions + /provider/v1", async () => {
  const models = await fetchPlanModels("command-code");
  for (const id of ["deepseek/deepseek-v4-flash", "Qwen/Qwen3.8-27B"]) {
    const model = models.find((item) => item.id === id);
    assert.ok(model, `${id} 应存在`);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "https://api.commandcode.ai/provider/v1");
  }
});

await checkAsync("未声明端点的模型回退到套餐默认协议", async () => {
  const models = await fetchPlanModels("command-code");
  const plain = models.find((model) => model.id === "plain-model");
  assert.equal(plain.api, "openai-completions");
  assert.equal(plain.baseUrl, "https://api.commandcode.ai/provider/v1");
});

await checkAsync("旧套餐无端点声明时保持预设协议", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }] }) });
  const models = await fetchPlanModels("opencode-zen-go");
  assert.equal(models[0].api, "openai-completions");
  assert.equal(models[0].baseUrl, "https://opencode.ai/zen/go/v1");
  globalThis.fetch = async () => ({ ok: true, json: async () => sample });
});

console.log("▶ 套餐接入写入");
await checkAsync("applyPlan 写入模型级 api/baseUrl/contextWindow 与凭据", async () => {
  const result = await applyPlan({
    planId: "command-code",
    apiKey: "test-key-not-real",
    modelIds: ["claude-sonnet-5-5", "deepseek/deepseek-v4-flash"],
  });
  assert.equal(result.ok, true);
  const config = readModelsConfig({ dir: tempDir });
  const provider = config.providers.PLAN_COMMAND_CODE;
  assert.ok(provider, "应写入 PLAN_COMMAND_CODE");
  assert.equal(provider.models.length, 2);
  const claude = provider.models.find((model) => model.id === "claude-sonnet-5-5");
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.baseUrl, "https://api.commandcode.ai/provider");
  assert.equal(claude.contextWindow, 1000000);
  const deepseek = provider.models.find((model) => model.id === "deepseek/deepseek-v4-flash");
  assert.equal(deepseek.api, "openai-completions");
  assert.equal(deepseek.baseUrl, "https://api.commandcode.ai/provider/v1");
  assert.equal(deepseek.contextWindow, 1000000);
  assert.ok(!JSON.stringify(provider).includes("test-key-not-real"), "模型配置不应包含 Key");
  const credentials = readCredentials({ dir: tempDir });
  assert.equal(credentials.PLAN_COMMAND_CODE.key, "test-key-not-real");
});

await checkAsync("applyPlan 拒绝非法模型 ID，不写配置", async () => {
  const before = JSON.stringify(readModelsConfig({ dir: tempDir }));
  const result = await applyPlan({ planId: "command-code", apiKey: "x", modelIds: ["a b"] });
  assert.equal(result.ok, false);
  assert.match(result.error, /模型 ID 不合法/);
  assert.equal(JSON.stringify(readModelsConfig({ dir: tempDir })), before);
});

console.log("▶ 源码契约");
check("两条保存路径共用 normalizeModelId", () => {
  const server = read("server/index.mjs");
  assert.match(server, /import \{ normalizeModelId \} from "\.\/模型标识\.mjs"/);
  assert.match(server, /const id = normalizeModelId\(item\?\.id\)/);
  assert.match(server, /const modelId = normalizeModelId\(modelIdInput\)/);
  assert.doesNotMatch(server, /\^\[\^\/\\\\s\]\{1,160\}\$/);
});
check("套餐模块复用同一模型 ID 规则", () => {
  const catalog = read("server/套餐目录.mjs");
  assert.match(catalog, /import \{ normalizeModelId \} from "\.\/模型标识\.mjs"/);
  assert.match(catalog, /planId: "command-code"/);
  assert.match(catalog, /endpointBaseUrls/);
});
check("package.json 注册 test:model-slash-plan", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["test:model-slash-plan"], "node scripts/模型斜线ID与套餐路由测试.mjs");
});

globalThis.fetch = realFetch;
fs.rmSync(tempDir, { recursive: true, force: true });

if (failed) {
  console.log(`\n模型斜线 ID 与套餐路由测试：${failed} 项失败`);
  process.exit(1);
}
console.log("\n模型斜线 ID 与套餐路由测试：全部通过");
