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

/**
 * 解析 SKILL.md frontmatter（最小 YAML 子集，2026-11-08 D0-1）。
 *
 * 支持：
 *   - `key: value`、`key: "..."` / `key: '...'`；
 *   - `key: >` / `|` / `>-` / `|-` 块标量（后续缩进行折叠为空格或保留换行）；
 *   - 嵌套块（如 `requires:` 后接缩进列表/映射）原样保留为字符串，由依赖模块解析。
 *
 * 之前用单行正则，`description: >` 只能取到 `>`，导致 10/66 个技能简介为空、
 * 模型无法按 description 判断是否使用（见审查报告 02）。
 * @returns {Record<string,string>}
 */
export function parseFrontmatter(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const match = source.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const item = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    const key = item[1];
    const inline = String(item[2] || "").trim();
    const isBlockScalar = /^([>|])([+-]?)$/.test(inline);
    const hasNestedBlock = !inline || inline === "~" || inline === "null";
    if (isBlockScalar || hasNestedBlock) {
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const line = lines[j];
        if (!line.trim()) { collected.push(""); continue; }
        if (/^\s+/.test(line)) { collected.push(line); continue; }
        break;
      }
      i = j - 1;
      const nonBlank = collected.filter((line) => line.trim());
      const indent = nonBlank.length
        ? Math.min(...nonBlank.map((line) => (line.match(/^(\s*)/) || ["", ""])[1].length))
        : 0;
      const stripped = collected.map((line) => (line ? line.slice(Math.min(indent, line.length)) : ""));
      while (stripped.length && !stripped[stripped.length - 1].trim()) stripped.pop();
      while (stripped.length && !stripped[0].trim()) stripped.shift();
      if (isBlockScalar) {
        const folded = inline.startsWith(">");
        fields[key] = folded
          ? stripped.reduce((accumulator, line) => (line.trim()
            ? `${accumulator}${accumulator && !accumulator.endsWith(" ") ? " " : ""}${line.trim()}`
            : `${accumulator}\n`), "").trim()
          : stripped.join("\n").trim();
      } else {
        fields[key] = stripped.join("\n").trim();
      }
      continue;
    }
    let value = inline;
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
    // 别名：目录名/文件名（与 frontmatter.name 不同时保留），加上 frontmatter.aliases。
    const aliases = new Set();
    if (item.name && item.name !== name) aliases.add(item.name);
    for (const alias of String(frontmatter.aliases || "").split(/[,，、\s]+/)) {
      const value = alias.trim();
      if (value && value !== name) aliases.add(value);
    }
    items.push({
      name,
      description: String(frontmatter.description || "").trim(),
      descriptionComplete: !/^[>|]/.test(String(frontmatter.description || "").trim()),
      aliases: [...aliases],
      path: item.file,
      source: item.root.kind,
      sourceScope: item.root.source,
      sourcePath: item.root.path,
      sourceRank: item.root.rank,
      // D1 使用：requires / install 嵌套块原样保留，由 server/技能依赖.mjs 解析。
      requiresText: String(frontmatter.requires || "").trim(),
      installText: String(frontmatter.install || "").trim(),
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
