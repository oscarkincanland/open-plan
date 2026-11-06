#!/usr/bin/env node
/**
 * 设置导航与模型页（模型 master-detail）回归：
 * 1. 设置外壳按「基础设置 / Agent 能力 / 高级」分组，旧的状态大卡已移除；
 * 2. 模型页拆成独立组件，保留供应商列表、详情、套餐与 URL 拉取；
 * 3. 后端 fetch-models 支持任意目录 URL 与 data/models/数组三种响应；
 * 4. 新增样式走设计令牌，不含硬编码色值。
 *
 * 这是 L1 源码契约测试（与既有设置类测试一致），不启动服务、不读凭据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const panel = read("client/src/components/SettingsPanel.jsx");
const page = read("client/src/components/模型设置页.jsx");
const css = read("client/src/styles.css");
const server = read("server/index.mjs");

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

console.log("▶ 设置导航");
check("导航按基础设置 / Agent 能力 / 高级分组", () => {
  for (const label of ["基础设置", "Agent 能力", "高级"]) {
    assert.match(panel, new RegExp(`label: "${label}"`), `缺少分组 ${label}`);
  }
});
check("模型与网络合并为单页入口", () => {
  assert.match(panel, /\["providers", "模型", "robot"\]/);
  assert.match(panel, /\["network", "网络与搜索", "globe"\]/);
  assert.match(panel, /\["advanced", "重置与诊断", "tool"\]/);
  assert.doesNotMatch(panel, /"模型套餐"\]/, "套餐不再作为独立 tab");
});
check("顶部状态大卡已移除，宪法提示仍在", () => {
  assert.doesNotMatch(panel, /settings-status-grid/);
  assert.doesNotMatch(panel, /settings-overview/);
  assert.match(panel, /settings-constitution-note/);
});
check("旧入口 model / plans 映射到模型页", () => {
  assert.match(panel, /initialSection === "model" \? "providers" : initialSection === "plans" \? "providers" : initialSection/);
  assert.match(panel, /\["appearance", "model", "plans", "providers"/);
});
check("设置外壳把模型页作为独立组件装载", () => {
  assert.match(panel, /<模型设置页/);
  assert.match(panel, /settingsSection === "providers" &&/);
  assert.match(panel, /id="settings-network"/);
});

console.log("▶ 模型页");
check("左供应商列表 + 右详情结构", () => {
  assert.match(page, /model-page-body/);
  assert.match(page, /model-page-nav/);
  assert.match(page, /model-page-detail/);
  assert.match(page, /model-nav-group/);
  assert.match(page, /model-detail-card/);
});
check("国内 / 国际 / 自定义分组", () => {
  assert.match(page, /DOMESTIC_PROVIDER_IDS/);
  assert.match(page, /INTERNATIONAL_PROVIDER_IDS/);
  assert.match(page, /renderGroup\("domestic"/);
  assert.match(page, /renderGroup\("international"/);
  assert.match(page, /renderGroup\("custom"/);
});
check("供应商、套餐与 URL 拉取入口", () => {
  for (const token of ["agentProviderImport", "agentProviderDetail", "agentPlanApply", "agentPlanDisconnect", "probeAgentModel", "agentSetDefaultModel", "fetchAgentModels"]) {
    assert.ok(page.includes(token), `缺少 ${token}`);
  }
  assert.match(page, /从 URL 拉取/);
  assert.match(page, /url: fetchUrl\.trim\(\)/);
  assert.match(page, /账号登录（订阅制）/);
  assert.match(page, /测试连接/);
  assert.match(page, /设为默认/);
});
check("模型页不写死颜色", () => {
  assert.doesNotMatch(page, /#[0-9a-fA-F]{3,8}\b/, "新增组件不应包含硬编码色值");
});

console.log("▶ 远程目录接口");
check("支持显式 url 与多形态响应", () => {
  assert.match(server, /normalizeFetchedModelList/);
  assert.match(server, /explicitUrl/);
  assert.match(server, /Array\.isArray\(body\?\.models\)/);
  assert.match(server, /Array\.isArray\(body\) \? body/);
  assert.match(server, /sourceUrl: target/);
});

console.log("▶ 样式");
check("两栏布局与窄屏折叠", () => {
  assert.match(css, /\.settings-nav \{/);
  assert.match(css, /\.settings-content \{/);
  assert.match(css, /\.model-page-body \{[^}]*grid-template-columns/);
  assert.match(css, /@media \(max-width: 900px\)/);
});

if (failed) {
  console.error(`\n设置导航与模型页测试：存在 ${failed} 项失败`);
  process.exit(1);
}
console.log("\n设置导航与模型页测试：全部通过");
