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
 *  - conclusion：优先取「结论」分节首段；无标题结构时取全文首段；
 *  - what：取「做了什么/完成工作/工作内容」分节（R-C 落地前可能缺失，缺失即空串不渲染）；
 *  - detail：完整 Markdown（结论分节已并入 conclusion 时从 detail 中移除，避免重复）。
 * 不编造内容：summary 与 finalText 都为空时三个字段均为空串。
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
  const firstParagraph = (text) => text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)[0] || "";
  const titled = sections.filter((section) => section.title);
  const conclusionSection = titled.find((section) => /^结论/.test(section.title)) || null;
  const whatSection = titled.find((section) => /^(做了什么|完成工作|工作内容)/.test(section.title)) || null;
  let conclusion = "";
  let detail = source;
  // 被单独展示的分节（结论 → 大字、做了什么 → what 行）从 detail 中移除，避免同一段文字出现两次。
  const removeSection = (section) => {
    if (!section) return;
    const pattern = new RegExp(`^#{1,3}\\s+${section.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=\\n#{1,3}\\s|$)`);
    detail = detail.replace(pattern, "").trim();
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
  } else {
    // 有分节但没有「结论」：结论取首个分节首段，detail 保留全文。
    conclusion = firstParagraph(bodyOf(titled[0])) || source.slice(0, 200);
    // 该段已作为结论展示，从详细展开中移除首次出现，避免重复。
    if (conclusion) detail = detail.replace(conclusion, "").trim();
  }
  removeSection(whatSection);
  const what = whatSection ? bodyOf(whatSection) : "";
  return { what, conclusion, detail };
}
