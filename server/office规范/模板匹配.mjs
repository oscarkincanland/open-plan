/**
 * 模板识别与路由（O-13）。
 *
 * 优先级：显式 `@模板[...]` > 文体关键词 > 无匹配。
 * 只读扫描 templates/traffic-material/，不修改任何模板文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
export const TEMPLATE_DIR = path.join(REPO_ROOT, "templates", "traffic-material");

/** 文体关键词 → 模板文件。匹配分数按命中关键词长度累加，长词优先。 */
const TEMPLATE_RULES = Object.freeze([
  { file: "04_工程可行性研究报告模板.md", keywords: ["工程可行性研究报告", "工程可行性", "工可", "可研", "可行性研究"] },
  { file: "05_线位论证预可模板.md", keywords: ["线位论证", "预可", "线位"] },
  { file: "06_选址和用地预审论证模板.md", keywords: ["选址和用地预审", "用地预审", "选址论证", "选址"] },
  { file: "07_交通影响评价模板.md", keywords: ["交通影响评价", "交评"] },
  { file: "01_年度工作报告模板.md", keywords: ["年度工作报告", "年度报告", "年度总结"] },
  { file: "02_五年发展规划模板.md", keywords: ["五年发展规划", "五年规划", "发展规划"] },
  { file: "03_规划文本条文式模板.md", keywords: ["条文式", "规划文本"] },
  { file: "08_汇报材料模板.md", keywords: ["汇报材料", "汇报稿", "汇报"] },
  { file: "09_物流园区规划模板.md", keywords: ["物流园区"] },
  { file: "10_规划研究报告模板.md", keywords: ["规划研究报告", "专题研究", "评估研究", "规划研究"] },
  { file: "11_PPT汇报模板.md", keywords: ["PPT汇报", "演示文稿", "ppt"] },
  { file: "12_素材库深挖.md", keywords: ["素材库", "案例库"] },
  { file: "00_总览通用规范.md", keywords: ["通用规范", "写作规范", "格式规范"] },
]);

let catalogCache = null;

/** 扫描模板目录（只读）。 */
export function templateCatalog() {
  if (catalogCache) return catalogCache;
  const items = [];
  try {
    for (const name of fs.readdirSync(TEMPLATE_DIR)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      const absPath = path.join(TEMPLATE_DIR, name);
      const stat = fs.statSync(absPath);
      items.push({
        file: name,
        relPath: `templates/traffic-material/${name}`,
        absPath,
        size: stat.size,
        title: readTitle(absPath, name),
      });
    }
  } catch {
    catalogCache = [];
    return catalogCache;
  }
  catalogCache = items.sort((a, b) => a.file.localeCompare(b.file, "zh"));
  return catalogCache;
}

function readTitle(absPath, fallback) {
  try {
    const head = fs.readFileSync(absPath, "utf8").slice(0, 600);
    const h1 = head.match(/^#\s+(.+)$/m);
    return h1 ? h1[1].trim() : fallback.replace(/\.md$/i, "");
  } catch {
    return fallback.replace(/\.md$/i, "");
  }
}

function findByFile(file) {
  return templateCatalog().find((item) => item.file === file) || null;
}

function findByTarget(target) {
  const text = String(target || "").trim().replace(/\\/g, "/");
  if (!text) return null;
  const base = text.split("/").pop();
  return templateCatalog().find((item) => item.file === base || item.relPath === text || item.relPath.endsWith(`/${base}`)) || null;
}

function explicitTemplateTargets(text) {
  const out = [];
  const source = String(text || "");
  for (const match of source.matchAll(/@模板\[([^\]]+)\]/g)) out.push(match[1]);
  return out;
}

/**
 * 匹配模板。
 * @param {object} input
 * @param {string} [input.text]
 * @param {Array<{kind?:string,target?:string}>} [input.references]
 * @returns {null|{relPath:string, absPath:string, title:string, file:string, matched:string[], source:"explicit"|"keyword", score:number}}
 */
export function matchTemplate({ text = "", references = [] } = {}) {
  // 1) 结构化引用（kind=template）优先
  for (const ref of Array.isArray(references) ? references : []) {
    if (String(ref?.kind || "") !== "template") continue;
    const hit = findByTarget(ref.target);
    if (hit) return { ...hit, matched: [String(ref.target)], source: "explicit", score: 1000 };
  }

  // 2) 文本里的 @模板[...]
  for (const target of explicitTemplateTargets(text)) {
    const hit = findByTarget(target);
    if (hit) return { ...hit, matched: [target], source: "explicit", score: 1000 };
  }

  // 3) 明确格式信号优先：PPT/演示/幻灯片 → 11_PPT汇报模板
  const source = String(text || "").toLowerCase();
  if (/\bppt\b|演示文稿|幻灯片|\bdeck\b/i.test(source)) {
    const hit = findByFile("11_PPT汇报模板.md");
    if (hit) return { ...hit, matched: ["PPT"], source: "keyword", score: 100 };
  }

  // 4) 文体关键词
  let best = null;
  for (const rule of TEMPLATE_RULES) {
    const matched = rule.keywords.filter((keyword) => source.includes(String(keyword).toLowerCase()));
    if (!matched.length) continue;
    const score = matched.reduce((sum, keyword) => sum + String(keyword).length, 0);
    if (!best || score > best.score) best = { rule, matched, score };
  }
  if (!best) return null;
  const hit = findByFile(best.rule.file);
  if (!hit) return null;
  return { ...hit, matched: best.matched, source: "keyword", score: best.score };
}

/** 场景 → 模板映射（O-16）：读取 JSON 并校验目标存在。 */
export function sceneTemplateMap() {
  const file = path.join(__dirname, "场景模板映射.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw.scenes || {};
  } catch {
    return {};
  }
}

export function templateForScene(sceneId) {
  const relPath = sceneTemplateMap()[String(sceneId || "")];
  if (!relPath) return null;
  return templateCatalog().find((item) => item.relPath === relPath) || null;
}
