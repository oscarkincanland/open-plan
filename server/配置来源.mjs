/**
 * 配置来源与资源发现（H3-4）
 *
 * 目标：把“同名配置/资源到底用了哪一份”变成可解释、可测试的事实。
 * 本模块只提供纯函数与顺序定义；具体读取由调用方注入，避免改变既有默认行为。
 */

export const CONFIG_PRIORITY = Object.freeze([
  { source: "cli", rank: 50, label: "命令行显式参数" },
  { source: "env", rank: 40, label: "环境变量" },
  { source: "session", rank: 30, label: "会话/任务设置" },
  { source: "project", rank: 20, label: "工作区配置" },
  { source: "user", rank: 10, label: "用户配置" },
  { source: "default", rank: 0, label: "代码默认值" },
]);

const RANK = new Map(CONFIG_PRIORITY.map((item) => [item.source, item.rank]));

/**
 * 按优先级取第一个“已定义”的值。
 * @param {{name:string, sources:Record<string, any>}} input
 * @returns {{name:string, value:any, source:string|null, considered:string[]}}
 */
export function resolveConfigValue({ name = "", sources = {} } = {}) {
  const considered = [];
  const entries = Object.entries(sources || {})
    .filter(([source]) => RANK.has(source))
    .sort((a, b) => (RANK.get(b[0]) || 0) - (RANK.get(a[0]) || 0));
  for (const [source, value] of entries) {
    considered.push(source);
    if (value !== undefined && value !== null) {
      return { name: String(name), value, source, considered };
    }
  }
  return { name: String(name), value: undefined, source: null, considered };
}

/**
 * 资源发现顺序：显式 roots > 用户目录 > 工作区目录 > 额外目录。
 * 同名资源先到先得；调用方负责实际存在性判断。
 * @param {{explicit?:string[], user?:string[], workspace?:string[], extra?:string[]}} input
 * @returns {Array<{path:string, source:string, rank:number}>}
 */
export function discoverResources({ explicit = [], user = [], workspace = [], extra = [] } = {}) {
  const groups = [
    { source: "cli", rank: 50, paths: explicit },
    { source: "user", rank: 40, paths: user },
    { source: "project", rank: 30, paths: workspace },
    { source: "default", rank: 10, paths: extra },
  ];
  const seen = new Set();
  const out = [];
  for (const group of groups.sort((a, b) => b.rank - a.rank)) {
    for (const item of Array.isArray(group.paths) ? group.paths : []) {
      const value = String(item || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({ path: value, source: group.source, rank: group.rank });
    }
  }
  return out;
}

/** 按名字去重：先到先得，并返回冲突列表。 */
export function pickFirstByName(items = [], { nameOf = (item) => item?.name } = {}) {
  const chosen = new Map();
  const conflicts = [];
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(nameOf(item) || "").trim();
    if (!name) continue;
    if (chosen.has(name)) {
      conflicts.push({ name, kept: chosen.get(name), ignored: item });
      continue;
    }
    chosen.set(name, item);
  }
  return { chosen: [...chosen.values()], conflicts };
}

export function describeConfigPriority() {
  return CONFIG_PRIORITY.map((item) => `${item.rank} ${item.source}（${item.label}）`).reverse();
}

export function sourceRank(source) {
  return RANK.get(String(source || "")) ?? -1;
}
