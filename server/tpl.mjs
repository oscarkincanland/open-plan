/**
 * 模版库服务（tpl.mjs）
 *
 * 扫描项目内置模版目录，提供分类列表和内容预览。
 * 当前只有两条真实存在的分类（源目录均在本仓库内）：
 *   - templates/traffic-material/ 规划素材库（14 份写作模板 + 维护文档）
 *   - templates/opendesign/ HTML PPT（OpenDesign 演示风格与网页模板）
 * 历史分类（_报告模板/、义乌/衢州项目目录等）的源目录不随仓库分发，2026-11-11
 * 已从配置中移除；这些目录真实落地后再按相同结构加回（source dirs 必须存在）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_DIR = path.resolve(__dirname, ".."); // 项目根（templates/ 在其下）

// ── 模版分类定义（只保留源目录真实存在的分类） ──
const CATEGORIES = [
  { id: "htmlppt",   name: "HTML PPT（OpenDesign）", icon: "ppt", dirs: [path.join(PROJECT_DIR, "templates/opendesign")], exts: [".html"], depth: 5, folderTitle: true, skipDirs: ["assets", "themes", "animations", "fonts", "scripts", "docs", "references", "examples"] },
  { id: "sucaiku",   name: "规划素材库", icon: "folderOpen", dirs: [path.join(PROJECT_DIR, "templates/traffic-material")], exts: [".md"] },
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".obsidian", "dist", "build"]);

let _cache = null;

function walkDir(dir, baseRel, out, maxDepth = 3, depth = 0, skipDirs = []) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const rel = baseRel ? `${baseRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || skipDirs.includes(e.name)) continue;
      walkDir(abs, rel, out, maxDepth, depth + 1, skipDirs);
    } else if (e.isFile()) {
      out.push({ abs, rel, name: e.name });
    }
  }
}

function parseTitle(absPath, name, folderTitle = false) {
  const ext = path.extname(name).toLowerCase();
  if (folderTitle) {
    // HTML 模板：用模板目录名 + 文件名作为标题（如 html-ppt-zhangzara-studio / example.html）
    const dirName = path.basename(path.dirname(absPath));
    const base = name.replace(/\.[^.]+$/, "");
    if (base === "index" || base === "example") return dirName.replace(/^html-ppt-?/i, "");
    return `${dirName.replace(/^html-ppt-?/i, "")} / ${base}`;
  }
  if (ext === ".md" || ext === ".markdown") {
    try {
      const content = fs.readFileSync(absPath, "utf8").slice(0, 2000);
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        const titleLine = fm[1].split("\n").find((l) => /^\s*title\s*:/i.test(l));
        if (titleLine) return titleLine.replace(/^\s*title\s*:\s*/i, "").replace(/^['"]|['"]$/g, "").trim();
      }
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) return h1[1].trim();
    } catch {}
  }
  return name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
}

function scanTemplates() {
  const templates = [];
  for (const cat of CATEGORIES) {
    for (const dir of cat.dirs) {
      const absDir = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
      if (!fs.existsSync(absDir)) continue;
      const files = [];
      walkDir(absDir, dir, files, cat.depth ?? 2, 0, cat.skipDirs ?? []);
      for (const f of files) {
        const ext = path.extname(f.name).toLowerCase();
        if (!cat.exts.includes(ext)) continue;
        // HTML PPT（OpenDesign）分类：只收录 example.html（每个模板的唯一可预览入口），
        // 排除集合页/子页面/占位 html，避免"假模板"出现在列表
        if (cat.id === "htmlppt" && f.name !== "example.html") continue;
        // 归一化 relPath：绝对路径 → 相对项目根 + 正斜杠（前端 URL 传递与文件路由解析需要）
        let rel = f.rel;
        if (path.isAbsolute(rel)) rel = path.relative(PROJECT_DIR, rel);
        rel = rel.split(path.sep).join("/");
        const st = fs.statSync(f.abs);
        templates.push({
          id: `${cat.id}/${rel}`,
          category: cat.id,
          name: f.name,
          relPath: rel,
          title: parseTitle(f.abs, f.name, cat.folderTitle),
          ext: ext.slice(1),
          size: st.size,
          mtime: st.mtimeMs,
          type: ext === ".md" || ext === ".markdown" ? "markdown" : ext === ".html" || ext === ".htm" ? "html" : ext === ".docx" || ext === ".doc" ? "word" : ext === ".pdf" ? "pdf" : ext === ".pptx" || ext === ".ppt" ? "ppt" : ext === ".xlsx" || ext === ".xls" ? "xls" : "other",
        });
      }
    }
  }
  // 去重（同一 relPath 出现在多个分类时保留第一个）
  const seen = new Set();
  const deduped = [];
  for (const t of templates) {
    if (seen.has(t.relPath)) continue;
    seen.add(t.relPath);
    deduped.push(t);
  }
  return deduped;
}

export function getTemplates() {
  if (!_cache) _cache = scanTemplates();
  return _cache;
}

export function getCategories() {
  return CATEGORIES.map((c) => ({ id: c.id, name: c.name, icon: c.icon }));
}

export function getTemplatesByCategory(categoryId) {
  const all = getTemplates();
  if (!categoryId || categoryId === "all") return all;
  return all.filter((t) => t.category === categoryId);
}

export function resolveTemplatePath(relPath) {
  // 模板可能相对工作目录（ROOT，_报告模板 等）或项目根（PROJECT_DIR，templates/），双根尝试
  let absPath;
  if (path.isAbsolute(relPath)) {
    absPath = relPath;
  } else {
    const c1 = path.join(ROOT, relPath);
    const c2 = path.join(PROJECT_DIR, relPath);
    absPath = fs.existsSync(c1) ? c1 : fs.existsSync(c2) ? c2 : c1;
  }
  if (!fs.existsSync(absPath)) return null;
  try { if (!fs.statSync(absPath).isFile()) return null; } catch { return null; }
  return absPath;
}

export function getTemplateContent(relPath) {
  const absPath = resolveTemplatePath(relPath);
  if (!absPath) return null;
  const ext = path.extname(absPath).toLowerCase();
  const st = fs.statSync(absPath);
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".html" || ext === ".htm") {
    try {
      const content = fs.readFileSync(absPath, "utf8");
      return { type: "text", content, ext: ext.slice(1), size: st.size };
    } catch { return null; }
  }
  // 二进制文件：返回类型信息（前端用 iframe 渲染）
  if (ext === ".docx" || ext === ".doc") return { type: "word", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".pdf") return { type: "pdf", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".pptx" || ext === ".ppt") return { type: "ppt", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".xlsx" || ext === ".xls") return { type: "xls", ext: ext.slice(1), size: st.size, relPath };
  return { type: "binary", ext: ext.slice(1), size: st.size, relPath };
}

// 重新扫描（目录变更后调用）
export function refresh() { _cache = null; }
