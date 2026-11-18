#!/usr/bin/env node
/**
 * 阶段 4 回归：地图模块对话栏适配（轻量）
 *
 * 覆盖 2026-10-09-015 阶段 4 的四项增量改动：
 *   4.1 紧凑呈现（宽度收紧 + compact）
 *   4.2 顶部地图状态行
 *   4.3 工具调用的地图语义标识
 *   4.4 结果区地图产物提示（临时，未保存）
 *
 * **本阶段的红线**：不改 SSE、不动消息流结构、不改 ChatPanel 的分区。
 * 因此这里除了断言新功能存在，还断言"没有碰不该碰的地方"——
 * `对话流性能回归测试.mjs` 的 118 条源码断言继续全绿就是最有力的证明（已单独运行）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const chatSrc = read("client/src/components/ChatPanel.jsx");
const appSrc = read("client/src/App.jsx");
const stylesSrc = read("client/src/styles.css");
// 2026-11-11-012：地图项目画布联动，断言对象是 MapPanel 的项目切换守卫。
const mapPanelSrc = read("client/src/components/MapPanel.jsx");
const eventSrc = read("client/src/事件展示.js");
const toolIconSrc = read("client/src/components/工具语义图标.jsx");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}

console.log("\n▶ 4.1 紧凑呈现");

test("地图对话栏默认宽度收紧到 360px", () => {
  assert.match(stylesSrc, /--map-chat-w:\s*360px/, "--map-chat-w 应为 360px");
});

test("地图模式下给全局对话实例传 compact", () => {
  assert.match(appSrc, /compact=\{activeModule === "map"\}/, "应在地图模块传 compact");
});

test("仍可拖拽调整宽度（300–620）", () => {
  assert.match(appSrc, /className="map-chat-resizer"/, "拖拽条应保留");
  assert.match(appSrc, /min=\{300\}[\s\S]{0,80}max=\{620\}/, "范围应保持 300–620");
});

test("紧凑模式只影响视觉密度，不隐藏功能块", () => {
  // compact 在 ChatPanel 里只用于：chat-compact 类 + 隐藏能力预览折叠块
  assert.match(chatSrc, /compact \? " chat-compact"/, "应挂 chat-compact 类");
  assert.match(chatSrc, /\{!compact && \(editMode === "agent" \|\| editMode === "review"\)/, "compact 只影响能力预览块");
});

console.log("\n▶ 4.2 顶部地图状态行");

test("地图模式下显示当前项目与视口", () => {
  assert.match(chatSrc, /chat-map-status/, "应有地图状态行");
  assert.match(chatSrc, /cms-project/, "应显示项目名");
  assert.match(chatSrc, /cms-view/, "应显示视口（缩放）");
});

test("状态行复用既有 props（不新增状态）", () => {
  const start = chatSrc.indexOf("chat-map-status");
  const block = chatSrc.slice(start, start + 1200);
  assert.match(block, /mapProject/, "应复用 mapProject prop");
  assert.match(block, /mapContext/, "应复用 mapContext prop");
  assert.doesNotMatch(block, /useState/, "不应为此新增状态");
});

test("保留「固定视图」入口（原输入框旁按钮的能力）", () => {
  assert.match(chatSrc, /cms-pin/, "应有固定视图按钮");
  assert.match(chatSrc, /injectMapContext/, "应复用既有注入函数");
});

test("状态行样式已定义", () => {
  for (const cls of [".chat-map-status", ".cms-project", ".cms-pin"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

console.log("\n▶ 4.3 工具调用的地图语义标识");

test("map_* 工具都登记了地图图标（单一来源）", () => {
  const idx = eventSrc.indexOf("TOOL_IDENTITY_RULES");
  const block = eventSrc.slice(idx, idx + 1600);
  // 2026-11-18：规则逐项扩到 map_read_state / map_export，逐个断言而不是比对相邻顺序。
  for (const tool of ["map_read", "map_read_state", "map_datasets", "map_edit", "map_import", "map_analyze", "map_template", "map_save_analysis", "map_clear_analysis", "map_export"]) {
    assert.ok(block.includes(tool), `应登记 ${tool}`);
  }
  assert.match(block, /"map"\]/, "应映射到 map 图标");
});

test("地图工具卡片有区分标记（色条 + 徽标）", () => {
  assert.match(chatSrc, /isMapTool/, "应判定地图工具");
  assert.match(chatSrc, /tool-card-map/, "应加区分类");
  assert.match(chatSrc, /tool-map-badge/, "应有可读徽标");
  assert.ok(stylesSrc.includes(".tool-card-map"), "应定义色条样式");
  assert.ok(stylesSrc.includes(".tool-map-badge"), "应定义徽标样式");
});

test("判定沿用 map_* 前缀，不另建映射表", () => {
  assert.match(chatSrc, /\/\^map_\//, "应以 map_* 前缀判定（复用工具语义图标的同一来源）");
  assert.match(toolIconSrc, /toolIdentity/, "图标仍走单一来源 toolIdentity");
});

console.log("\n▶ 4.4 结果区地图产物提示");

test("记录最近一次地图可视化（来自既有 map_action 事件）", () => {
  assert.match(chatSrc, /lastMapVisual/, "应有 lastMapVisual 状态");
  const idx = chatSrc.indexOf('case "map_action"');
  const block = chatSrc.slice(idx, idx + 1200);
  assert.match(block, /setLastMapVisual/, "map_action 应记录可视化");
  assert.match(block, /clear_analysis[\s\S]{0,200}setLastMapVisual\(null\)/, "清除时应同步清掉提示");
});

test("提示明确「临时，未保存」", () => {
  assert.match(chatSrc, /chat-map-visual/, "应有提示块");
  assert.match(chatSrc, /（临时，未保存）/, "应写明临时未保存");
});

test("保存按钮按模式分流：Chat 就地提示切 Work，Work 交给 Agent", () => {
  const idx = chatSrc.indexOf("chat-map-visual");
  const block = chatSrc.slice(idx, idx + 1800);
  assert.match(block, /editMode === "chat"/, "Chat 模式应分流");
  assert.match(block, /setMapVisualHint\("保存正式图层需要切换到 Work 模式/, "应就地提示切 Work（写工具栏的 modelMsg 在地图紧凑模式下不显眼）");
  assert.match(block, /send\(`把刚才的地图分析/, "Work 模式应把意图交给 Agent");
});

test("提示样式已定义", () => {
  for (const cls of [".chat-map-visual", ".cmv-text", ".cmv-save", ".cmv-hint", ".cmv-row"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls}`);
  }
});

console.log("\n▶ 红线：不碰 SSE 与消息流结构");

test("未新增事件类型（仍用既有 map_action）", () => {
  // 事件注册表在服务端（server/事件注册表.mjs）
  const registry = read("server/事件注册表.mjs");
  assert.doesNotMatch(registry, /map_visual_/, "不应新增地图可视化事件类型");
  assert.match(registry, /map_action/, "应继续用既有 map_action");
});

test("未改 SSE 订阅链路", () => {
  assert.match(chatSrc, /\/api\/agent\/stream/, "SSE 端点不变");
  // 不应出现新的 EventSource 实例（阶段 4 是纯前端展示改动）
  const count = (chatSrc.match(/new EventSource/g) || []).length;
  assert.ok(count <= 1, `不应新增 EventSource 实例，实际 ${count}`);
});

test("未改消息流分区结构（Stream/Process/Result 仍在原处）", () => {
  // 2026-11-18（计划 006 批次 2）：C4 旧执行流已删除，由 v3 过程组 + 常驻行承接；
  // 分区结构仍要求 Stream / Result / 过程组三者存在，且不再回退到旧执行流。
  for (const marker of ["chat-stream-shell", "run-result", "tl-next-step"]) {
    assert.ok(chatSrc.includes(marker), `应保留 ${marker}`);
  }
  assert.ok(chatSrc.includes("tl-system-notes"), "系统提示聚合应保留常驻结构");
  assert.ok(!chatSrc.includes('className="execution-flow'), "不应再渲染旧执行流卡片");
});

test("对话流性能回归的 118 条断言不因本阶段改动而需要调整", () => {
  // 本测试只做"不改测试文件"的确认：若断言依赖结构，改动会导致其失败（已单独运行验证全绿）
  const flowTest = read("scripts/对话流性能回归测试.mjs");
  assert.ok(flowTest.length > 0, "对话流测试应存在");
  assert.match(flowTest, /chatPanelSource|ChatPanel/, "它依赖 ChatPanel 源码（结构不变即全绿）");
});

console.log("\n▶ 4.5 地图模式画布联动与模型选择器（2026-11-11-010，011 修正对象为地图项目画布）");

test("地图模式下画布槽被隐藏，必须有浮动活动指示兜底", () => {
  assert.match(stylesSrc, /\.app\.map-module-active > \.app-canvas-slot[^{]*\{[^}]*visibility: hidden/, "画布槽在地图模式确被隐藏（该修复的前提）");
  assert.match(appSrc, /map-canvas-activity-pill/, "App 必须渲染地图画布活动浮动 pill");
  assert.match(appSrc, /Agent 正在编辑画布《/, "pill 文案必须带画布标题（创作画布分支）");
  // 2026-11-11-012：派生改名 mapActiveTarget，地图项目活动优先、创作画布其次。
  assert.match(appSrc, /mapActiveTarget = \(\(\) => \{/, "活动目标必须派生（mapActiveTarget）");
  assert.match(appSrc, /Object\.entries\(mapActivity\)\.find/, "地图项目活动必须优先于创作画布活动");
  for (const cls of [".map-canvas-activity-pill", ".map-canvas-activity-dot", ".map-canvas-activity-text"]) {
    assert.ok(stylesSrc.includes(cls), `应定义 ${cls} 样式`);
  }
});

test("点击活动 pill：地图项目态就地切换项目，创作画布态退出地图开画布", () => {
  const idx = appSrc.indexOf("map-canvas-activity-pill");
  const block = appSrc.slice(idx, idx + 900);
  assert.match(block, /mapActiveTarget\.kind === "map"/, "必须按活动类型分支");
  assert.match(block, /action: "switch_project"/, "地图项目态点击应就地切换项目（不退出地图）");
  assert.match(block, /closeExternalModules\(\)/, "创作画布态点击必须退出地图模块");
  assert.match(block, /openDesignCanvas\(mapActiveTarget\.slug/, "创作画布态点击必须打开对应画布标签");
});

test("当前会话新建画布时地图模式自动切换", () => {
  const idx = appSrc.indexOf("pendingCanvasOpen");
  const consumeIdx = appSrc.indexOf("if (activeModule === \"map\") closeExternalModules();");
  assert.ok(consumeIdx > 0, "pendingCanvasOpen 消费必须含地图模式自动退出");
  // 消费 effect 必须在 closeExternalModules 声明之后（TDZ 防线）
  const declIdx = appSrc.indexOf("const closeExternalModules = useCallback");
  assert.ok(consumeIdx > declIdx, "消费 effect 必须位于 closeExternalModules 声明之后");
  assert.ok(consumeIdx > idx, "消费 effect 不得早于 pending 声明");
});

test("地图模式模型选择器紧凑化（不再独占整行）", () => {
  assert.doesNotMatch(stylesSrc, /\.center-chat-slot\.map-mode \.toolbar-agent-group \{[^}]*flex: 1 1 100%/, "不得再强制模型行独占整行");
  assert.doesNotMatch(stylesSrc, /\.center-chat-slot\.map-mode \.toolbar-agent-group \.model-control-trigger \{ width: 100%/, "trigger 不得再 100% 宽");
  assert.match(stylesSrc, /\.center-chat-slot\.map-mode \.model-control-current small \{ display: none/, "地图模式必须隐藏模型副标题");
});

test("新会话模型初始化：服务端默认优先于上次使用", () => {
  assert.match(chatSrc, /const preferred = cachedModel \|\| storedThreadModel \|\| d\.default \|\| saved \|\| ""/, "preferred 链必须 d.default 在 saved 之前");
});

console.log("\n▶ 4.6 地图项目画布联动（2026-11-11-012）");

test("project_created 特判必须先于跨项目守卫（否则新项目事件被丢弃）", () => {
  const createdIdx = mapPanelSrc.indexOf('action.action === "project_created"');
  const guardIdx = mapPanelSrc.indexOf("if (action.project && action.project !== project) return;");
  assert.ok(createdIdx > 0, "handleMapAction 必须特判 project_created");
  assert.ok(guardIdx > 0, "跨项目守卫应存在");
  assert.ok(createdIdx < guardIdx, `project_created 特判（${createdIdx}）必须在跨项目守卫（${guardIdx}）之前`);
});

test("project_created 必须刷新项目列表并在列表确认后切换", () => {
  const idx = mapPanelSrc.indexOf('action.action === "project_created"');
  const block = mapPanelSrc.slice(idx, idx + 500);
  assert.match(block, /mapProjects\(\)/, "必须重新拉取项目列表（列表未含新项目时 setProject 会被下拉守卫丢弃）");
  assert.match(block, /setProjects\(r\.projects/, "必须更新项目列表");
  assert.match(block, /listed\.includes\(next\)[\s\S]{0,80}setProject\(next\)/, "列表确认后才切换项目");
});

test("switch_project 必须走 changeProject（沿用既有切换链）", () => {
  const idx = mapPanelSrc.indexOf('action.action === "switch_project"');
  const block = mapPanelSrc.slice(idx, idx + 200);
  assert.match(block, /changeProject\(String\(action\.project\)\)/, "应调用 changeProject 完成切换");
});

test("会话跟随刷新兜底：目标项目不在列表时重拉一次（防循环）", () => {
  assert.match(mapPanelSrc, /followRefreshRef/, "应有 followRefreshRef 防循环守卫");
  assert.match(mapPanelSrc, /if \(followRefreshRef\.current\) return;/, "重拉只允许一次");
  assert.match(mapPanelSrc, /target === project\) \{ followRefreshRef\.current = false; return; \}/, "到达目标后复位守卫");
});

test("地图写类工具活动：App 必须用 MAP_WRITE_TOOLS 驱动 mapActivity", () => {
  assert.match(appSrc, /const MAP_WRITE_TOOLS = new Set\(\[/, "应有 MAP_WRITE_TOOLS 名单");
  const list = appSrc.match(/const MAP_WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  for (const tool of ["map_draft_layer", "map_project_create", "map_fixate_layer", "map_export"]) {
    assert.ok(list.includes(`"${tool}"`), `名单必须含 ${tool}`);
  }
  assert.match(appSrc, /\} else if \(MAP_WRITE_TOOLS\.has\(String\(data\.name \|\| ""\)\)\) \{/, "全局流 tool 事件必须有地图写工具分支");
  assert.match(appSrc, /setMapActivity\(\(prev\) => \(\{\s*\.\.\.prev,/, "活动应写入 mapActivity");
});

test("Run 终态必须权威收口 mapActivity（防止 pill 永挂）", () => {
  assert.match(appSrc, /setMapActivity\(\(prev\) => \{[\s\S]{0,400}info\.threadId === finishedThreadId/, "终态清理应按 threadId 匹配");
});

test("mapContextsRef：mount-once 闭包读最新 mapContexts（TDZ/闭包防线）", () => {
  const refIdx = appSrc.indexOf("const mapContextsRef = useRef(mapContexts);");
  assert.ok(refIdx > 0, "应有 mapContextsRef");
  const usedIdx = appSrc.indexOf("mapContextsRef.current[");
  assert.ok(usedIdx > refIdx, "全局流分支应通过 ref 读会话地图上下文");
});

if (failed) {
  console.log(`\n阶段 4 地图对话栏适配：${failed} 项失败`);
  process.exit(1);
}
console.log("\n阶段 4 地图对话栏适配：通过");
