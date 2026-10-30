/**
 * 记忆语义召回（H2-1）
 *
 * 目标：不再每轮全量注入记忆摘要，而是：
 *   1) 列出 manifest（文件名/类型/描述/mtime，不含正文）；
 *   2) 由模型或确定性选择器挑选相关条目；
 *   3) 逐条注入并附“可能过时”的警告，总量受预算约束。
 *
 * 设计约束：
 *   - 不依赖向量库；选择结果可人工审计；
 *   - 模型选择失败时回退到关键词选择（fallback=true），不阻断主流程；
 *   - 只读工作区 memory/*.md，不写任何文件。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkspace } from "./workspace.mjs";
import { previewText } from "./工具结果外置.mjs";

const CATEGORY_LABELS = {
  project_fact: "项目事实",
  work_rule: "工作规则",
  user_preference: "用户偏好",
  lesson: "经验教训",
  resource_index: "资料索引",
};

function parseFrontmatter(text) {
  const source = String(text || "");
  if (!source.startsWith("---")) return { data: {}, body: source };
  const end = source.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: source };
  const header = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) data[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body };
}

function inferType(file, frontmatter) {
  const type = String(frontmatter?.metadata?.type || frontmatter?.type || "").trim();
  if (CATEGORY_LABELS[type]) return type;
  const name = file.toLowerCase();
  if (/preference|偏好/.test(name)) return "user_preference";
  if (/rule|准则|规则/.test(name)) return "work_rule";
  if (/lesson|经验|教训/.test(name)) return "lesson";
  if (/resource|资料|索引/.test(name)) return "resource_index";
  return "project_fact";
}

function firstMeaningfulLine(body) {
  for (const line of String(body || "").split(/\r?\n/)) {
    const clean = line.replace(/^#+\s*/, "").trim();
    if (clean && clean !== "---") return clean.slice(0, 160);
  }
  return "";
}

/** 扫描 memory/*.md，生成 manifest（不含正文）。 */
export function scanMemoryManifest(workspace) {
  const root = normalizeWorkspace(workspace);
  if (!root) return [];
  const dir = path.join(root, "memory");
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".md")); } catch { return []; }
  const items = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const text = fs.readFileSync(file, "utf8");
      const { data, body } = parseFrontmatter(text);
      const type = inferType(name, data);
      items.push({
        file: name,
        path: file,
        source: "workspace.memory",
        type,
        label: CATEGORY_LABELS[type] || type,
        description: String(data.description || firstMeaningfulLine(body)).slice(0, 200),
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        body,
      });
    } catch {}
  }
  return items;
}

export function formatManifest(manifest = []) {
  return manifest.map((item) => `- ${item.file} [${item.label || item.type}] ${item.description || "（无描述）"}（更新：${item.mtime}）`).join("\n");
}

function tokenize(query) {
  const text = String(query || "").toLowerCase();
  const latin = text.match(/[a-z0-9_]{2,}/g) || [];
  const cjk = [...text.matchAll(/[\u4e00-\u9fff]{2,}/g)].flatMap((match) => {
    const chars = [...match[0]];
    const grams = [];
    for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i] + chars[i + 1]);
    return grams;
  });
  return [...new Set([...latin, ...cjk])];
}

/** 确定性关键词选择（模型不可用时的回退）。 */
export function selectMemoriesByKeyword(manifest = [], query = "", { limit = 12 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return manifest.slice(0, Math.max(0, limit));
  const scored = manifest.map((item) => {
    const haystack = `${item.file} ${item.description} ${item.type} ${item.body || ""}`.toLowerCase();
    let score = 0;
    for (const token of tokens) if (haystack.includes(token)) score += token.length >= 4 ? 3 : 1;
    return { item, score };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.mtime).localeCompare(String(a.item.mtime)));
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}

export function parseSelection(text, manifest = []) {
  const source = String(text || "");
  const known = new Set(manifest.map((item) => item.file));
  const jsonMatch = source.match(/\{[\s\S]*?"selected"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const list = Array.isArray(parsed.selected) ? parsed.selected : [];
      return list.map(String).filter((name) => known.has(name));
    } catch {}
  }
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => line.replace(/^[-*]\s*/, "")).filter((name) => known.has(name));
}

