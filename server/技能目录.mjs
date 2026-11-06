/**
 * 技能目录扫描与缓存（2026-11-04）。
 *
 * 早先 agent.mjs 每次调用 localSkillCatalog() 都全量 readdir + 读每个 SKILL.md；
 * 改成“每轮注入目录”后调用频率更高，这里做一层按文件 mtime 的缓存：
 *   - 每次只 readdir + stat，不读正文；
 *   - 只有 SKILL.md 的 mtime/size 变化时才重新解析 frontmatter；
 *   - 支持目录 bundle `<name>/SKILL.md` 与平铺 `<name>.md`。
 *
 * 扫描根本身来自 server/资源发现.mjs（workspace > project > user）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { skillRootCandidates } from "./资源发现.mjs";

const CACHE = new Map();
const MAX_CACHE_ENTRIES = 32;

function parseFrontmatter(text) {
  const match = String(text || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    const key = item[1];
    let value = item[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function candidateFiles(root) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const file = path.join(root.path, entry.name, "SKILL.md");
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) out.push({ name: entry.name, file, stat });
      } catch {}
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const file = path.join(root.path, entry.name);
      try {
        const stat = fs.statSync(file);
        out.push({ name: entry.name.slice(0, -3), file, stat });
      } catch {}
    }
  }
  return out;
}

function cacheKey({ workspace, agentDir, userProfile, projectDir }) {
  return [workspace, agentDir, userProfile, projectDir].map((item) => String(item || "")).join("\u0000");
}

/**
 * @returns {Array<{name:string, description:string, path:string, source:string, sourceScope:string, sourcePath:string, sourceRank:number}>}
 */
export function listSkillCatalog({
  workspace = "",
  agentDir = "",
  userProfile = process.env.USERPROFILE || os.homedir(),
  projectDir = "",
} = {}) {
  const roots = skillRootCandidates({ agentDir, userProfile, projectDir, workspace });
  const key = cacheKey({ workspace, agentDir, userProfile, projectDir });
  const candidates = [];
  for (const root of roots) {
    for (const item of candidateFiles(root)) candidates.push({ root, ...item });
  }
  const signature = candidates
    .map((item) => `${item.file}|${item.stat.mtimeMs}|${item.stat.size}`)
    .join("\n");
  const cached = CACHE.get(key);
  if (cached && cached.signature === signature) return cached.items;

  const items = [];
  const seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.name)) continue;
    let text = "";
    try { text = fs.readFileSync(item.file, "utf8"); } catch { continue; }
    const frontmatter = parseFrontmatter(text);
    const name = String(frontmatter.name || item.name).trim() || item.name;
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({
      name,
      description: String(frontmatter.description || "").trim(),
      path: item.file,
      source: item.root.kind,
      sourceScope: item.root.source,
      sourcePath: item.root.path,
      sourceRank: item.root.rank,
    });
  }
  items.sort((left, right) => left.name.localeCompare(right.name));
  CACHE.set(key, { signature, items });
  while (CACHE.size > MAX_CACHE_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    CACHE.delete(oldest);
  }
  return items;
}

export function clearSkillCatalogCache() {
  CACHE.clear();
}
