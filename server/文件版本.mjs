/**
 * 文件版本指纹（2026-11-04 并发改造）。
 *
 * 目的：把“锁”从“整个 Run 独占文件”降为“写入瞬间串行”，
 * 发布时用写入前的 stat 指纹做一次 CAS：
 *   - 指纹一致 → 正常发布；
 *   - 指纹变化 → 不覆盖，写冲突副本（由调用方决定）。
 *
 * 指纹口径与 DSH/ZCode 的 revision 思路一致，但用 Node 自带的 bigint stat，
 * 不额外读文件内容；同尺寸、同毫秒内的改写由 ctimeNs 兜底。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * 轻量内容指纹：小文件全量，大文件首尾各 64KB。
 * Windows 上连续两次同尺寸写入可能拿到相同 mtimeNs/ctimeNs（实测），
 * 只靠 stat 会把“文件已被改过”误判成“没变”，所以补一层内容指纹。
 */
function contentFingerprint(target, stat) {
  const size = Number(stat.size || 0);
  if (!size) return "0";
  const length = Math.min(size, HASH_CHUNK_BYTES);
  let fd;
  try {
    fd = fs.openSync(target, "r");
    const head = Buffer.alloc(length);
    fs.readSync(fd, head, 0, length, 0);
    const hash = crypto.createHash("sha1").update(head);
    if (size > HASH_CHUNK_BYTES) {
      const tail = Buffer.alloc(Math.min(size, HASH_CHUNK_BYTES));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
    return `${size}:${hash.digest("hex").slice(0, 16)}`;
  } catch {
    return String(size);
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
  }
}

/** 返回文件的稳定版本指纹；不存在返回 null。 */
export function revisionOf(target) {
  try {
    const stat = fs.statSync(target, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${contentFingerprint(target, stat)}`;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export function sameRevision(left, right) {
  return String(left ?? "") === String(right ?? "");
}

/**
 * 冲突副本路径：同目录、同扩展名，插入 `.conflict-<runId8>`。
 * 已存在时追加 `-2`、`-3`，避免并发两次冲突互相覆盖。
 */
export function conflictCopyPath(target, runId, { exists = (candidate) => fs.existsSync(candidate) } = {}) {
  const resolved = path.resolve(target);
  const ext = path.extname(resolved);
  const base = ext ? resolved.slice(0, -ext.length) : resolved;
  const suffix = String(runId || "run").replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "run";
  let candidate = `${base}.conflict-${suffix}${ext}`;
  let index = 2;
  while (exists(candidate)) {
    candidate = `${base}.conflict-${suffix}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

/** 工作区相对路径（用于事件与 manifest）。 */
export function relativeRevisionPath(workspace, target) {
  return path.relative(workspace, target).replace(/\\/g, "/");
}
