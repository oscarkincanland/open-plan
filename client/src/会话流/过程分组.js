/**
 * 过程分组与组头摘要（计划 2026-11-14-001 阶段 5 / 对标 DSH `process-groups.ts` + `process-activity.ts`）。
 *
 * 纯函数、零 React 依赖，Node 测试可直接调用：
 *   - `toolCategory(name)`：按 DSH 的精确名称表分类，不做大小写/命名空间猜测；
 *   - `buildProcessSegments(items)`：把时间流切成「组」与「独立条目」，组内按成员统计类别与次数；
 *   - `groupLabel(group)`：运行中取实时活动，已结束按"次数降序、次数相同按首次出现"组合文案。
 *
 * 分组边界（与 DSH 一致）：
 *   - 一条有可见正文的 Assistant 回复结束当前组（回复本身独立显示）；
 *   - 轮次分隔、未决 ask/审批等交互节点结束当前组；
 *   - 工具类别变化**不**拆组；思考不计数，只作为实时活动兜底。
 */

/** 工具名 → 类别（顺序即匹配优先级，先命中先用）。 */
const CATEGORY_RULES = Object.freeze([
  ["read", (name) => name === "read"],
  ["readImage", (name) => name === "read_image"],
  ["search", (name) => name === "grep" || name === "glob" || name.endsWith("_inspect")],
  ["write", (name) => name === "write"],
  ["edit", (name) => name === "edit" || name === "apply_patch"],
  ["commands", (name) => ["bash", "pwsh", "exec_command", "write_stdin"].includes(name) || name.startsWith("terminal_")],
  ["code", (name) => name === "run_code"],
  ["webSearch", (name) => name === "web_search"],
  ["webFetch", (name) => name === "web_fetch"],
  ["subagents", (name) => name === "subagent" || name.startsWith("subagent_")],
  ["plan", (name) => ["todo_write", "create_goal", "update_goal", "get_goal"].includes(name)],
  ["questions", (name) => ["ask_user_question", "request_user_input"].includes(name)],
]);

/** 类别 → 运行中文案。 */
const RUNNING_LABELS = Object.freeze({
  read: "正在读取文件",
  readImage: "正在读取图片",
  search: "正在搜索代码",
  write: "正在写入文件",
  edit: "正在编辑文件",
  commands: "正在运行命令",
  code: "正在运行代码",
  webSearch: "正在搜索网页",
  webFetch: "正在访问网页",
  subagents: "正在协调子代理",
  plan: "正在更新计划",
  questions: "等待你的操作",
  tools: "正在调用工具",
});

/** 类别 → 完成文案（DSH 原文案）。 */
const DONE_LABELS = Object.freeze({
  read: "已读取文件",
  readImage: "已读取图片",
  search: "已搜索代码",
  write: "已写入文件",
  edit: "修改了文件",
  commands: "执行了命令",
  code: "运行了代码",
  webSearch: "已搜索网页",
  webFetch: "已访问网页",
  subagents: "已协调子代理",
  plan: "更新了计划",
  questions: "向用户提出了问题",
  tools: "已调用工具",
});

/** 结束当前组的条目类型：Assistant 回复、轮次分隔、交互块。 */
const BOUNDARY_KINDS = new Set(["text", "turn-divider", "ask", "approval"]);
/** 不进入分组、也不截断组的类型（隐藏内容 / 权限命令）。 */
const SKIP_KINDS = new Set(["permission"]);

/** 把工具名归到类别；无法识别一律 `tools`。 */
export function toolCategory(name) {
  const value = String(name || "").trim();
  if (!value) return "tools";
  for (const [category, match] of CATEGORY_RULES) {
    if (match(value)) return category;
  }
  return "tools";
}

/** 该条目是否属于"过程"（可以进组）。 */
export function isProcessItem(item) {
  if (!item || !item.kind) return false;
  if (SKIP_KINDS.has(item.kind)) return false;
  return !BOUNDARY_KINDS.has(item.kind);
}

/** 组内成员的工具调用名（工具块才有）。 */
function toolNameOf(item) {
  if (item?.kind !== "tool") return "";
  return String(item.block?.name || "");
}

/** 组内成员的调用 id（用于去重，重复 callId 只计一次）。 */
function callIdOf(item, index) {
  if (item?.kind !== "tool") return "";
  return String(item.block?.toolCallId || item.block?.id || item.id || `idx:${index}`);
}

/** 组成员状态是否仍在运行。 */
function isRunningItem(item) {
  if (item?.kind === "tool") {
    const block = item.block || {};
    return block.done === false || item.state === "run";
  }
  return item?.state === "run";
}

