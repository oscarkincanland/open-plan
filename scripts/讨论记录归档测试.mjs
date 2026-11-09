#!/usr/bin/env node
/**
 * Chat 讨论记录归档测试（2026-11-08 / ADR 0030）
 *
 * 验证 `server/讨论记录.mjs` 的纯函数与追加行为：
 *   1. 文件名安全化（路径分隔符 / 保留字符 / 超长）；
 *   2. 一份会话一个文件、按轮追加（不是每轮一个新文件）；
 *   3. 首轮建标题与来源说明，后续轮只追加小节；
 *   4. 空答案 / 空工作区直接跳过（不落空文件）；
 *   5. 归档在 Chat 收尾接线，且取消/失败不归档、失败不影响终态。
 *
 * 用法：node scripts/讨论记录归档测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { safeSlug, discussionRelativePath, appendChatDiscussion, REPORT_DIR } = await import("../server/讨论记录.mjs");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-discussion-"));
try {
  console.log("▶ 命名与路径");

  test("文件名安全化：路径分隔符与保留字符被清掉", () => {
    assert.equal(safeSlug("金东/CAD:测试*?"), "金东 CAD 测试");
    assert.equal(safeSlug("  多  空格  "), "多 空格");
    assert.equal(safeSlug(""), "讨论");
    assert.ok(safeSlug("长".repeat(200)).length <= 40);
  });

  test("讨论记录固定落在 回报/讨论-<标题>.md", () => {
    assert.equal(REPORT_DIR, "回报");
    assert.equal(discussionRelativePath({ title: "CAD 中文乱码" }), "回报/讨论-CAD 中文乱码.md");
  });

  console.log("▶ 追加行为");

  test("首轮建标题与来源说明，后续轮只追加小节", () => {
    const first = appendChatDiscussion(tmp, { title: "CAD 讨论", question: "为什么乱码？", answer: "因为 latin1 截断。", runId: "run_a", at: "2026-11-08T10:00:00" });
    assert.ok(first && first.created, "首轮应创建文件");
    const second = appendChatDiscussion(tmp, { title: "CAD 讨论", question: "怎么修？", answer: "按 UTF-8 写回。", runId: "run_b", at: "2026-11-08T11:30:00" });
    assert.ok(second && !second.created, "同会话第二轮不应新建文件");
    const text = fs.readFileSync(path.join(tmp, "回报", "讨论-CAD 讨论.md"), "utf8");
    assert.match(text, /^# 讨论记录 · CAD 讨论/m);
    assert.match(text, /由规聚自动归档/);
    assert.equal((text.match(/^# 讨论记录/gm) || []).length, 1, "标题只能出现一次");
    assert.equal((text.match(/^## /gm) || []).length, 2, "每轮一个小节");
    assert.match(text, /run_a/);
    assert.match(text, /按 UTF-8 写回/);
  });

  test("空答案或空工作区直接跳过，不落空文件", () => {
    assert.equal(appendChatDiscussion(tmp, { title: "x", answer: "   " }), null);
    assert.equal(appendChatDiscussion("", { title: "x", answer: "有内容" }), null);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("▶ 收尾接线");

const 执行句柄 = fs.readFileSync(path.join(ROOT, "server/执行句柄.mjs"), "utf8");

test("只在 Chat 且未取消时归档，失败不影响终态", () => {
  assert.match(执行句柄, /import \{ appendChatDiscussion \} from "\.\/讨论记录\.mjs";/);
  const block = 执行句柄.slice(执行句柄.indexOf("if (!cancelled && String(task?.mode"), 执行句柄.indexOf("const completed = run ? deps.runs.finishRun"));
  assert.ok(block.length > 0, "未找到归档接线");
  assert.match(block, /appendChatDiscussion\(runWorkspace/);
  assert.match(block, /catch \(error\)/);
  assert.match(block, /chat_discussion_archive_failed/);
});

if (failed) {
  console.error("\n✗ 讨论记录归档存在失败项\n");
  process.exit(1);
}
console.log("\n✓ 讨论记录归档全部通过\n");
