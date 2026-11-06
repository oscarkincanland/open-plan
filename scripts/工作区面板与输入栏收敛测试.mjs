#!/usr/bin/env node
/**
 * 输入栏与工作区收敛测试（2026-11-03，计划 007）：
 * 1. 输入栏：上下文用量与审批模式并入输入框下方工具条，消息流上方不再有独立横带；
 * 2. 「+」聚合菜单：图片 / 文件 / 地图视图合并到一个入口；
 * 3. 审批模式改为下拉（自动批准 / 每次询问）；
 * 4. 顶栏「工作区」入口改成卡片面板，且每张卡片仍复用既有打开逻辑（不新增页面）。
 *
 * 用法: node scripts/工作区面板与输入栏收敛测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed = 1;
  }
}

const chatPanel = read("client/src/components/ChatPanel.jsx");
const app = read("client/src/App.jsx");
const styles = read("client/src/styles.css");

console.log("\n▶ 输入栏收敛");

test("消息流上方不再有独立横带（上下文/审批并入输入栏）", () => {
  assert.doesNotMatch(chatPanel, /className="chat-topbar"/, "不应再有 .chat-topbar");
  assert.doesNotMatch(chatPanel, /chat-top-controls/, "不应再有 .chat-top-controls");
  assert.doesNotMatch(styles, /^\.chat-topbar \{/m, "不应再有 .chat-topbar 样式");
  // 上下文用量与审批模式都出现在输入框下方的工具条里
  const toolbarStart = chatPanel.indexOf('<div className="chat-toolbar">');
  const toolbarEnd = chatPanel.indexOf("</div>", chatPanel.indexOf("toolbar-session-group"));
  assert.ok(toolbarStart > 0, "应存在输入栏工具条");
  const toolbar = chatPanel.slice(toolbarStart, toolbarEnd > 0 ? toolbarEnd : toolbarStart + 4000);
  assert.match(toolbar, /<ContextUsageRing/, "上下文用量应移入输入栏工具条");
  assert.match(toolbar, /<ApprovalModeControl/, "审批模式应移入输入栏工具条");
});

test("「+」聚合菜单：图片、文件、地图视图合并为一个入口", () => {
  assert.match(chatPanel, /composer-add-menu/, "应有「+」聚合菜单");
  assert.match(chatPanel, /aria-label="添加内容"/, "「+」按钮要有可读标签");
  assert.match(chatPanel, /fileInputRef\.current\?\.click\(\)/, "菜单项应能打开图片选择");
  assert.match(chatPanel, /attInputRef\.current\?\.click\(\)/, "菜单项应能打开附件选择");
  // 图片与附件不再各占一个常驻按钮
  assert.doesNotMatch(chatPanel, /aria-label="上传图片"/, "图片不应再有独立常驻按钮");
  assert.doesNotMatch(chatPanel, /aria-label="上传附件（docx\/xlsx\/pdf\/md\/txt 等）"/, "附件不应再有独立常驻按钮");
});

test("审批模式是下拉选择（自动批准 / 每次询问）", () => {
  assert.match(chatPanel, /approval-mode-menu/, "应有审批模式下拉菜单");
  assert.match(chatPanel, /role="menuitemradio"/, "菜单项应为单选语义");
  assert.match(chatPanel, /pick\("auto"\)/, "应能选择自动批准");
  assert.match(chatPanel, /pick\("ask"\)/, "应能选择每次询问");
  assert.match(styles, /\.approval-mode-menu \{/, "应有下拉菜单样式");
});

test("上下文 chip 为紧凑形态，弹层向上展开且保留压缩入口", () => {
  assert.match(chatPanel, /variant="inline"/, "上下文圈应使用紧凑形态");
  assert.match(styles, /\.context-ring-wrap\.inline \.context-ring-pop \{ top: auto; bottom: calc\(100% \+ 6px\); \}/, "上下文弹层应向上展开");
  assert.match(chatPanel, /onCompact=\{compactContext\}/, "上下文弹层应保留压缩入口");
});

console.log("\n▶ 2026-11-03 界面收敛（左对齐 / 图标 / 空态 / 模型弹层）");

test("对话区内容列在对话区内居中，并随右侧画布宽度自适应", () => {
  // 2026-11-03 修订：用户要求回到居中——但居中的参照是「对话区自身宽度」，
  // 右侧画布开/关时中心列自动重新居中（不是相对整个窗口贴左或贴中）。
  assert.match(styles, /\.center-chat-slot \.chat-body > \.msg,[\s\S]{0,220}?margin-left: auto;/, "消息列应在对话区内居中");
  assert.doesNotMatch(styles, /\.center-chat-slot \.chat-body > \.msg,[\s\S]{0,220}?margin-left: 0;/, "消息列不应贴左");
  assert.match(styles, /\.center-chat-slot \.chat-body \{[\s\S]{0,200}?padding: 34px var\(--chat-gutter\) 28px;/, "消息区左右内边距对称，居中不受滚动条预留影响");
  assert.match(styles, /\.center-chat-slot \.chat-compose \{[\s\S]{0,300}?margin: 0 auto 18px;/, "输入区外壳应在对话区内居中");
  assert.match(styles, /\.center-chat-slot \.chat-input \{[\s\S]{0,220}?margin: 0 auto 18px;/, "输入框应在对话区内居中");
  assert.match(styles, /width: min\(var\(--msg-content-max\), calc\(100% - var\(--chat-gutter\) \* 2 - var\(--scrollbar-w\)\)\)/, "宽度随对话区可用宽度收缩（右侧画布开/关自适应）");
  assert.doesNotMatch(styles, /\.center-chat-slot \.msg > \.avatar/, "消息头像应移除");
  assert.doesNotMatch(chatPanel, /className=\{`avatar /, "消息组件不应再渲染头像容器");
  assert.match(chatPanel, /!hideHeader && !isUser/, "消息头只保留助手侧");
});

test("输入栏与顶栏图标去外框、尺寸统一 28px", () => {
  assert.match(styles, /\.chat-toolbar-group \{[\s\S]{0,260}?border: 0;/, "工具条分组不应再画外框");
  assert.match(styles, /\.approval-mode-control \{ display: inline-flex;[\s\S]{0,200}?min-height: 28px;[\s\S]{0,120}?border: 1px solid transparent;/, "审批按钮应为无框 28px");
  assert.match(styles, /\.context-ring-wrap\.inline \.context-ring-button \{ min-height: 28px;[\s\S]{0,160}?border: 1px solid transparent;/, "上下文 chip 应为无框 28px");
  assert.match(styles, /\.topbar-search-btn \{ width: 28px; height: 28px; flex: 0 0 auto;/, "搜索按钮应为 28px 且不被挤压");
  assert.match(styles, /\.topbar-tools-toggle \{ width: 28px; height: 28px; flex: 0 0 auto;/, "工作区按钮应为 28px 且不被挤压");
  assert.match(styles, /\.topbar-search-btn:hover \{ background: var\(--selected\); border-color: transparent;/, "搜索按钮只在该悬停时出浅底，不画框");
});

test("审批控件图标化 + 短文字（自动 / 询问）", () => {
  assert.match(chatPanel, /<Icon name=\{automatic \? "shield" : "shieldPlain"\} size=\{14\} \/>/, "应使用盾牌类图标并区分两档");
  assert.match(chatPanel, /\{automatic \? "自动" : "询问"\}/, "按钮文字应为极短标签");
  assert.match(chatPanel, /aria-label=\{automatic \? "工具审批：自动批准" : "工具审批：每次询问"\}/, "去掉长文字后要有完整无障碍标签");
  assert.match(read("client/src/components/Icon.jsx"), /shieldPlain:/, "shieldPlain 图标应存在");
});

test("空态恢复：AGENTS.md 提示不再写消息流", () => {
  assert.doesNotMatch(chatPanel, /pushSystem\("已加载工作区指令 AGENTS\.md/, "不应再把项目指令提示写进消息流");
  assert.match(chatPanel, /const hasProjectInstructions = useMemo\(/, "项目指令应改为派生状态");
  assert.match(chatPanel, /projectInstructions=\{hasProjectInstructions\}/, "应把派生状态传给欢迎卡片");
  assert.match(read("client/src/components/欢迎卡片.jsx"), /chat-empty-project-note/, "欢迎卡片应给一行弱提示");
  assert.match(styles, /\.chat-empty \{ color: var\(--muted\); text-align: center;/, "空态文字应与内容列一起居中");
  assert.match(styles, /\.center-chat-slot \.chat-empty \{ padding-top: 18vh;/, "空态保持垂直居中留白（欢迎页）");
  assert.match(styles, /\.chat-empty-steps \{[\s\S]{0,120}?justify-content: center;/, "空态步骤应居中");
  assert.match(styles, /\.chat-empty-examples \{[\s\S]{0,140}?justify-content: center;/, "空态示例应居中");
});

test("模型弹层：供应商条 + 渐变滑轨 + 星标保留", () => {
  assert.match(chatPanel, /model-provider-strip/, "弹层顶部应有供应商条");
  assert.match(chatPanel, /role="tablist" aria-label="供应商"/, "供应商条应是可切换的语义");
  assert.match(chatPanel, /const \[modelProviderFilter, setModelProviderFilter\] = useState\("all"\)/, "应有供应商过滤状态");
  assert.match(chatPanel, /if \(modelProviderFilter !== "all" && provider !== modelProviderFilter\) continue;/, "模型列表应随供应商过滤");
  assert.match(styles, /\.model-provider-chip\.on \{/, "供应商 chip 应有选中态");
  assert.match(styles, /linear-gradient\(90deg, var\(--success\), var\(--accent\)\)/, "思考深度滑轨应为渐变轨道");
  assert.match(styles, /\.model-thinking-control input\[type="range"\]::-webkit-slider-thumb \{/, "滑杆应有白色圆钮");
  assert.match(chatPanel, /onToggleFavorite=\{toggleFavoriteModel\}/, "收藏星标必须保留");
  assert.match(chatPanel, /<small>\{selectedProviderMeta\.label\} · \{selectedEffort\.shortLabel\}<\/small>/, "触发器第二行应显示供应商与思考档位");
});

console.log("\n▶ 顶栏工作区面板");

test("顶栏入口是面板而不是下拉菜单", () => {
  assert.match(app, /topbar-tools-panel/, "应有工作区面板");
  assert.match(app, /role="dialog" aria-label="工作区"/, "面板应是 dialog 语义");
  assert.doesNotMatch(app, /className="topbar-tools-menu"/, "不应再有下拉菜单");
  assert.doesNotMatch(styles, /\.topbar-tools-menu \{/, "不应再有下拉菜单样式");
  assert.match(styles, /\.topbar-tools-panel \{/, "应有面板样式");
  assert.match(app, /aria-label="工作区"/, "入口按钮要有可读标签");
});

test("面板只放现有能力，不新增终端或诊断页", () => {
  assert.doesNotMatch(app, /新建终端/, "不应新增终端入口");
  assert.doesNotMatch(app, /会话数据诊断/, "不应新增会话数据诊断入口");
  // 五张主卡片
  for (const label of ["工作区文件", "工作产物", "本轮改动", "内置浏览器", "任务中心"]) {
    assert.ok(app.includes(`<strong>${label}</strong>`), `面板应包含「${label}」卡片`);
  }
});

test("每张卡片仍调用既有打开逻辑（不新增页面类型）", () => {
  assert.match(app, /setCanvasSideOpen\(true\)/, "工作区文件应复用文件树抽屉");
  assert.match(app, /openCanvasView\("artifacts"\)/, "工作产物应复用画布页签");
  assert.match(app, /openCanvasView\("changes"\)/, "本轮改动应复用画布页签");
  assert.match(app, /openCanvasView\("browser"\)/, "内置浏览器应复用画布页签");
  assert.match(app, /taskCenterRef\.current\?\.open\(\)/, "任务中心应复用既有打开入口");
  assert.match(app, /handleNewSession\(undefined, \{ agentId: currentSession\?\.agentId \|\| "" \}\)/, "新建对话应复用既有逻辑");
});

console.log(failed ? "\n工作区面板与输入栏收敛测试：存在失败\n" : "\n工作区面板与输入栏收敛测试：全部通过\n");
process.exit(failed ? 1 : 0);