/**
 * 组内实时活动：最近一条仍在运行的工具；没有则回退到最近一条有正文的思考。
 * 思考节点在投影里 state 恒为 ok（不是工具那种 run 状态），因此这里不能复用
 * `isRunningItem` 判断，只看"是否有非空文本"。
 */
function liveActivity(members) {
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const item = members[i];
    if (item?.kind === "tool" && isRunningItem(item)) {
      return { category: toolCategory(toolNameOf(item)), item };
    }
  }
  for (let i = members.length - 1; i >= 0; i -= 1) {
    const item = members[i];
    if (item?.kind === "thinking" && String(item.text || "").trim()) {
      return { category: "", item, text: item.text };
    }
  }
  return null;
}

/** 详情文本：工具参数优先字段（简化版，与 DSH 的 field 优先级同源）。 */
export function itemDetail(item) {
  const input = item?.block?.input;
  if (input == null) return "";
  let source = input;
  if (typeof input === "string" && /^\s*\{/.test(input)) {
    try { source = JSON.parse(input); } catch { source = input; }
  }
  if (typeof source === "string") return source.replace(/\s+/g, " ").trim().slice(0, 60);
  if (typeof source !== "object") return "";
  const fields = ["title", "description", "objective", "task", "task_name", "name", "question",
    "prompt", "message", "command", "cmd", "queries", "query", "pattern", "url", "uri", "file_path", "path", "target"];
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 60);
    if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string")) {
      return value.join(", ").slice(0, 60);
    }
  }
  return "";
}

/** 统计组成员：类别次数（重复 callId 只计一次）。 */
export function countCategories(members = []) {
  const seen = new Set();
  const counts = new Map();
  members.forEach((item, index) => {
    if (item?.kind !== "tool") return;
    const id = callIdOf(item, index);
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    const category = toolCategory(toolNameOf(item));
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  return counts;
}

/**
 * 组头文案。
 * - 运行中：`正在{活动}`（工具类别优先，无运行工具时回退思考，仍无则"正在分析请求"）；
 * - 已结束：按次数降序、同数按首次出现顺序组合；1 项直出，2 项用「并」，3 项用「，」，超 3 项取前三 + 「等」。
 */
export function groupLabel({ members = [], running = false, counts = null } = {}) {
  const categoryCounts = counts || countCategories(members);
  const ordered = [...categoryCounts.entries()]
    .map(([category, count], index) => ({ category, count, index }))
    .sort((a, b) => (b.count - a.count) || (a.index - b.index))
    .map((entry) => entry.category);

  if (running) {
    const live = liveActivity(members);
    if (live?.category) {
      const detail = itemDetail(live.item);
      return detail ? `${RUNNING_LABELS[live.category]} · ${detail}` : RUNNING_LABELS[live.category];
    }
    if (live?.text) {
      const firstLine = String(live.text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      if (firstLine) return `正在分析请求 · ${firstLine.slice(0, 40)}`;
    }
    return "正在分析请求";
  }

  if (!ordered.length) return "已完成分析";
  const labels = ordered.map((category) => DONE_LABELS[category] || DONE_LABELS.tools);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) {
    const [first, second] = labels;
    const joinable = first.startsWith("已") && second.startsWith("已");
    return joinable ? `${first}并${second.slice(1)}` : `${first}，${second}`;
  }
  if (labels.length === 3) return labels.join("，");
  return `${labels.slice(0, 3).join("，")}等`;
}

/**
 * 时间流 → 渲染片段。
 *
 * @param {Array} items assignTimelineTurns 的产物
 * @param {{running?:boolean}} [options] 本轮是否仍在运行（决定运行中文案与默认展开）
 * @returns {Array<{type:"group", id:string, members:Array, counts:Map, label:string, running:boolean}
 *               | {type:"item", item:object}>}
 */
export function buildProcessSegments(items = [], { running = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const segments = [];
  let current = null;

  const flush = () => {
    if (!current || !current.members.length) { current = null; return; }
    const counts = countCategories(current.members);
    segments.push({
      type: "group",
      id: `group:${current.members[0]?.id || segments.length}`,
      members: current.members,
      counts,
      label: groupLabel({ members: current.members, running, counts }),
      running,
    });
    current = null;
  };

  for (const item of list) {
    if (!item) continue;
    if (SKIP_KINDS.has(item.kind)) continue;
    if (isProcessItem(item)) {
      if (!current) current = { members: [] };
      current.members.push(item);
      continue;
    }
    // 边界条目：先收口当前组，再独立输出
    flush();
    segments.push({ type: "item", item });
  }
  flush();
  return segments;
}

/** 组字数：给组头 meta（"4 次"）用；无工具时返回 0。 */
export function groupCallCount(counts) {
  if (!counts || typeof counts.values !== "function") return 0;
  let total = 0;
  for (const value of counts.values()) total += Number(value) || 0;
  return total;
}
