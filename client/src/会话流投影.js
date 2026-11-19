/**
 * 会话流投影：消息块（blocks）+ 运行轨迹（reduceRunTrace 产物）→ 有序时间线。
 *
 * 落地文档：docs/plans/2026-10-31-001-会话流改版落地文档.md §5.1。
 * 归约原则：
 *   1. 以 blocks 顺序为主轴（保持模型真实输出顺序，避免时钟排序再次引入错位）；
 *   2. 工具块只透传（ToolCard 自渲染），运行轨迹只用来补「blocks 里缺失的工具调用」
 *      （start 事件被历史淘汰 / 重连丢失，轨迹里带 startMissing 标记的那批）；
 *   3. steer 进度播报与 [系统提醒] 归为 sys 行；artifacts/验收类事件不进时间流
 *      （它们由折叠头 chips 与产物卡承载，与 STAGE_ONLY_EVENTS 口径一致）。
 * 实时流与历史回放共用同一归约，保证两侧展示一致（与 运行轨迹.js 同一原则）。
 * 本模块必须保持纯函数、零 React 依赖，Node 测试可直接调用。
 */
import { toolIdentity } from "./事件展示.js";
import { formatDuration, runToolDetailText } from "./运行轨迹.js";
import { 计算展示字符数 } from "./components/流式文本队列.js";

/**
 * 打字机推进一帧（纯函数，Node 可测）：
 * 返回「本帧结束后应展示的字符数」——只前进不回退；关闭动效直接给全文。
 * 复用 流式文本队列.js 的计算展示字符数（90 字/秒、积压 0.24s 内自动追赶）。
 */
export function advanceTypewriter(fullText, shown, elapsedMs, reducedMotion) {
  const total = String(fullText || "").length;
  if (!total) return 0;
  const current = Math.max(0, Math.min(Number(shown) || 0, total));
  if (reducedMotion) return total;
  if (current >= total) return total;
  const next = 计算展示字符数({ remaining: total - current, elapsedMs, reducedMotion });
  return Math.min(total, current + Math.max(1, Number(next) || 0));
}

/** 工具行对象摘要：与 ToolCard 的输入提取同源（args 优先、常用字段次之），超长截断。 */
export function toolObjectText(name, input) {
  let text = typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
  try {
    if (input && typeof input === "object") {
      if (input.args != null) {
        text = typeof input.args === "string" ? input.args : JSON.stringify(input.args);
      }
      const preferred = input.path || input.file || input.file_path || input.pattern
        || input.command || input.query || input.question || input.task || input.url;
      if (preferred != null && typeof preferred !== "object") text = String(preferred);
    }
  } catch { /* 循环引用等异常时退回原始字符串化结果 */ }
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (/^(bash|officecli)$/.test(String(name || ""))) {
    return `$ ${flat.slice(0, 96)}${flat.length > 96 ? "…" : ""}`;
  }
  return flat.slice(0, 80) + (flat.length > 80 ? "…" : "");
}

/** 工具行状态：块未完结 = run；块/轨迹任一报错 = err；其余 ok。 */
export function toolStateOf(block, traceTool = null) {
  if (block?.done === false) return "run";
  if (block?.isError || traceTool?.isError) return "err";
  if (traceTool && traceTool.status !== "done" && !traceTool.startMissing) return "run";
  return "ok";
}

/**
 * 判断一段助手文本是「过程播报」还是「结构化结论」。
 *
 * 背景（2026-11-12）：运行结束后会把中间文本折进「执行过程」提升可读性，原实现只看
 * 「是不是终稿块」——只要模型在两次工具调用之间写了结构化小节（`##` 标题、表格、列表），
 * 而这些小节又不巧落在终稿块之前，就会被整段折进折叠区，用户看到的是「结构化回复被吞」。
 *
 * 规则：结构化内容一律不折叠（它是结论，不是进度）。判定从宽——只要出现标题、
 * 表格、列表、引用块，或正文足够长（多段论述），都按结论处理。
 * 只有「一句话过渡语 / 进度播报」才允许收进过程区。
 *
 * @param {string} text 助手文本块内容
 * @returns {boolean} true = 过程播报（可折叠）；false = 结构化结论（必须留在正文）
 */
