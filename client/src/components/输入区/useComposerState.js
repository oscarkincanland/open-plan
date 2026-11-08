/**
 * 输入区统一面板状态机（2026-11-08 D3，ADR-0029）。
 *
 * 单一面板：`/ @ # &` 任一符号只打开这一个面板，`menu = { group, query, start, activeIndex }`；
 * 符号只决定默认分组，Tab/←→ 切组，搜索对当前组过滤（query 来自 textarea 符号后的输入）。
 *
 * 本文件只放纯函数 + 一个轻量 hook，便于 `scripts/输入区引用契约测试.mjs` 直接 import 断言；
 * 组件拆分见 Composer.jsx / ComposerPanel.jsx。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { referenceMarker } from "../../引用标记.js";

/** 四组：动作 / 引用 / 技能与插件 / 会话（ADR-0029 §4.1）。 */
export const COMPOSER_GROUPS = Object.freeze([
  { id: "action", symbol: "/", label: "动作", hint: "命令选中即执行" },
  { id: "reference", symbol: "@", label: "引用", hint: "文件 / 知识库 / 模板 / 会话 / 智能体" },
  { id: "skill", symbol: "#", label: "技能与插件", hint: "技能 / 插件 / 文件" },
  { id: "session", symbol: "&", label: "会话", hint: "历史会话" },
]);

export const GROUP_BY_SYMBOL = Object.freeze({ "/": "action", "@": "reference", "#": "skill", "&": "session" });
const GROUP_IDS = COMPOSER_GROUPS.map((group) => group.id);

