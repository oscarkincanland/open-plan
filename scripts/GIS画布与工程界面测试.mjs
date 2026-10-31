#!/usr/bin/env node
/**
 * GIS 画布与工程界面测试（T2.1 / T2.2 / T2.3 / T2.5 / T3.1–T3.4）
 *
 * 以源码契约为主（组件在浏览器内运行，这里保证入口、语义与权限不被改坏）：
 *   - 三段式图层树 + 临时层管理
 *   - 图层属性对话框（元数据/锁定/导出/替换）
 *   - 三级重置对话框与项目名确认
 *   - 地图容器 ResizeObserver
 *   - AI 画布向导与会话绑定
 *   - 新增 Agent 工具与白名单
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

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

console.log("▶ 图层树与临时层");
test("LayerPanel 保留共享 / 我的 / 临时三段式", () => {
  const src = read("client/src/components/LayerPanel.jsx");
  for (const key of ["lp-group-shared", "lp-group-temp", "共享数据集", "临时层", "我的图层"]) {
    assert.ok(src.includes(key), `缺少 ${key}`);
  }
});
test("临时层可显隐 / 单删 / 全清 / 转正", () => {
  const src = read("client/src/components/LayerPanel.jsx");
  for (const key of ["onToggleTempLayer", "onClearTempLayer", "onSaveTempLayer", "onClearAllTemp", "未保存"]) {
    assert.ok(src.includes(key), `缺少 ${key}`);
  }
});
test("转正对话框收集名称与分组", () => {
  const src = read("client/src/components/临时层转正对话框.jsx");
  assert.match(src, /图层名称/, "应有名称输入");
  assert.match(src, /分组/, "应有分组选择");
  assert.match(src, /onConfirm/, "应回传确认结果");
});

console.log("▶ 图层属性");
test("属性对话框展示来源 / 统计 / 时间 / 基线归属", () => {
  const src = read("client/src/components/图层属性对话框.jsx");
  for (const key of ["要素数", "范围", "导入时间", "更新时间", "基线", "source.kind"]) {
    assert.ok(src.includes(key), `缺少 ${key}`);
  }
});
test("属性对话框支持锁定 / 导出 / 替换", () => {
  const src = read("client/src/components/图层属性对话框.jsx");
  assert.match(src, /locked/, "应有锁定字段");
  assert.match(src, /\/export/, "应调用单层导出");
  assert.match(src, /onReplaced/, "应支持替换数据");
});
test("双击图层行与右键菜单都能进入属性", () => {
  const src = read("client/src/components/LayerPanel.jsx");
  assert.match(src, /onDoubleClick=\{\(\) => onOpenLayerProps\?\.\(id\)\}/, "双击图层行应打开属性");
  assert.equal((src.match(/onDoubleClick=\{\(e\) => e\.stopPropagation\(\)\}/g) || []).length >= 3, true, "显隐/重命名/图例应阻止双击冒泡");
  assert.match(src, /图层属性 \/ 元数据/, "右键菜单应有属性入口");
});

console.log("▶ 三级重置");
test("重置对话框有三个级别与影响清单", () => {
  const src = read("client/src/components/重置对话框.jsx");
  for (const key of ["重置图层树", "清空临时层", "恢复基线并清理", "mp-reset-impact"]) {
    assert.ok(src.includes(key), `缺少 ${key}`);
  }
});
test("恢复基线需输入项目名确认", () => {
  const src = read("client/src/components/重置对话框.jsx");
  assert.match(src, /confirmName\.trim\(\) === project/, "应校验项目名");
  assert.match(src, /输入项目名确认/, "应有确认输入");
});
test("MapPanel 接入重置 / 基线 / 工程注册表", () => {
  const src = read("client/src/components/MapPanel.jsx");
  for (const key of ["mapReset", "mapSetBaseline", "mapLayerRegistry", "设置基线", "重置图层…"]) {
    assert.ok(src.includes(key), `缺少 ${key}`);
  }
});

console.log("▶ 布局自适应");
test("MapViewer 监听容器尺寸并防抖 resize", () => {
  const src = read("client/src/components/MapViewer.jsx");
  assert.match(src, /new ResizeObserver/, "应有 ResizeObserver");
  assert.match(src, /map\.resize\(\)/, "应调用 map.resize");
  assert.match(src, /resizeObserver\?\.disconnect\(\)/, "卸载应断开观察");
});

console.log("▶ AI 画布");
test("AI 画布向导创建 blank 工程并注入起步提示", () => {
  const src = read("client/src/components/AI画布向导.jsx");
  assert.match(src, /新建 AI 画布/, "应有向导标题");
  assert.match(src, /起步提示/, "应有可编辑起步提示");
  const panel = read("client/src/components/MapPanel.jsx");
  assert.match(panel, /kind: "blank"/, "应创建空白工程");
  assert.match(panel, /insertChatText\?\.\(prompt\)/, "应把起步提示写入对话栏");
  assert.match(panel, /新建 AI 画布/, "项目菜单应有入口");
});
test("项目仍绑定当前会话（单活动画布）", () => {
  const panel = read("client/src/components/MapPanel.jsx");
  assert.match(panel, /onProjectChange\?\.\(project\)/, "切换项目应通知会话");
  assert.match(panel, /initialProject/, "应接受会话记录的地图项目");
  assert.match(panel, /setProject\(target\)/, "会话项目变化应同步画布");
  const app = read("client/src/App.jsx");
  assert.match(app, /mergeMapContext/, "视口上报应合并上下文而不是覆盖");
  assert.match(app, /initialProject=\{currentMapProject\}/, "应把会话项目传给地图面板");
});

console.log("▶ Agent 工具与权限");
test("新增三个地图工具并登记到运行时", () => {
  const src = read("server/agent.mjs");
  for (const tool of ["map_layer_info", "map_reset", "map_project_create"]) {
    assert.ok(src.includes(`name: "${tool}"`), `缺少工具 ${tool}`);
  }
  assert.match(src, /mapLayerInfoTool, mapResetTool, mapProjectCreateTool/, "customTools 应注册");
});
test("Chat 只读不含写工具，Work 含工程级写工具", () => {
  const src = read("server/task.mjs");
  const readOnly = src.slice(src.indexOf("const READ_ONLY_TOOLS"), src.indexOf("const OFFICE_TOOLS"));
  assert.ok(readOnly.includes('"map_layer_info"'), "只读应含 map_layer_info");
  for (const tool of ["map_reset", "map_project_create"]) {
    assert.ok(!readOnly.includes(`"${tool}"`), `Chat 不应含 ${tool}`);
    assert.ok(src.includes(`"${tool}"`), `Work 应含 ${tool}`);
  }
});

test("地图面板接入文件树与初始页只读小地图", () => {
  const panel = read("client/src/components/MapPanel.jsx");
  assert.match(panel, /fileTreeOpen/, "应提供文件树开关");
  assert.match(panel, /地图文件树/, "应渲染文件树浮层");
  const tab = read("client/src/components/新会话页签.jsx");
  assert.match(tab, /MiniMapPreview/, "地图会话卡片应内嵌小地图");
  assert.match(tab, /onOpenMap/, "应提供继续编辑入口");
  const mini = read("client/src/components/MiniMapPreview.jsx");
  assert.match(mini, /readOnly/, "小地图应只读");
  assert.match(mini, /initialView/, "小地图应恢复上次视口");
});

console.log("▶ M2 与导入入口");
test("可视面板保留 M2 四项（含区域交换/路网结构）", () => {
  const src = read("client/src/components/可视面板.jsx");
  for (const key of ["m2-traffic-bandwidth", "m2-od-lines", "m2-exchange", "m2-road-structure"]) {
    assert.ok(src.includes(key), `缺少 M2 数据集 ${key}`);
  }
  assert.match(src, /mapExchangeSankey/, "区域交换应调用既有接口");
  assert.match(src, /mapRoadStructure/, "路网结构应调用既有接口");
});

console.log("▶ 文件与 API 契约");
test("新增组件文件存在", () => {
  for (const file of [
    "client/src/components/重置对话框.jsx",
    "client/src/components/图层属性对话框.jsx",
    "client/src/components/临时层转正对话框.jsx",
    "client/src/components/AI画布向导.jsx",
  ]) {
    assert.ok(exists(file), `缺少 ${file}`);
  }
});
test("客户端 API 封装工程化端点", () => {
  const src = read("client/src/api.js");
  for (const fn of ["mapLayerRegistry", "mapUpdateLayerMeta", "mapLayerReplace", "mapSetBaseline", "mapReset", "mapOperations"]) {
    assert.ok(src.includes(`export const ${fn}`), `缺少 ${fn}`);
  }
});

console.log(`\nGIS 画布与工程界面：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error.stack || f.error.message}`);
  process.exit(1);
}
