#!/usr/bin/env node
/**
 * 一次性清理：历史 Run 记录里的"误报产物"与"过程噪音产物"。
 *
 * 背景：旧版快照 diff 存在两个问题，导致产物清单混入不该出现的文件——
 *   1) 兜底哈希（预算耗尽后退化为 `size:mtime`）与真实 SHA1 口径不一致，
 *      "只动了 mtime、内容没变"的文件被误判为 modified；
 *   2) 下划线临时目录（_gh_search/、_probe/）下的过程文件未被过滤。
 * 前者已在 `changedFiles` 修复（仅影响新 Run），本脚本用于修正历史记录。
 *
 * 判定原则（保守，只删能证明是误报的条目）：
 *   - 噪音：isNoiseArtifactPath(path) 命中；
 *   - 误报：status=modified 且有 before 快照，且 before 快照与当前文件逐字节一致
 *           （说明该文件自本 Run 之前至今从未变过）。
 *   added / deleted / renamed 一律不动。
 *
 * 用法:
 *   node scripts/清理误报产物.mjs            # dry-run，只报告
 *   node scripts/清理误报产物.mjs --apply    # 应用修改（会同步修正摘要里的文件数）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isNoiseArtifactPath } from "../server/runs.mjs";
import { atomicWriteJson } from "../server/持久化工具.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = path.join(PROJECT_DIR, ".oaw", "runs");
const APPLY = process.argv.includes("--apply");

const sha = (file) => {
  try { return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
};

let scanned = 0;
let touched = 0;
let removedNoise = 0;
let removedFalse = 0;
let summaryFixed = 0;

for (const name of fs.readdirSync(RUNS_DIR).filter((item) => item.endsWith(".json"))) {
  const file = path.join(RUNS_DIR, name);
  let run;
  try { run = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
  if (!Array.isArray(run.artifacts) || !run.artifacts.length) continue;
  scanned += 1;

  const keep = [];
  const removed = [];
  for (const artifact of run.artifacts) {
    const rel = String(artifact?.path || "").replace(/\\/g, "/");
    if (!rel) { keep.push(artifact); continue; }
    if (isNoiseArtifactPath(rel)) { removed.push({ artifact, why: "噪音(临时目录/过程文件)" }); removedNoise += 1; continue; }
    if (artifact.status === "modified" && artifact.before?.reversible) {
      const blob = path.join(RUNS_DIR, run.id, "before", rel);
      const current = path.join(run.cwd || "", rel);
      const beforeHash = fs.existsSync(blob) ? sha(blob) : null;
      const currentHash = fs.existsSync(current) ? sha(current) : null;
      if (beforeHash && currentHash && beforeHash === currentHash) {
        removed.push({ artifact, why: "误报(内容与修改前逐字节一致)" });
        removedFalse += 1;
        continue;
      }
    }
    keep.push(artifact);
  }
  if (!removed.length) continue;

  touched += 1;
  console.log(`\n${run.id}  [${run.status}]  产物 ${run.artifacts.length} → ${keep.length}`);
  for (const item of removed) console.log(`    - ${item.artifact.status}  ${item.artifact.path}   ← ${item.why}`);

  let nextSummary = run.summary;
  if (keep.length !== run.artifacts.length && typeof run.summary === "string") {
    const patched = keep.length
      ? run.summary.replace(/共处理\s*\d+\s*个文件/, `共处理 ${keep.length} 个文件`)
      : "本轮对话完成，未检测到文件变更";
    if (patched !== run.summary) { nextSummary = patched; summaryFixed += 1; }
  }

  if (APPLY) {
    run.artifacts = keep;
    if (nextSummary !== run.summary) run.summary = nextSummary;
    atomicWriteJson(file, run);
  }
}

console.log(`\n扫描 ${scanned} 个含产物的 Run，命中 ${touched} 个`);
console.log(`  噪音条目: ${removedNoise}`);
console.log(`  误报条目: ${removedFalse}`);
console.log(`  摘要文件数修正: ${summaryFixed}`);
console.log(APPLY ? "\n已应用修改。" : "\n以上为 dry-run（未写入）。确认无误后加 --apply 执行。");