const MARKER_TYPES = "知识库目录|模板目录|知识库|模板|文件|技能|插件|会话|智能体";
const TRIGGER_RE = /(?:^|[\s(（])([/@&#])([^\s@#&]*)$/;
const MARKER_TAIL_RE = new RegExp(`^(?:${MARKER_TYPES})\\[`);
const COMPLETE_MARKER_RE = new RegExp(`^(?:${MARKER_TYPES})\\[[^\\]]*\\]$`);

/** 文件名（用于 chip 与候选标签）。 */
function baseName(value) {
  const text = String(value || "").trim();
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

/**
 * 从 textarea 文本 + 光标位置检测面板触发（行首或空白/左括号后的 `/ @ # &`）。
 * 返回 `{ symbol, group, query, start }`；不触发返回 null。
 */
export function detectComposerTrigger(text = "", caret = String(text || "").length) {
  const before = String(text || "").slice(0, caret);
  const match = before.match(TRIGGER_RE);
  if (!match) return null;
  const symbol = match[1];
  const query = match[2] || "";
  const start = before.length - query.length - 1;
  if (start < 0) return null;
  // `@@` 为转义（与提及逻辑一致）；`##`/`&&` 同理，避免正文误触发。
  if (start > 0 && before[start - 1] === symbol) return null;
  // 已输入完整标记（`@文件[abc]` / `@智能体[公文]`）或正在手写标记时不弹面板。
  if (MARKER_TAIL_RE.test(query) || COMPLETE_MARKER_RE.test(query)) return null;
  return { symbol, group: GROUP_BY_SYMBOL[symbol], query, start };
}

/** 把触发区间替换为选中项文本（真正的区间替换，不再“一律追加到末尾”）。 */
export function applyComposerPick(text = "", menu = null, insert = "") {
  const source = String(text || "");
  if (!menu || !insert) return source;
  const end = Math.min(source.length, menu.start + 1 + String(menu.query || "").length);
  const prefix = source.slice(0, menu.start);
  const suffix = source.slice(end);
  const joiner = suffix.startsWith(" ") ? "" : " ";
  return `${prefix}${insert}${joiner}${suffix}`;
}

function commandItems(commands = []) {
  return (Array.isArray(commands) ? commands : []).map((item) => ({
    id: `cmd:${item.insert}`,
    group: "action",
    kind: "command",
    command: String(item.insert || "").trim(),
    insert: item.insert,
    label: item.label || item.insert,
    hint: item.hint || "命令",
    execute: "command",
  }));
}

function fileItems(files = [], symbol = "@") {
  const seen = new Set();
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const target = String(file || "").trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push({
      id: `file:${target}`,
      group: symbol === "#" ? "skill" : "reference",
      kind: "file",
      target,
      insert: referenceMarker("file", target),
      label: baseName(target),
      hint: "工作区文件",
    });
  }
  return out;
}

/**
 * 按分组构造候选（统一搜索：label / target / hint / insert 同时匹配）。
 * @param {{group:string, query?:string, commands?:Array, files?:Array, skills?:Array,
 *   plugins?:Array, sessions?:Array, agents?:Array, knowledge?:Array, templates?:Array}} input
 */
export function buildComposerItems(input = {}) {
  const group = GROUP_BY_SYMBOL[input.group] ? input.group : (GROUP_IDS.includes(input.group) ? input.group : "reference");
  const keyword = normalizeText(input.query).trim();
  let items = [];
  if (group === "action") {
    items = commandItems(input.commands);
  } else if (group === "reference") {
    items = [
      ...fileItems(input.files, "@"),
      ...(Array.isArray(input.knowledge) ? input.knowledge : []).map((item) => ({
        id: `knowledge:${item.kind}:${item.target}`,
        group: "reference",
        kind: item.kind || "knowledge",
        target: item.target,
        insert: referenceMarker(item.kind || "knowledge", item.target),
        label: item.label || baseName(item.target),
        hint: item.kind === "knowledge_dir" ? "知识库目录" : "知识库文档",
      })),
      ...(Array.isArray(input.templates) ? input.templates : []).map((item) => ({
        id: `template:${item.target}`,
        group: "reference",
        kind: "template",
        target: item.target,
        insert: referenceMarker("template", item.target),
        label: item.label || baseName(item.target),
        hint: "模板",
      })),
      ...(Array.isArray(input.sessions) ? input.sessions : []).map((session) => ({
        id: `session:${session.id}`,
        group: "reference",
        kind: "session",
        target: String(session.id || ""),
        insert: referenceMarker("session", session.id),
        label: session.title || session.label || session.id || "未命名会话",
        hint: "历史会话",
      })),
      ...(Array.isArray(input.agents) ? input.agents : []).map((agent) => ({
        id: `agent:${agent.name}`,
        group: "reference",
        kind: "agent",
        target: String(agent.name || ""),
        insert: referenceMarker("agent", agent.name),
        label: agent.name,
        hint: "智能体 · 注入角色指令",
      })),
    ];
  } else if (group === "skill") {
    items = [
      ...(Array.isArray(input.skills) ? input.skills : []).map((skill) => ({
        id: `skill:${skill.name}`,
        group: "skill",
        kind: "skill",
        target: String(skill.name || ""),
        insert: referenceMarker("skill", skill.name),
        label: skill.name,
        hint: skill.description || "技能",
      })),
      ...(Array.isArray(input.plugins) ? input.plugins : []).map((plugin) => ({
        id: `plugin:${plugin.name}`,
        group: "skill",
        kind: "plugin",
        target: String(plugin.name || ""),
        insert: referenceMarker("plugin", plugin.name),
        label: plugin.name,
        hint: "MCP 插件",
      })),
      ...fileItems(input.files, "#"),
    ];
  } else {
    items = (Array.isArray(input.sessions) ? input.sessions : []).map((session) => ({
      id: `session:${session.id}`,
      group: "session",
      kind: "session",
      target: String(session.id || ""),
      insert: referenceMarker("session", session.id),
      label: session.title || session.label || session.id || "未命名会话",
      hint: "历史会话",
    }));
  }
  // 去重（同 kind + target 只留一条）并过滤空目标；命令项按命令文本去重。
  const seen = new Set();
  items = items.filter((item) => {
    if (item.kind === "command") {
      const key = `command:${item.command}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
    const target = String(item.target || "").trim();
    if (!target) return false;
    const key = `${item.kind}:${target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (keyword) {
    items = items.filter((item) => normalizeText([item.label, item.target, item.hint, item.insert].join(" ")).includes(keyword));
  }
  return items.slice(0, 24);
}

/**
 * 统一键盘分发（纯函数，便于测试）：
 *   - composition 期间全部放行（Enter/Tab/数字/Esc 不拦截，中文输入法不被抢键）；
 *   - 面板打开：↑↓ 选择、Tab/Shift+Tab 切组、Enter 选中、1–9 直选、Esc 只关面板；
 *   - 面板关闭：Enter 发送、Shift+Enter 换行、Esc 交给上层（只关一层）。
 */
export function resolveComposerKey({
  key = "",
  shiftKey = false,
  composition = false,
  menuOpen = false,
  itemCount = 0,
  activeIndex = 0,
} = {}) {
  if (composition) return { action: "pass", reason: "composition" };
  if (menuOpen) {
    if (key === "ArrowDown") return { action: "move", delta: 1 };
    if (key === "ArrowUp") return { action: "move", delta: -1 };
    if (key === "Tab") return { action: "switch-group", delta: shiftKey ? -1 : 1 };
    if (key === "Enter") return { action: "pick", index: itemCount ? Math.min(activeIndex, itemCount - 1) : 0 };
    if (key === "Escape") return { action: "close" };
    if (/^[1-9]$/.test(key) && Number(key) <= itemCount) return { action: "pick", index: Number(key) - 1 };
    return { action: "pass" };
  }
  if (key === "Enter" && !shiftKey) return { action: "send" };
  return { action: "pass" };
}

/**
 * 统一面板 hook（ChatPanel 调用；`enabled=false` 时恒为空，保证 flag 关闭 = 基线行为）。
 * 数据源由 ChatPanel 注入：命令 / 文件 / 技能 / 插件 / 会话 / 智能体 / 知识库 / 模板。
 */
export function useComposerState({
  enabled = false,
  commands = [],
  files = [],
  skills = [],
  plugins = [],
  sessions = [],
  agents = [],
  knowledge = [],
  templates = [],
} = {}) {
  const [menu, setMenu] = useState(null);
  const sources = { commands, files, skills, plugins, sessions, agents, knowledge, templates };
  const items = useMemo(
    () => (enabled && menu ? buildComposerItems({ ...sources, group: menu.group, query: menu.query }) : []),
    [enabled, menu, commands, files, skills, plugins, sessions, agents, knowledge, templates],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIndex = menu ? Math.min(menu.activeIndex, Math.max(0, items.length - 1)) : 0;

  // 候选变化时把高亮夹回有效范围。
  useEffect(() => {
    if (!menu) return;
    setMenu((current) => {
      if (!current) return current;
      const next = Math.min(current.activeIndex, Math.max(0, items.length - 1));
      return next === current.activeIndex ? current : { ...current, activeIndex: next };
    });
  }, [items.length, menu]);

  // 分组 tab 上的数量徽标（按当前 query 过滤后的条数）。
  const counts = useMemo(() => {
    if (!enabled || !menu) return {};
    return Object.fromEntries(COMPOSER_GROUPS.map((group) => [
      group.id,
      buildComposerItems({ ...sources, group: group.id, query: menu.query }).length,
    ]));
  }, [enabled, menu, commands, files, skills, plugins, sessions, agents, knowledge, templates]);

  const openFromText = useCallback((text, caret) => {
    if (!enabled) { setMenu(null); return null; }
    const trigger = detectComposerTrigger(text, caret);
    setMenu(trigger ? { ...trigger, activeIndex: 0 } : null);
    return trigger;
  }, [enabled]);
  const close = useCallback(() => setMenu(null), []);
  const switchGroup = useCallback((groupId) => {
    if (!GROUP_IDS.includes(groupId)) return;
    setMenu((current) => (current ? { ...current, group: groupId, activeIndex: 0 } : current));
  }, []);
  const switchGroupBy = useCallback((delta) => {
    setMenu((current) => {
      if (!current) return current;
      const index = GROUP_IDS.indexOf(current.group);
      const next = GROUP_IDS[(index + delta + GROUP_IDS.length) % GROUP_IDS.length];
      return { ...current, group: next, activeIndex: 0 };
    });
  }, []);
  const moveActive = useCallback((delta) => {
    setMenu((current) => {
      if (!current) return current;
      const count = itemsRef.current.length;
      if (!count) return current;
      return { ...current, activeIndex: (current.activeIndex + delta + count) % count };
    });
  }, []);
  const setActiveIndex = useCallback((index) => {
    setMenu((current) => (current ? { ...current, activeIndex: index } : current));
  }, []);
  const currentItem = useCallback((index = activeIndex) => itemsRef.current[index] || itemsRef.current[0] || null, [activeIndex]);

  return { menu, items, counts, activeIndex, openFromText, close, switchGroup, switchGroupBy, moveActive, setActiveIndex, currentItem };
}
