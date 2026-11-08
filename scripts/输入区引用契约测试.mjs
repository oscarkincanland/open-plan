#!/usr/bin/env node
/**
 * 输入区引用契约测试（2026-11-08 D3；计划 2026-11-08-001 §7 D3-2、DESIGN §7 输入区、ADR-0029）
 *
 * 守护（静态源码断言 + 纯函数行为断言）：
 *   1) 组件存在：client/src/引用标记.js、client/src/components/输入区/{Composer,ComposerPanel,useComposerState}；
 *   2) 单一候选面板：`/ @ # &` 统一到 composerMenu/useComposerState，mentionState 独立弹层被短路；
 *   3) `#` 组技能来源改为 `/api/skills`（不再只读 project.settings.skills），首次打开带加载态；
 *   4) `/` 命令选中即执行（复用 send() 的命令分支），不再插入命令文本进消息流；
 *   5) 引用 chip 三态（已解析/待解析/缺失）+ 输入栏 chip 删除同步删除 textarea 标记 + 气泡 chip 替代原文；
 *   6) 键盘/IME：composition 期间不拦截、面板打开时 ↑↓/Tab/Enter/Esc 只作用于面板、Esc 只关一层；
 *   7) 失败兜底：未识别标记发送前提示（lintReferenceMarkers）；
 *   8) flag("composerUnified") 默认关，关闭时旧四触发器路径原样保留（基线行为）。
 *
 * 用法: node scripts/输入区引用契约测试.mjs（npm run test:composer-refs）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const importLocal = (rel) => import(`file://${path.join(ROOT, rel).replace(/\\/g, "/")}`);

const CHAT = "client/src/components/ChatPanel.jsx";
const PARSER = "client/src/引用标记.js";
const COMPOSER = "client/src/components/输入区/Composer.jsx";
const PANEL = "client/src/components/输入区/ComposerPanel.jsx";
const STATE = "client/src/components/输入区/useComposerState.js";
const STYLES = "client/src/styles.css";

const chat = read(CHAT);
const composer = read(COMPOSER);
const panel = read(PANEL);
const state = read(STATE);
const parser = read(PARSER);
const styles = read(STYLES);

const composerState = await importLocal(STATE);
const { COMPOSER_GROUPS, detectComposerTrigger, applyComposerPick, resolveComposerKey, buildComposerItems } = composerState;

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};

console.log("\n▶ 组件存在与 flag 门控");

test("输入区三件套 + 共享解析器存在且非空", () => {
  for (const file of [PARSER, COMPOSER, PANEL, STATE]) {
    assert.ok(exists(file), `${file} 不存在`);
    assert.ok(read(file).trim().length > 400, `${file} 内容过少`);
  }
});

test("ChatPanel 用 flag(\"composerUnified\")，默认 false，flagsReady 后补读", () => {
  assert.match(chat, /flag\("composerUnified"\)/, "缺少 flag(\"composerUnified\")");
  assert.match(chat, /const \[composerUnified, setComposerUnified\] = useState\(false\)/, "开关默认必须为 false（关闭=基线）");
  assert.match(chat, /const \[composerUnified, setComposerUnified\] = useState\(false\)[\s\S]{0,700}flagsReady\.then\(apply\)/, "缺少 flagsReady 补读");
  assert.match(chat, /composerUnifiedRef\.current = composerUnified/, "缺少同步 ref");
});

test("flag 关闭时旧四触发器路径原样保留（旧菜单 + 提及菜单 + 旧解析器）", () => {
  assert.match(chat, /\{!composerUnified && composerMenu && composerItems\.length > 0 && \(/, "旧 composer-suggestions 必须受 !composerUnified 保护");
  assert.match(chat, /\{!composerUnified && mentionState && mentionFiltered\.length > 0 && \(/, "旧提及菜单必须受 !composerUnified 保护");
  assert.match(chat, /const composerTrigger = \(value\) =>/, "旧触发器保留");
  assert.match(chat, /function parseReferenceMarkers\(text = ""\)/, "旧解析器保留（flag 关基线）");
});

console.log("\n▶ 单一候选面板（mentionState 被短路）");

test("统一面板只有一个渲染出口，并带四组", () => {
  assert.match(chat, /<Composer\b/, "ChatPanel 未渲染统一 Composer");
  assert.match(chat, /menu=\{unifiedComposer\.menu\}/);
  assert.match(chat, /items=\{unifiedComposer\.items\}/);
  const ids = COMPOSER_GROUPS.map((group) => group.id);
  assert.deepEqual(ids, ["action", "reference", "skill", "session"], "四组必须为 动作/引用/技能与插件/会话");
  for (const label of ["动作", "引用", "技能与插件", "会话"]) {
    assert.ok(COMPOSER_GROUPS.some((group) => group.label === label), `缺少分组 ${label}`);
  }
  assert.match(panel, /role="tablist"/, "分组 tab 需要 tablist 语义");
  assert.match(panel, /role="listbox"/, "候选列表需要 listbox 语义");
});

test("统一模式下 mentionState 与旧 composerMenu 被短路（不出现双弹层）", () => {
  assert.match(chat, /if \(composerUnified\) \{[\s\S]{0,500}setComposerMenu\(null\);[\s\S]{0,120}setMentionState\(null\);[\s\S]{0,200}unifiedComposer\.openFromText/, "onChange 必须先短路旧状态再开统一面板");
  // 统一键盘分支在旧提及/旧菜单分支之前 return，旧弹层在 flag 开时不可能被键盘选中
  const unifiedKeydown = chat.indexOf("const decision = resolveComposerKey(");
  const legacyMentionKeydown = chat.indexOf("pickMention(mentionFiltered[mentionIndex]", unifiedKeydown);
  assert.ok(unifiedKeydown > 0, "缺少统一 keydown 分发");
  assert.ok(legacyMentionKeydown > unifiedKeydown, "旧提及键盘分支必须在统一分支之后");
});

test("@ 智能体并入引用组，不再有独立状态机", () => {
  assert.match(state, /kind: "agent"/, "引用组必须包含智能体子项");
  assert.match(state, /referenceMarker\("agent", agent\.name\)/, "智能体插入 @智能体[…] 标记");
  assert.match(chat, /agentMentions=\{parseAgentMentions\(input\)\}/, "输入栏 agent chip 由统一解析派生");
});

console.log("\n▶ `#` 技能来源与加载态");

test("`#` 组读 /api/skills（全量技能）且首次打开带加载态", () => {
  assert.match(chat, /fetch\("\/api\/skills", \{ cache: "no-store" \}\)/, "缺少 /api/skills 拉取");
  assert.match(chat, /const \[skillCatalog, setSkillCatalog\] = useState\(\[\]\)/, "缺少技能目录状态");
  assert.match(chat, /setSkillCatalogLoading\(true\)/, "缺少加载态开始");
  assert.match(chat, /skillCatalogLoadedRef/, "缺少“只加载一次”标记");
  assert.match(chat, /loading=\{\{ reference: referenceSourceLoading, skill: skillCatalogLoading \}\}/, "加载态未传给面板");
  assert.match(state, /input\.skills/, "技能组未使用注入的技能列表");
  assert.match(panel, /正在加载技能/, "面板缺少技能加载文案");
  // 旧路径仍读 project.settings.skills（flag 关基线），统一路径不再依赖它
  assert.match(chat, /project\?\.settings\?\.skills/, "旧路径保留（基线）");
  const unifiedSkillBlock = chat.slice(chat.indexOf("const unifiedComposer = useComposerState("), chat.indexOf("// `#` 技能候选"));
  assert.ok(!unifiedSkillBlock.includes("project?.settings?.skills"), "统一面板不得再读 project.settings.skills");
});

test("插件仍用既有 MCP 列表，文件沿用 referenceFiles", () => {
  assert.match(chat, /\/api\/integrations\/mcp\/servers/, "插件列表端点缺失");
  assert.match(chat, /plugins: mcpServers\.map/, "统一面板未接 MCP 列表");
  assert.match(chat, /files: referenceFiles/, "统一面板未接 referenceFiles");
});

console.log("\n▶ `/` 命令选中即执行");

test("动作组项标记 execute=command，选中后走 send() 命令分支", () => {
  assert.match(state, /execute: "command"/, "命令项缺少 execute 标记");
  assert.match(chat, /item\.execute === "command"/, "选中处理未区分命令");
  assert.match(chat, /void send\(command\)/, "命令未复用 send() 既有命令分支");
  assert.match(chat, /if \(\/\^\\\/goal\$\/i\.test\(command\)\)/, "/goal 参数按计划简化为插入文本");
  assert.match(panel, /Enter 执行/, "动作组提示应为“执行”");
});

test("命令不会插入消息流：选中不调用 applyComposerPick 插文本", () => {
  const pickStart = chat.indexOf("const pickUnifiedComposerItem = (item) => {");
  const pickEnd = chat.indexOf("// chip 删除", pickStart);
  const block = chat.slice(pickStart, pickEnd);
  assert.ok(pickStart > 0 && pickEnd > pickStart, "找不到选中处理函数");
  const commandBranch = block.slice(block.indexOf('if (item.execute === "command")'), block.indexOf("void send(command);") + "void send(command);".length);
  assert.ok(commandBranch.includes("void send(command);"), "命令分支必须复用 send()");
  assert.ok(!commandBranch.includes("applyComposerPick(value, menu, item.insert)"), "命令分支不得插入命令文本");
});

console.log("\n▶ 引用 chip 三态与双向同步");

test("输入栏 chip 三态 + 删除 chip 同步删除 textarea 标记", () => {
  assert.match(chat, /import \{[\s\S]{0,400}removeReferenceMarker[\s\S]{0,400}\} from "\.\.\/引用标记\.js"/, "未引入 removeReferenceMarker");
  assert.match(chat, /const removeUnifiedReference = \(ref\) => \{[\s\S]{0,300}setReferences\(\(previous\) => previous\.filter\(\(item\) => item\.id !== ref\.id\)\);[\s\S]{0,120}updateInput\(\(value\) => removeReferenceMarker\(value, ref\)\)/, "chip 删除未同步删文本");
  assert.match(chat, /onRemoveReference=\{removeUnifiedReference\}/, "Composer 未接删除回调");
  assert.match(composer, /onRemoveReference/, "chip 条缺少删除入口");
  assert.match(parser, /export function removeReferenceMarker/, "解析器缺少 removeReferenceMarker");
});

test("chip 三态映射：已解析 / 待解析 / 缺失，状态不只靠颜色（附图标）", () => {
  assert.match(parser, /export function referenceStatusTone/, "缺少三态映射");
  assert.match(composer, /is-\$\{tone\}/, "输入栏 chip 未按三态着色");
  assert.match(composer, /<Icon name="check"/, "已解析态需要图标");
  assert.match(composer, /<Icon name="warning"/, "缺失态需要图标");
  assert.match(panel, /composer-panel/, "面板类名缺失");
});

test("气泡 chip 扩展 skill/plugin/session/agent，并剥离原始标记文本", () => {
  assert.match(chat, /stripReferenceMarkers/, "气泡未剥离原始标记");
  assert.match(chat, /const bubbleReferences = isUser && unifiedComposer/, "用户气泡 references 未按开关派生");
  assert.match(chat, /parseAgentMentions\(m\.text \|\| ""\)/, "气泡未补 @智能体 chip");
  const chipsStart = chat.indexOf("function ReferenceChips({ references = [], onOpenFile, unified = false })");
  assert.ok(chipsStart > 0, "ReferenceChips 缺少 unified 参数");
  const chipsBlock = chat.slice(chipsStart, chat.indexOf("const STREAMING_ACTIVITY_LABELS", chipsStart));
  assert.match(chipsBlock, /REFERENCE_KIND_META\[r\.kind\]/, "气泡 chip 未按类型渲染");
  assert.match(chipsBlock, /referenceStatusTone\(r\)/, "气泡 chip 未显示服务端解析状态");
  assert.match(chipsBlock, /unified\) \{/, "ReferenceChips 缺少统一分支");
  // flag 关时保留旧的 @label 渲染
  assert.match(chipsBlock, /@\{label\}/, "基线气泡 chip 渲染被破坏");
});

console.log("\n▶ 键盘 / IME / Esc 分层");

test("composition 期间全部放行（Enter/Tab/数字/Esc 不拦截）", () => {
  assert.match(state, /if \(composition\) return \{ action: "pass", reason: "composition" \}/, "resolveComposerKey 缺少 composition 放行");
  assert.match(chat, /composition: e\.nativeEvent\?\.isComposing === true \|\| e\.keyCode === 229/, "ChatPanel 未传入 composition 状态");
  assert.match(chat, /onCompositionEnd=\{\(e\) => \{[\s\S]{0,220}unifiedComposer\.openFromText/, "compositionend 后未重算触发");
});

test("面板打开时 ↑↓/Tab/Enter/Esc 只作用于面板；关闭时 Enter 发送", () => {
  assert.match(state, /if \(key === "ArrowDown"\) return \{ action: "move", delta: 1 \}/);
  assert.match(state, /if \(key === "Tab"\) return \{ action: "switch-group"/);
  assert.match(state, /if \(key === "Enter"\) return \{ action: "pick"/);
  assert.match(state, /if \(key === "Escape"\) return \{ action: "close" \}/);
  assert.match(state, /if \(key === "Enter" && !shiftKey\) return \{ action: "send" \}/);
  // Esc 只关一层：面板打开时 stopPropagation，避免顺带关掉「+」菜单
  assert.match(chat, /decision\.action === "close"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); unifiedComposer\.close\(\);/, "Esc 关闭面板时未阻止冒泡（会一次关两层）");
});

test("数字键 1–9 仅在面板打开且有对应项时选中", () => {
  assert.match(state, /\/\^\[1-9\]\$\/\.test\(key\) && Number\(key\) <= itemCount/, "数字直选缺少边界判断");
});

console.log("\n▶ 失败兜底");

test("发送前 lint 未识别标记并提示，不静默", () => {
  assert.match(chat, /import \{[\s\S]{0,300}lintReferenceMarkers/, "未引入 lintReferenceMarkers");
  assert.match(chat, /const lint = lintReferenceMarkers\(rawText\);/, "发送前未扫描标记");
  assert.match(chat, /setComposerNotice\(lint\.ok \? null : \{/, "未设置提示条");
  assert.match(composer, /composer-notice/, "提示条未渲染");
  assert.match(composer, /role="status"/, "提示条缺少 aria-live 状态");
  assert.match(parser, /export function lintReferenceMarkers/, "解析器缺少 lint");
});

console.log("\n▶ 样式与窄屏");

test("样式只用既有令牌，窄屏不溢出", () => {
  for (const token of ["--border", "--radius-sm", "--radius-lg", "--muted", "--success", "--danger", "--warning", "--panel2-bg", "--selected"]) {
    assert.ok(styles.includes(`var(${token})`), `缺少既有令牌 ${token}`);
  }
  const panelStyles = styles.slice(styles.indexOf("/* ===== 输入区统一面板"), styles.indexOf("@media (max-width: 560px)", styles.indexOf("/* ===== 输入区统一面板")));
  assert.ok(panelStyles.includes(".composer-panel"), "缺少面板样式");
  assert.ok(panelStyles.includes(".composer-chip"), "缺少 chip 样式");
  assert.ok(panelStyles.includes(".composer-notice"), "缺少提示条样式");
  assert.ok(panelStyles.includes(".msg-reference-chip.missing"), "缺少气泡缺失态样式");
  const narrow = styles.slice(styles.indexOf("@media (max-width: 560px)", styles.indexOf("/* ===== 输入区统一面板")));
  assert.ok(narrow.slice(0, 600).includes(".composer-panel"), "窄屏缺少面板适配");
  assert.ok(narrow.slice(0, 600).includes(".composer-chip"), "窄屏缺少 chip 换行适配");
});

console.log("\n▶ 纯函数行为");

test("detectComposerTrigger：行首/空白后触发，路径与转义不触发", () => {
  assert.deepEqual(detectComposerTrigger("/", 1), { symbol: "/", group: "action", query: "", start: 0 });
  assert.deepEqual(detectComposerTrigger("请 /co", 5), { symbol: "/", group: "action", query: "co", start: 2 });
  assert.deepEqual(detectComposerTrigger(" @文", 3), { symbol: "@", group: "reference", query: "文", start: 1 });
  assert.deepEqual(detectComposerTrigger("#pp", 3), { symbol: "#", group: "skill", query: "pp", start: 0 });
  assert.deepEqual(detectComposerTrigger("&", 1), { symbol: "&", group: "session", query: "", start: 0 });
  assert.equal(detectComposerTrigger("a/b", 3), null, "正文里的 / 不触发命令");
  assert.equal(detectComposerTrigger("邮箱@", 3), null, "非行首/空白后的 @ 不触发");
  assert.equal(detectComposerTrigger("@@", 2), null, "@@ 转义不触发");
  assert.equal(detectComposerTrigger("@文件[abc]", 8), null, "完整标记不重复触发");
  assert.equal(detectComposerTrigger("@智能体[公文]", 8), null, "完整提及标记不触发");
});

test("applyComposerPick：区间替换而非末尾追加", () => {
  assert.equal(applyComposerPick("请 /co 一下", { start: 2, query: "co" }, "/compact"), "请 /compact 一下");
  assert.equal(applyComposerPick("@文", { start: 0, query: "文" }, "@文件[a.docx]"), "@文件[a.docx] ");
  assert.equal(applyComposerPick("前缀 ", { start: 3, query: "" }, "#技能[ppt]"), "前缀 #技能[ppt] ");
});

test("resolveComposerKey：composition 放行 / 面板优先 / 关闭才发送", () => {
  assert.equal(resolveComposerKey({ key: "Enter", composition: true, menuOpen: true, itemCount: 3 }).action, "pass");
  assert.equal(resolveComposerKey({ key: "Escape", composition: true, menuOpen: true }).action, "pass");
  assert.deepEqual(resolveComposerKey({ key: "ArrowDown", menuOpen: true, itemCount: 3, activeIndex: 2 }), { action: "move", delta: 1 });
  assert.deepEqual(resolveComposerKey({ key: "Tab", menuOpen: true, itemCount: 3 }), { action: "switch-group", delta: 1 });
  assert.deepEqual(resolveComposerKey({ key: "Tab", shiftKey: true, menuOpen: true, itemCount: 3 }), { action: "switch-group", delta: -1 });
  assert.deepEqual(resolveComposerKey({ key: "Enter", menuOpen: true, itemCount: 3, activeIndex: 1 }), { action: "pick", index: 1 });
  assert.deepEqual(resolveComposerKey({ key: "Escape", menuOpen: true, itemCount: 3 }), { action: "close" });
  assert.deepEqual(resolveComposerKey({ key: "3", menuOpen: true, itemCount: 3 }), { action: "pick", index: 2 });
  assert.equal(resolveComposerKey({ key: "3", menuOpen: true, itemCount: 2 }).action, "pass", "越界数字当普通输入");
  assert.deepEqual(resolveComposerKey({ key: "Enter", menuOpen: false }), { action: "send" });
  assert.equal(resolveComposerKey({ key: "Enter", shiftKey: true, menuOpen: false }).action, "pass", "Shift+Enter 换行");
  assert.equal(resolveComposerKey({ key: "Escape", menuOpen: false }).action, "pass", "面板关闭时 Esc 交给上层（只关一层）");
});

test("buildComposerItems：分组、统一搜索、去重、空目标过滤", () => {
  const sources = {
    commands: [{ insert: "/compact ", label: "压缩上下文", hint: "保留摘要" }, { insert: "/new ", label: "新建会话", hint: "创建会话" }],
    files: ["报告.docx", "报告.docx", ""],
    skills: [{ name: "ppt-master", description: "做 PPT" }],
    plugins: [{ name: "mcp-files" }],
    sessions: [{ id: "s1", title: "上一轮汇报" }],
    agents: [{ name: "公文助手" }],
    knowledge: [{ kind: "knowledge", target: "规范.md", label: "规范" }],
    templates: [{ target: "模板.docx", label: "公文模板" }],
  };
  const actions = buildComposerItems({ ...sources, group: "action", query: "" });
  assert.equal(actions.length, 2);
  assert.ok(actions.every((item) => item.execute === "command" && item.command.startsWith("/")));
  const references = buildComposerItems({ ...sources, group: "reference", query: "" });
  const kinds = new Set(references.map((item) => item.kind));
  for (const kind of ["file", "knowledge", "template", "session", "agent"]) assert.ok(kinds.has(kind), `引用组缺少 ${kind}`);
  assert.equal(references.filter((item) => item.kind === "file").length, 1, "文件必须去重");
  assert.ok(!references.some((item) => !String(item.target || "").trim()), "空目标必须过滤");
  const skills = buildComposerItems({ ...sources, group: "skill", query: "" });
  assert.ok(skills.some((item) => item.kind === "skill"));
  assert.ok(skills.some((item) => item.kind === "plugin"));
  assert.ok(skills.some((item) => item.kind === "file"), "`#` 组保留文件候选");
  assert.equal(buildComposerItems({ ...sources, group: "reference", query: "ppt" }).length, 0, "搜索应同时过滤");
  assert.equal(buildComposerItems({ ...sources, group: "reference", query: "公文助手" }).length, 1);
});

console.log(failed ? "\n输入区引用契约测试：存在失败项" : "\n输入区引用契约测试：全部通过");
process.exit(failed ? 1 : 0);
