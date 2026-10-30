#!/usr/bin/env node
/**
 * 产物误报回归测试
 *
 * 历史缺陷：快照预算耗尽后哈希退化为 `size:mtime` 兜底值，before/after 两次
 * 快照遍历顺序不同就会出现"一侧真哈希、一侧兜底哈希"，changedFiles 直接比哈希
 * 必然不等 → 只是 mtime 变了的文件被报成"修改"（实测 4 个 shp 文件内容逐字节
 * 一致却进了产物）。
 *
 * 用法: node scripts/产物误报回归测试.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-产物误报-"));
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-产物误报-runs-"));
process.env.OAW_RUNS_DIR = runsDir;
const { snapshotWorkspace, listRunArtifacts } = await import("../server/runs.mjs");

const RUN_ID = "run_test_产物误报";
let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed = 1; console.error(`  ✗ ${msg}`); };
const check = (fn, msg) => { try { fn(); ok(msg); } catch (e) { fail(`${msg}: ${e.message}`); } };

const write = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, "utf8"); return p; };
const touch = (rel, offsetMs) => { const t = new Date(Date.now() + offsetMs); fs.utimesSync(path.join(dir, rel), t, t); };
const withFallbackHash = (snapshot, rel) => { const item = snapshot.files[rel]; item.hash = `${item.size}:${item.mtime}`; return snapshot; };
/** 模拟 Run 开始时的 before 快照 + blob（真实链路里 reversible 文件都有 blob） */
const makeBefore = (snapshot, withBlob = true) => {
  if (withBlob) {
    for (const [rel, item] of Object.entries(snapshot.files)) {
      const target = path.join(runsDir, RUN_ID, "before", rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, rel), target);
      item.reversible = true;
    }
  }
  return snapshot;
};
const runOf = (before) => ({ id: RUN_ID, cwd: dir, snapshotMode: "full", before, touchedPaths: [] });

try {
  write("报告.md", "第一版内容\n");
  write("shp文件/金东区乡镇.dbf", "binary-ish-content");
  const before1 = makeBefore(snapshotWorkspace(dir));

  console.log("\n▶ 只改 mtime、内容不变（有快照，权威复核）");
  touch("报告.md", 60_000);
  touch("shp文件/金东区乡镇.dbf", 60_000);
  const changed1 = listRunArtifacts(runOf(before1));
  check(() => assert.equal(changed1.length, 0), `不进入产物（实际 ${changed1.length} 条：${changed1.map((a) => a.path).join(", ")}）`);

  console.log("\n▶ 只改 mtime、内容不变（无快照，但两侧都是真哈希）");
  const before2 = makeBefore(snapshotWorkspace(dir), false);
  touch("报告.md", 120_000);
  const changed2 = listRunArtifacts(runOf(before2));
  check(() => assert.equal(changed2.length, 0), `内容哈希一致即为未变（实际 ${changed2.length} 条）`);

  console.log("\n▶ 内容真的变了");
  write("报告.md", "第二版内容长一些\n");
  touch("报告.md", 180_000);
  const changed3 = listRunArtifacts(runOf(before1));
  check(() => assert.equal(changed3.length, 1), `识别到变更（实际 ${changed3.length} 条）`);
  check(() => assert.equal(changed3[0]?.path, "报告.md"), "变更路径正确");
  check(() => assert.equal(changed3[0]?.status, "modified"), "状态为 modified");

  console.log("\n▶ 等长内容改动（必须靠内容复核区分）");
  const before4 = makeBefore(snapshotWorkspace(dir));
  write("报告.md", "第二版内容长一堆\n");   // 与上一版等长
  touch("报告.md", 240_000);
  const changed4 = listRunArtifacts(runOf(before4));
  check(() => assert.equal(changed4.length, 1), "等长改动仍被识别为修改");

  console.log("\n▶ 保守边界（无快照 + 兜底哈希 + mtime 变化：无法证明未变，仍按修改上报）");
  const before5 = withFallbackHash(makeBefore(snapshotWorkspace(dir), false), "报告.md");
  touch("报告.md", 300_000);
  const changed5 = listRunArtifacts(runOf(before5));
  check(() => assert.equal(changed5.length, 1), "宁可多报也不漏报真实修改");

  console.log("\n▶ 过程噪音不进产物");
  write("_gh_search/sim1.mjs", "console.log(1)\n");
  write("_probe/node_modules_dir/build/index.mjs", "export default 1\n");
  const before6 = makeBefore(snapshotWorkspace(dir));
  const changed6 = listRunArtifacts(runOf(before6));
  check(() => assert.equal(changed6.length, 0), `新增过程文件被过滤（实际 ${changed6.length} 条：${changed6.map((a) => a.path).join(", ")}）`);
} catch (error) {
  fail(`测试执行异常: ${error?.stack || error}`);
} finally {
  for (const target of [dir, runsDir]) { try { fs.rmSync(target, { recursive: true, force: true }); } catch {} }
}

console.log(failed ? "\n产物误报回归测试：失败" : "\n产物误报回归测试：全部通过");
process.exit(failed);
