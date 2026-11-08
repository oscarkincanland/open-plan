/**
 * 技能检索别名表（2026-11-08，D0-2）
 *
 * 目的：让中文/英文自然语言查询能命中技能名与描述，替代原来的“空格 AND 词面匹配”。
 * 纯数据 + 纯函数，不依赖网络、不做分词服务；覆盖办公/写作/图表/审查/研究/设计等高频场景。
 *
 * 设计约束：
 *   - 只做“有限别名扩展”：查询词命中别名组任一词时，扩展到整组参与匹配；
 *   - 不做同义词无限扩散，避免把无关技能顶到前面；
 *   - 别名表可增删，但每组必须是小写、去空格、无标点的词。
 */

/** 高频场景别名组（同一组内互相等价，用于扩展查询词）。 */
export const SKILL_ALIAS_GROUPS = Object.freeze([
  ["ppt", "pptx", "powerpoint", "演示文稿", "幻灯片", "演示", "deck", "slide", "slides", "汇报ppt", "做ppt", "生成ppt"],
  ["word", "docx", "文档", "公文", "文稿", "报告", "汇报材料", "材料", "word文档"],
  ["excel", "xlsx", "表格", "工作簿", "电子表格", "数据分析表"],
  ["chart", "charts", "图表", "柱状图", "折线图", "饼图", "可视化", "echarts", "数据可视化"],
  ["review", "审查", "评审", "审核", "检查", "核对", "体检"],
  ["research", "研究", "调研", "论文", "文献", "综述", "学术"],
  ["writing", "写作", "撰写", "起草", "润色", "改写", "改写稿"],
  ["lark", "feishu", "飞书"],
  ["pdf", "pdf文档"],
  ["mindmap", "思维导图", "脑图"],
  ["map", "地图", "gis", "空间分析", "制图"],
  ["design", "设计", "ui", "ux", "界面", "前端设计"],
  ["slides", "keynote", "路演", "汇报"],
  ["image", "图片", "配图", "插图", "绘图", "海报"],
  ["video", "视频", "剪辑", "配音", "字幕"],
  ["agent", "智能体", "助手", "子代理"],
  ["skill", "技能", "工作流", "workflow"],
]);

/** 查询噪声词：单独出现时不作为匹配依据（避免“帮我做一个”之类查询把无关技能顶上来）。 */
export const QUERY_STOPWORDS = Object.freeze(new Set([
  "帮我", "请", "一个", "一份", "一下", "怎么", "如何", "什么", "需要", "可以", "这个", "那个", "我的", "现在", "然后", "以及", "还有", "使用", "利用", "用",
  "做一个", "做个", "写一个", "写一份", "生成一个", "来一个",
]));

/** 归一化：全角转半角、小写、去首尾空白、压缩空白。 */
export function normalizeQueryText(value = "") {
  let text = String(value ?? "");
  // 全角字符 → 半角（U+FF01–U+FF5E）
  text = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  text = text.replace(/\u3000/g, " ");
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 查询切词：空白 + 常见标点；过滤噪声词与单字符。 */
export function tokenizeQuery(query = "") {
  const normalized = normalizeQueryText(query);
  if (!normalized) return [];
  return normalized
    .split(/[\s,，。；;、/|+()（）[\]【】"'“”‘’!?！？:：]+/)
    .map((token) => token.trim())
    .filter((token) => token && !QUERY_STOPWORDS.has(token));
}

/**
 * 扩展一个查询词：返回该词及其别名组内的其他词。
 * 命中规则：词与组内某词相等，或（长度≥2 时）互相包含。
 * @param {string} token 已归一化的查询词
 * @returns {string[]} 去重后的候选词（首位是原词）
 */
export function expandToken(token, groups = SKILL_ALIAS_GROUPS) {
  const word = normalizeQueryText(token);
  if (!word) return [];
  const out = new Set([word]);
  for (const group of groups) {
    const hit = group.some((term) => {
      if (term === word) return true;
      if (word.length >= 2 && term.length >= 2 && (word.includes(term) || term.includes(word))) return true;
      return false;
    });
    if (hit) for (const term of group) out.add(term);
  }
  return [...out];
}

/**
 * 把查询展开成 token + variants 列表，供打分使用。
 * @returns {Array<{token: string, variants: string[]}>}
 */
export function expandQuery(query = "") {
  return tokenizeQuery(query).map((token) => ({ token, variants: expandToken(token) }));
}
