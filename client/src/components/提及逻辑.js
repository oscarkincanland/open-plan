// v0.13.7 `@` 智能体提及的纯逻辑（无 JSX，供组件与测试共用）：
// 与既有文件引用共存的约定——
//   * 文件引用使用 `@文件[…]`/`@知识库[…]` 等结构化标记（parseReferenceMarkers 解析）；
//   * 手打 `@`（且前面是行首或空白）触发提及菜单，选中后插入 `@智能体[名称]` 标记；
//   * `@@` 为转义：不触发菜单，发送时也不解析为提及。
export const MENTION_MARKER = "智能体";

// 从文本中检测提及触发状态：返回 { start, query } 或 null。
// start 是触发 `@` 的下标，query 是 @ 之后已输入的过滤词。
export function detectMentionTrigger(text = "", caret = text.length) {
  const before = String(text).slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (before[at - 1] === "@") return null; // @@ 转义
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && !/[\s(（]/.test(prev)) return null;
  const query = before.slice(at + 1);
  if (/[\s@]/.test(query)) return null; // 已空格分隔或又一个 @，不再视为过滤词
  if (query.startsWith(`${MENTION_MARKER}[`)) return null; // 已是完整标记，不再触发
  return { start: at, query };
}

// 按名称/描述过滤智能体；query 为空返回全部。
export function filterAgentsForMention(agents = [], query = "") {
  const keyword = String(query || "").trim().toLowerCase();
  const list = (Array.isArray(agents) ? agents : []).filter((item) => item?.id && item?.name);
  if (!keyword) return list;
  return list.filter((item) =>
    String(item.name || "").toLowerCase().includes(keyword)
    || String(item.description || "").toLowerCase().includes(keyword)
  );
}

// 从发送文本解析 `@智能体[名称]` 提及（`@@智能体[` 视为转义），并生成
// 注入到 prompt 前缀的角色指令段；找不到对应智能体时返回空串。
export function buildMentionPrefix(text = "", agents = []) {
  const source = String(text || "");
  const list = Array.isArray(agents) ? agents : [];
  const found = new Map();
  for (const match of source.matchAll(/(^|[^@])@智能体\[([^\]]+)\]/g)) {
    const name = String(match[2] || "").trim();
    if (!name || found.has(name)) continue;
    const agent = list.find((item) => item?.name === name);
    if (!agent) continue;
    found.set(name, agent);
  }
  if (!found.size) return "";
  return [...found.values()].map((agent) => {
    const skills = Array.isArray(agent.skills) && agent.skills.length ? `可用技能：${agent.skills.join("、")}\n` : "";
    return `[提及智能体: ${agent.name}]\n角色指令：${String(agent.prompt || "").trim()}\n${skills}`;
  }).join("\n") + "\n";
}
