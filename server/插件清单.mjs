/**
 * 插件清单与完整性（H4-3）
 *
 * 目标：把 Pi 扩展从“路径登记”升级为“可校验的清单”：
 * 名称、版本、入口、权限声明、SHA-256、依赖。只做本地清单与校验，不做市场/在线安装。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson, readJsonFile } from "./持久化工具.mjs";

export const MANIFEST_NAME = "plugin.manifest.json";
export const MANIFEST_VERSION = 1;

export function manifestPathFor(root) {
  const target = path.resolve(String(root || "."));
  try {
    if (fs.statSync(target).isDirectory()) return path.join(target, MANIFEST_NAME);
  } catch {}
  return path.join(path.dirname(target), MANIFEST_NAME);
}

export function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function hashDirectory(root) {
  const base = path.resolve(String(root || "."));
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6 || files.length >= 5000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === MANIFEST_NAME) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(base);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(base, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), files: files.length };
}

export function buildManifest({ name, version = "0.0.0", root, entry = "index.mjs", permissions = [], dependencies = {} } = {}) {
  const base = path.resolve(String(root || "."));
  const stat = fs.statSync(base);
  const rootInfo = stat.isDirectory() ? hashDirectory(base) : { hash: hashFile(base), files: 1 };
  const entryPath = stat.isDirectory() ? path.resolve(base, entry) : base;
  const entryRelative = stat.isDirectory() ? String(entry).replace(/\\/g, "/") : path.basename(base);
  const entryExists = fs.existsSync(entryPath);
  return {
    manifestVersion: MANIFEST_VERSION,
    name: String(name || path.basename(base)),
    version: String(version || "0.0.0"),
    entry: entryRelative,
    permissions: Array.isArray(permissions) ? permissions.map(String) : [],
    dependencies: dependencies && typeof dependencies === "object" ? dependencies : {},
    rootHash: rootInfo.hash,
    entryHash: entryExists ? hashFile(entryPath) : null,
    fileCount: rootInfo.files,
    createdAt: new Date().toISOString(),
  };
}

export function writeManifest(manifest, root) {
  const file = manifestPathFor(root);
  atomicWriteJson(file, manifest);
  return { ok: true, file };
}

export function readManifest(root) {
  return readJsonFile(manifestPathFor(root), null);
}

/**
 * 校验清单与磁盘内容。
 * @returns {{ok:boolean, errors:string[], manifest:object|null, actual:object|null}}
 */
export function validateManifest(manifest, { root } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") return { ok: false, errors: ["缺少清单"], manifest: null, actual: null };
  if (!manifest.name) errors.push("缺少 name");
  if (!manifest.version) errors.push("缺少 version");
  if (!manifest.entry) errors.push("缺少 entry");
  if (!manifest.rootHash) errors.push("缺少 rootHash");
  const base = path.resolve(String(root || "."));
  let actual = null;
  try {
    actual = buildManifest({
      name: manifest.name,
      version: manifest.version,
      root: base,
      entry: manifest.entry,
      permissions: manifest.permissions,
      dependencies: manifest.dependencies,
    });
  } catch (error) {
    errors.push(`无法读取插件目录：${error.message}`);
  }
  if (actual) {
    if (manifest.rootHash && actual.rootHash !== manifest.rootHash) errors.push("rootHash 不匹配（插件内容已变更）");
    if (manifest.entryHash && actual.entryHash !== manifest.entryHash) errors.push("entryHash 不匹配（入口已变更）");
  }
  return { ok: errors.length === 0, errors, manifest, actual };
}

export function validateRoot(root) {
  const manifest = readManifest(root);
  if (!manifest) return { ok: false, errors: ["清单不存在"], manifest: null, actual: null };
  return validateManifest(manifest, { root });
}
