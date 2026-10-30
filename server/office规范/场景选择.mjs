/**
 * 场景选择器（O-10）：把用户说法映射到 7 个业务场景。
 *
 * 只做关键词打分，不做模型推断；带简单否定处理（"不是论文，是报告"）。
 * 无命中时回落到 report（默认场景），由调用方在产物里标注假设。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENE_FILE = path.join(__dirname, "场景参数.json");

let cache = null;

export function loadScenes() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(SCENE_FILE, "utf8"));
  cache = raw;
  return cache;
}

export function sceneIds() {
  return Object.keys(loadScenes().scenes);
}

export function getScene(id) {
  const data = loadScenes();
  return data.scenes[String(id || "")] ? { id: String(id), ...data.scenes[String(id)] } : null;
}

export function defaultScene() {
  return loadScenes().defaultScene || "report";
}

export function sceneLabels() {
  const data = loadScenes();
  return Object.entries(data.scenes).map(([id, scene]) => ({ id, label: scene.label }));
}

const NEGATION = /(?:不是|不要|并非|而非|不做|别做)\s*$/;

/** 判断某次命中是否处于否定语境（向前看 4 个字符）。 */
function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - 4), index);
  return NEGATION.test(before) || /不是|不要|并非|而非/.test(before);
}

/**
 * 选择场景。
 * @param {string} text 用户输入
 * @returns {{scene:string, label:string, matched:string[], confidence:number, negated:string[]}}
 */
export function selectScene(text) {
  const source = String(text || "").toLowerCase();
  const data = loadScenes();
  const scores = [];
  const negated = [];

  for (const [id, scene] of Object.entries(data.scenes)) {
    let hits = 0;
    const matched = [];
    for (const keyword of scene.keywords || []) {
      const needle = String(keyword).toLowerCase();
      let from = 0;
      let found = false;
      while (true) {
        const index = source.indexOf(needle, from);
        if (index < 0) break;
        if (isNegated(source, index)) {
          if (!negated.includes(keyword)) negated.push(keyword);
        } else {
          found = true;
          if (!matched.includes(keyword)) matched.push(keyword);
        }
        from = index + needle.length;
      }
      if (found) hits += 1;
    }
    if (hits > 0) scores.push({ id, hits, matched });
  }

  if (!scores.length) {
    const fallback = defaultScene();
    const scene = data.scenes[fallback];
    return { scene: fallback, label: scene?.label || fallback, matched: [], confidence: 0, negated };
  }

  scores.sort((a, b) => b.hits - a.hits || b.matched.join("").length - a.matched.join("").length);
  const top = scores[0];
  const totalKeywords = (data.scenes[top.id].keywords || []).length || 1;
  return {
    scene: top.id,
    label: data.scenes[top.id].label,
    matched: top.matched,
    confidence: Math.min(1, Number((top.hits / totalKeywords).toFixed(2))),
    negated,
  };
}

/** 场景的必填信息提示（供澄清闸门使用）。 */
export function sceneStructure(sceneId) {
  return getScene(sceneId)?.structure || [];
}