/** 模型选择 seam：调用方注入 complete(prompt) -> text。 */
export async function selectMemoriesWithModel(manifest, query, complete, options = {}) {
  const prompt = [
    "你是记忆召回选择器。只选择与当前用户请求相关的记忆文件；不确定时宁少勿多。",
    `用户请求：${String(query || "").slice(0, 2000)}`,
    "可用记忆：",
    formatManifest(manifest),
    '只输出 JSON：{"selected":["文件名1","文件名2"]}，不要输出其他内容。',
  ].join("\n");
  const text = await complete(prompt);
  const selected = parseSelection(text, manifest);
  return selected.slice(0, Math.max(1, Number(options.limit) || 12));
}

/**
 * 构建召回上下文。
 * @param {object} input
 * @param {string} input.workspace
 * @param {string} input.query
 * @param {(manifest:Array, query:string)=>Promise<string[]>} [input.selector]
 * @param {number} [input.maxBytes] 总预算
 * @param {number} [input.perFileBytes] 单文件预算
 */
export async function buildRecallContext({
  workspace,
  query = "",
  selector = null,
  maxBytes = 60 * 1024,
  perFileBytes = 8 * 1024,
} = {}) {
  const manifest = scanMemoryManifest(workspace);
  if (!manifest.length) {
    return { manifest: [], manifestText: "", selected: [], text: "", injectedBytes: 0, truncated: false, fallback: false };
  }
  let fallback = false;
  let selectedFiles = [];
  if (typeof selector === "function") {
    try {
      selectedFiles = await selector(manifest, query);
    } catch {
      fallback = true;
    }
  } else {
    fallback = true;
  }
  if (!Array.isArray(selectedFiles) || !selectedFiles.length) {
    selectedFiles = selectMemoriesByKeyword(manifest, query).map((item) => item.file);
    if (typeof selector === "function" && !selectedFiles.length) fallback = true;
  }
  return assembleRecall(manifest, selectedFiles, { maxBytes, perFileBytes, fallback });
}

/**
 * 同步召回（供每轮 prompt 组装使用）：使用确定性关键词选择，不额外调用模型。
 * 模型选择由 selectMemoriesWithModel 在异步场景提供。
 */
export function buildRecallContextSync({
  workspace,
  query = "",
  maxBytes = 60 * 1024,
  perFileBytes = 8 * 1024,
} = {}) {
  const manifest = scanMemoryManifest(workspace);
  if (!manifest.length) {
    return { manifest: [], manifestText: "", selected: [], text: "", injectedBytes: 0, truncated: false, fallback: false };
  }
  const selectedFiles = selectMemoriesByKeyword(manifest, query).map((item) => item.file);
  return assembleRecall(manifest, selectedFiles, { maxBytes, perFileBytes, fallback: true });
}

function assembleRecall(manifest, selectedFiles, { maxBytes = 60 * 1024, perFileBytes = 8 * 1024, fallback = false } = {}) {
  const byFile = new Map(manifest.map((item) => [item.file, item]));
  const selected = (Array.isArray(selectedFiles) ? selectedFiles : []).map((name) => byFile.get(name)).filter(Boolean);
  const limit = Math.max(1, Number(maxBytes) || 60 * 1024);
  const perFile = Math.max(1, Number(perFileBytes) || 8 * 1024);
  let budget = limit;
  let truncated = false;
  const chunks = [];
  for (const item of selected) {
    const raw = String(item.body || "").trim();
    if (!raw) continue;
    const allowed = Math.min(perFile, Math.max(0, budget));
    if (allowed <= 0) { truncated = true; break; }
    const content = previewText(raw, allowed, "head");
    if (Buffer.byteLength(content, "utf8") < Buffer.byteLength(raw, "utf8")) truncated = true;
    budget -= Buffer.byteLength(content, "utf8");
    chunks.push(`### ${item.file}（${item.label || item.type}）\n${content}\n[提示：记忆可能过时，请对照当前代码/文件验证。]`);
  }
  const text = chunks.length ? `## 记忆召回（按相关性选择）\n\n${chunks.join("\n\n")}` : "";
  return {
    manifest,
    manifestText: formatManifest(manifest),
    selected: selected.map((item) => item.file),
    text,
    injectedBytes: Buffer.byteLength(text, "utf8"),
    truncated,
    fallback,
  };
}