export function isNarrationText(text = "") {
  const source = String(text || "").trim();
  if (!source) return true;
  // 结构化标记：ATX 标题、表格行、无序/有序列表、引用块、代码块、分隔线。
  if (/^#{1,6}[ \t]+\S/m.test(source)) return false;
  if (/^[ \t]*\|.*\|[ \t]*$/m.test(source)) return false;
  if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/m.test(source)) return false;
  if (/^[ \t]*>[ \t]?\S/m.test(source)) return false;
  if (/^[ \t]*```/m.test(source)) return false;
  if (/^[ \t]*(?:---+|\*\*\*+)[ \t]*$/m.test(source)) return false;
  // 多段论述（≥2 个非空行且总长超过 200 字）也按结论处理，避免整段论述被折叠。
  const lines = source.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length >= 2 && source.length > 200) return false;
  // 单个长段落（>240 字）同样视为实质回答。
  if (source.length > 240) return false;
  return true;
}

/** 时间流里的「过程条目」：有这些条目夹在中间时，前面的文本一定不是收尾结论。 */
const PROCESS_ITEM_KINDS = new Set(["tool", "subagent", "pipeline"]);

/**
 * 时间流二分：过程条目（fold，收进「执行过程」折叠体）与收尾结论小节（lift，折叠体外）。
 *
 * 背景（2026-11-15-002，用户反馈「思考过程被渲染到下面」）：
 *   2026-11-12 为了让「收尾的结构化结论」不被折进过程，把**所有**非播报文本都外提，
 *   再统一追加到消息末尾。但模型在回合中段写的长进度文本同样会被 `isNarrationText`
 *   判为结构化结论（≥2 行且 >200 字 / >240 字即命中），结果这些过程文本被搬到消息
 *   最底部——运行中尤其明显（刚写出就沉底），时间顺序也丢了。
 *
 * 现在的规则：
 *   - 运行中（live）：整条时间流按原顺序直铺，不外提任何条目；
 *   - 收尾后：只有位于**最后一次过程条目之后**、且被判为结构化结论的文本才外提；
 *     中段结构化文本仍属过程，留在 fold 原位随过程折叠。
 *
 * @param {Array<object>} items buildRunTimeline / assignTimelineTurns 产物
 * @param {{ live?: boolean }} [options] live=true 表示这一轮仍在运行
 * @returns {{ foldTimelineItems: Array<object>, liftedTimelineItems: Array<object> }}
 */
export function splitRunTimelineSections(items = [], { live = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  // 运行中直铺：任何外提都会让新写出的过程文本立刻跳到消息底部。
  if (live) return { foldTimelineItems: list.slice(), liftedTimelineItems: [] };
  let lastProcessIndex = -1;
  list.forEach((item, index) => {
    if (PROCESS_ITEM_KINDS.has(item?.kind)) lastProcessIndex = index;
  });
  // 只有「最后一段非旁白文本」才允许外提：模型在终稿前写的结构化小结若也外提，
  // 折叠体外会同时出现两段结论（2026-11-18 复现：tool + 中间小结 + 终稿 → lifted 两段）。
  let lastConclusionIndex = -1;
  list.forEach((item, index) => {
    if (item?.kind === "text" && !isNarrationText(item.text)) lastConclusionIndex = index;
  });
  const foldTimelineItems = [];
  const liftedTimelineItems = [];
  list.forEach((item, index) => {
    const isConclusionSection = item?.kind === "text"
      && index === lastConclusionIndex
      && index > lastProcessIndex;
    (isConclusionSection ? liftedTimelineItems : foldTimelineItems).push(item);
  });
  return { foldTimelineItems, liftedTimelineItems };
}

/**
 * 把运行轨迹里的工具结果合并回消息块。
 *
 * 为什么要合并：历史恢复时消息块可能拿不到结果（toolResult 消息缺失或被窗口截断），
 * 此时块会永远停在 done=false / 空结果，界面上表现为「工具一直转圈、展开没有内容」。
 * 轨迹（reduceRunTrace 的产物）带 tool_end 的结果，可以补齐这一段。
 *
 * 合并规则（只在块缺结果时补，不覆盖块自己的内容）：
 *   - output / result：块为空才取轨迹值；
 *   - done：块未完结且轨迹已完结时置为 true；
 *   - isError / duration：块缺值时取轨迹值。
 */
export function mergeTraceTool(block, traceTool) {
  if (!block || !traceTool) return block;
  const output = String(block.output || "");
  const result = String(block.result || "");
  const traceOutput = String(traceTool.output || "");
  const traceResult = String(traceTool.result || "");
  const nextOutput = output || traceOutput;
  const nextResult = result || traceResult;
  const traceDone = traceTool.status === "done";
  const nextDone = block.done === true ? true : (traceDone && (nextOutput || nextResult) ? true : block.done);
  const nextIsError = block.isError === true ? true : (traceTool.isError ? true : block.isError);
  const nextDuration = Number.isFinite(block.duration) ? block.duration : (traceTool.duration ?? block.duration);
  if (
    nextOutput === output
    && nextResult === result
    && nextDone === block.done
    && nextIsError === block.isError
    && nextDuration === block.duration
  ) return block;
  return {
    ...block,
    output: nextOutput,
    result: nextResult,
    done: nextDone,
    isError: nextIsError,
    duration: nextDuration,
  };
}

function traceToolIndex(trace) {
  const byId = new Map();
  const byName = [];
  for (const tool of Array.isArray(trace?.tools) ? trace.tools : []) {
    if (tool.toolCallId) byId.set(String(tool.toolCallId), tool);
    else byName.push(tool);
  }
  return { byId, byName, used: new Set() };
}

/**
 * 找到块对应的轨迹工具：
 *   1. 有 id 且轨迹里有同 id → 直接命中；
 *   2. 否则按名字匹配尚未被占用的轨迹工具（块与轨迹都是时间序，取最早未占用的一条），
 *      避免两个同名工具被合并到同一条轨迹上。
 */
function findTraceTool(index, block) {
  const id = String(block?.toolCallId || block?.id || "");
  if (id && index.byId.has(id)) {
    const hit = index.byId.get(id);
    index.used.add(hit);
    return hit;
  }
  if (block?.name) {
    for (let i = 0; i < index.byName.length; i += 1) {
      const candidate = index.byName[i];
      if (index.used.has(candidate)) continue;
      if (candidate.name !== block.name) continue;
      index.used.add(candidate);
      return candidate;
    }
  }
  return null;
}

function sysTextOf(note) {
  return String(note || "").replace(/^\s*\[系统提醒\]\s*/, "").trim();
}

/**
 * blocks + 运行轨迹 → TimelineItem[]。
 * @param {object} input
 * @param {Array} input.blocks 消息块（assistant 消息的 blocks，顺序即模型输出顺序）
 * @param {object|null} input.trace reduceRunTrace(events) 的产物；缺省时不补缺失工具
 * @returns {Array<{kind:string, id:string, icon?:string, verb?:string, obj?:string,
 *   timeText?:string, state?:string, text?:string, cap?:string, block?:object, detail?:string}>}
 */
export function buildRunTimeline({ blocks = [], trace = null } = {}) {
  const items = [];
  const seenToolKeys = new Set();
  const index = traceToolIndex(trace);
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || block.type === "message_boundary") continue;
    const id = String(block.id || block.toolCallId || `${block.type}:${items.length}`);
    switch (block.type) {
      case "thinking": {
        // 兼容 Pi 的 thinking 字段与旧前端写入的 text 字段；空思考块不渲染
        // （历史里存在只有签名的空 thinking 块，展开后会是空白行）。
        const text = String(block.text || block.thinking || "");
        if (!text.trim()) break;
        items.push({
          kind: "thinking", id, icon: "brain", verb: "思考", obj: "内部推理",
          timeText: `${text.length.toLocaleString()} 字`, state: "ok", text,
        });
        break;
      }
      case "text": {
        // 模型正文中间态是进度，不是成果；只有 assistant_final 才进入“结论”区。
        // 空白正文（换行/缩进/零宽字符）不产生条目：它会渲染成一个只有 padding 的
        // 空 .textblock，在工具卡与下一行之间撑出看不见的空白（2026-11-07 实测）。
        const text = String(block.text || "");
        if (!text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()) break;
        items.push({ kind: "text", id, cap: "阶段小结", text });
        break;
      }
      case "tool": {
        // 轨迹里同名/同 id 的工具结果合并回块：历史恢复时块可能没拿到结果。
        const traceTool = findTraceTool(index, block);
        const merged = mergeTraceTool(block, traceTool);
        seenToolKeys.add(String(block.toolCallId || block.id || `byname:${block.name}`));
        items.push({ kind: "tool", id, icon: toolIdentity(block.name).icon, block: merged });
        break;
      }
      case "subagent":
        items.push({ kind: "subagent", id, icon: "flow", block });
        break;
      case "pipeline":
        items.push({ kind: "pipeline", id, icon: "flow", block });
        break;
      case "ask":
        items.push({ kind: "ask", id, icon: "comment", block });
        break;
      case "approval":
        items.push({ kind: "approval", id, icon: "shield", block });
        break;
      case "process_note": {
        const text = sysTextOf(block.text);
        if (text) items.push({ kind: "sys", id, icon: "info", verb: "系统提醒", obj: text.slice(0, 60), state: "ok", text });
        break;
      }
      case "browser-steps": {
        // 浏览器任务时间线：steps 由 ChatPanel 的 reduceBrowserSteps 按 toolCallId 归并。
        // 空块不产生条目；卡片标题不带步数（全局不要摘要）。
        const steps = Array.isArray(block.steps) ? block.steps : [];
        if (steps.length) items.push({ kind: "browser-steps", id, icon: "globe", block });
        break;
      }
      default:
        break;
    }
  }
  // 补缺失工具：轨迹里有、blocks 里没有（start 事件被历史淘汰 / 重连丢失）。
  // 插入锚点 = 最后一个工具项之后，保持「工具都发生在过程流里」的直觉顺序。
  const missing = [];
  for (const tool of Array.isArray(trace?.tools) ? trace.tools : []) {
    const key = String(tool.toolCallId || `byname:${tool.name}`);
    if (seenToolKeys.has(key)) continue;
    // 已被合并进某个块的轨迹工具不再补插，否则同一次调用会出现两行。
    if (index.used.has(tool)) continue;
    // 无 id 的轨迹工具按「同名块已存在」去重，避免同一调用出现两行。
    if (!tool.toolCallId && Array.isArray(blocks) && blocks.some((b) => b?.type === "tool" && b?.name === tool.name)) continue;
    missing.push(tool);
  }
  if (missing.length) {
    const lastToolIdx = items.reduce((last, item, i) => (item.kind === "tool" ? i : last), -1);
    const synthesized = missing.map((tool, i) => ({
      kind: "tool",
      id: `trace-${tool.toolCallId || `${tool.name}:${i}`}`,
      icon: toolIdentity(tool.name).icon,
      block: {
        id: `trace-${tool.toolCallId || `${tool.name}:${i}`}`,
        name: tool.name,
        input: tool.input || "",
        output: tool.output || tool.result || "",
        done: tool.status === "done",
        isError: !!tool.isError,
        duration: tool.duration ?? null,
        startMissing: !!tool.startMissing,
      },
    }));
    items.splice(lastToolIdx + 1, 0, ...synthesized);
  }
  return items;
}

/** 时间线统计：工具数（供折叠头 chips），执行中工具行（供运行中动作文案）。 */
export function summarizeTimeline(items = []) {
  const list = Array.isArray(items) ? items : [];
  const tools = list.filter((item) => item.kind === "tool");
  const runningTool = [...tools].reverse().find((item) => toolStateOf(item.block) === "run");
  return {
    toolCount: tools.length,
    runningLabel: runningTool
      ? [runningTool.block?.name, toolObjectText(runningTool.block?.name, runningTool.block?.input)].filter(Boolean).join(" ")
      : "",
  };
}

/**
 * 过程按 turn 分组（PRD R3 / DESIGN §6.1「过程展开内容按 turn 分组」，决策 B1）。
 *
 * 为什么在归约层做：时间流条目来自消息块（只有顺序，没有轮次），轮次只有事件流知道
 * （`turn_started` 自增、`tool_start` 带 toolCallId）。这里用 toolCallId 把工具行
 * 归到轮次，其余条目按"同一轮的过程出现在本轮工具之前"的顺序假设向前/向后归并，
 * 纯函数、可单测，不引入新的状态。
 *
 * @param {Array} items buildRunTimeline 的产物
 * @param {Array} events 本轮事件（含 turn_started / tool_start）
 * @returns {Array} 每个条目带 `turn`，并在轮次变化处插入 `kind:"turn-divider"`；
 *                  无轮次信息（单轮 / 旧服务端）时原样返回，不插入分隔行。
 */
export function assignTimelineTurns(items = [], events = []) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const turnByTool = new Map();
  let turn = 0;
  let sawTurnStarted = false;
  for (const event of Array.isArray(events) ? events : []) {
    const type = String(event?.type || "");
    if (type === "turn_started") {
      turn += 1;
      sawTurnStarted = true;
      continue;
    }
    if (type === "tool_start") {
      const id = String(event?.data?.toolCallId || "");
      if (id) turnByTool.set(id, Math.max(1, turn));
    }
  }
  // 单轮或无轮次信息：不分组（保持既有「一条直铺时间流」的形态）。
  if (!sawTurnStarted || turn < 2 || !turnByTool.size) return list;

  const assigned = list.map((item) => {
    if (item?.kind !== "tool") return { item, turn: null };
    const id = String(item.block?.toolCallId || item.block?.id || "");
    const turnIndex = id ? turnByTool.get(id) : null;
    return { item, turn: Number.isFinite(turnIndex) ? turnIndex : null };
  });

  // 向后找：思考 / 文本 / 子代理通常出现在本轮工具调用之前，归到下一个已知轮次。
  for (let i = assigned.length - 1; i >= 0; i -= 1) {
    if (assigned[i].turn) continue;
    for (let j = i + 1; j < assigned.length; j += 1) {
      if (assigned[j].turn) { assigned[i].turn = assigned[j].turn; break; }
    }
  }
  // 仍未归属（落在最后一个已知工具之后）：沿用前一个轮次。
  let lastTurn = null;
  for (const entry of assigned) {
    if (entry.turn) lastTurn = entry.turn;
    else if (lastTurn) entry.turn = lastTurn;
  }

  const out = [];
  let currentTurn = null;
  for (const entry of assigned) {
    if (entry.turn && entry.turn !== currentTurn) {
      currentTurn = entry.turn;
      out.push({ kind: "turn-divider", id: `turn-divider-${entry.turn}`, turn: entry.turn });
    }
    out.push(entry.item);
  }
  return out;
}

/**
 * 折叠头呈述（会话流前端规范 §2.1 + ADR 0014）：把一轮 Run 的终态映射成状态点与一句文案。
 * 只做纯映射，不读时间、无副作用，Node 可直接单测。步数不进 label ——
 * 它由 RunFoldBar 单独渲染（字号与颜色比用时更弱）。
 *
 * @param {{ interrupted?: boolean, failed?: boolean, risky?: boolean, elapsedMs?: number }} input
 * @returns {{ state: "ok"|"warn"|"err"|"cancelled", label: string }}
 */
export function describeRunFold({ interrupted = false, failed = false, risky = false, elapsedMs = 0 } = {}) {
  const state = interrupted ? "cancelled" : failed ? "err" : risky ? "warn" : "ok";
  const headText = { ok: "已完成", warn: "完成（有风险）", err: "失败", cancelled: "已取消" }[state];
  const ms = Number(elapsedMs) > 0 ? Number(elapsedMs) : 0;
  return { state, label: ms > 0 ? `${headText} · 用时 ${formatDuration(ms)}` : headText };
}

/**
 * 结论文本 → { what, conclusion, detail }。
 *  - 来源：Run 完成摘要（source:"inferred"，取模型最终答复）或历史会话的显式声明；
 *  - conclusion：**只**取标题以「结论」开头的分节首段；无该分节时为空串；
 *  - what：取「做了什么/完成工作/工作内容」分节（R-C 落地前可能缺失，缺失即空串不渲染）；
 *  - detail：完整 Markdown（结论节并入 conclusion 时从 detail 中移除，避免重复）。
 * 不编造内容：summary 与 finalText 都为空时三个字段均为空串。
 *
 * 2026-11-10（计划 007 块 A）：此前「有分节但没有结论节」时会把**首个分节首段**提升为
 * conclusion，渲染层又按「结论 + detail」拼接，导致首段被搬到开场白和 `##` 标题之前
 * （实测：`## “没更新”最可能的原因` 被拖到「一是…」之后，读者以为标题坏了）。
 * 现在只有显式「结论」节才提升，其余情况 detail 保持模型终稿的原始顺序；
 * 唯一例外是无任何标题的纯文本，仍按「首段是结语」的旧行为处理（顺序不变）。
 */
export function splitCompletionSummary(summary = "", finalText = "") {
  const source = String(summary || "").trim() || String(finalText || "").trim();
  if (!source) return { what: "", conclusion: "", detail: "" };
  const lines = source.split(/\r?\n/);
  const sections = [{ title: "", lines: [] }];
  for (const line of lines) {
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading) sections.push({ title: heading[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  const bodyOf = (section) => section.lines.join("\n").trim();
  const titled = sections.filter((section) => section.title);
  const conclusionSection = titled.find((section) => /^结论/.test(section.title)) || null;
  const whatSection = titled.find((section) => /^(做了什么|完成工作|工作内容)/.test(section.title)) || null;
  let conclusion = "";
  let detail = source;
  // 被单独展示的分节（结论 → 大字、做了什么 → what 行）从 detail 中移除，避免同一段文字出现两次。
  // 2026-11-10（计划 007）：原正则 `^#{1,3}` 的 `^` 只在文首成立，分节不在开头时整段匹配失败，
  // 于是「结论/做了什么」会在 detail 里重复渲染（新回归测试捕获）。这里改为“行首或换行”起点。
  const removeSection = (section) => {
    if (!section) return;
    const title = section.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\n)#{1,3}\\s+${title}[\\s\\S]*?(?=\\n#{1,3}\\s|$)`);
    detail = detail.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
  };
  if (conclusionSection) {
    // 只把「结论」节的首段提到结论位；其余段落必须留在详细内容里。
    // 此前是 firstParagraph + 整节 removeSection，会让多段结论的第 2 段起从页面消失。
    const body = bodyOf(conclusionSection);
    const paragraphs = body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    conclusion = paragraphs[0] || body.slice(0, 200);
    if (paragraphs.length <= 1) {
      // 单段结论：整节移除，避免「## 结论 + 同一段」重复展示。
      removeSection(conclusionSection);
    } else {
      // 多段结论：只移除首段文本，节标题与后续段落保留在详细内容中。
      detail = detail.replace(conclusion, "").replace(/\n{3,}/g, "\n\n").trim();
    }
  } else if (!titled.length) {
    const paragraphs = source.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    conclusion = paragraphs[0] || source.slice(0, 200);
    // 单段结语已被结论完整展示，详细展开保持为空，避免同一段文字出现两次。
    detail = paragraphs.slice(1).join("\n\n").trim();
  }
  // 有分节但没有「结论」节：不提升任何段落为结论，detail 原样保留模型顺序。
  // （旧实现会把首个分节首段搬到最前面，见本函数顶部说明。）
  //
  // 2026-11-12（用户第二次报「结构化回复被吞」）：这里**不再**把「做了什么」节从 detail 移除。
  // 旧实现 `removeSection(whatSection)` 把它从 detail 删掉，而唯一渲染出口
  // （ChatPanel 的 summaryBody = conclusion + detail）从不使用 what 字段——
  // 结果是模型写的整个「## 做了什么」小节在界面上彻底消失，属于内容丢失而非折叠。
  // 现在该节留在 detail 原位置，what 仍返回给需要摘要行的调用方（同一内容两处不会重复渲染，
  // 因为渲染层只用 conclusion + detail）。
  const what = whatSection ? bodyOf(whatSection) : "";
  return { what, conclusion, detail };
}
