#!/usr/bin/env node
/**
 * 核心路径基线测试（对话 → 产出文档 → 打开预览）。
 *
 * 目的：改坏了能发现，不是证明代码正确。断言全部来自 2026-10-20 的实测行为
 * （无头 Edge 走完整路径 + 接口干跑），现有行为即使不合理也照实断言；
 * 修复怪异行为后应有意识地更新本文件，而不是让测试静默迁就新行为。
 *
 * 覆盖的核心路径（8 步中的可机检部分）：
 *   首页/状态 → 发送入口校验 → 工作区文件落盘 → 预览取回 → 产物证据链 → 模式工具策略。
 * 真实模型往返、SSE 流式、审批交互不在本文件内（见文件尾"未保护"清单）。
 *
 * 用法: node tests/baseline/核心路径基线测试.mjs
 *   需要服务已在 3002 端口运行（npm start）；可用 OAW_BASE_URL 覆盖。
 * 退出码: 0 = 全部通过（含 SKIP）, 1 = 有失败
 */
import assert from "node:assert/strict";

const BASE = process.env.OAW_BASE_URL || "http://127.0.0.1:3002";
// 对话产出文档写入的工作区（实测 run.cwd 就是它）；注意不带 workspace 参数的
// /api/files 默认工作区是另一处（本机为 G:\2025年度绩效考核材料），两者不是同一个目录。
const AGENT_WORKSPACE = "E:\\open plan\\office-workspace";

let failed = 0;
let skipped = 0;
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => console.log(`  ✓ ${name}`), (e) => {
    if (e && e.message === "__SKIP__") { skipped += 1; console.log(`  ○ SKIP ${name}`); return; }
    failed = 1; console.error(`  ✗ ${name}: ${e.message}`);
  });

const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { throw new Error(`非 JSON 响应(${res.status}): ${t.slice(0, 120)}`); } };

console.log(`\n▶ 服务健康（${BASE}）`);
await test("GET /api/status 返回 ok 与版本号", async () => {
  const res = await fetch(`${BASE}/api/status`);
  assert.equal(res.status, 200);
  const body = await j(res);
  assert.equal(body.ok, true);
  assert.ok(typeof body.version === "string" && body.version.length > 0, "version 应为非空字符串");
});
await test("GET / 返回首页 HTML（标题 Open Plan 规聚）", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Open Plan 规聚"), "首页应包含产品标题");
});

console.log("\n▶ 发送入口校验（/api/agent/prompt）");
await test("空请求体返回 400 与固定错误文案", async () => {
  const res = await fetch(`${BASE}/api/agent/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(res.status, 400);
  const body = await j(res);
  assert.equal(body.error, "text, image, or attachment required");
});

console.log("\n▶ 工作区文件回路（对话产物的落盘与预览通道）");
await test("上传 → 列表 → /raw 读回 → 删除，内容逐字节一致", async () => {
  const name = "基线测试-临时.md";
  const content = "基线回路测试";
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const qs = `workspace=${encodeURIComponent(AGENT_WORKSPACE)}`;
  const up = await j(await fetch(`${BASE}/api/files/upload`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, base64: b64, workspace: AGENT_WORKSPACE }),
  }));
  assert.equal(up.ok, true);
  try {
    const ls = await j(await fetch(`${BASE}/api/files?${qs}`));
    const hit = (ls.files || []).find((f) => f.name === name);
    assert.ok(hit, "上传后应出现在文件列表");
    assert.equal(hit.mime, "text/markdown");
    const raw = await fetch(`${BASE}/api/doc/${encodeURIComponent(name)}/raw?cwd=${encodeURIComponent(AGENT_WORKSPACE)}`);
    assert.equal(raw.status, 200);
    assert.equal(Buffer.from(await raw.arrayBuffer()).toString("utf8"), content, "/raw 读回内容应与上传一致");
    // 照实记录的现状：/text 对 md 返回 404，md 预览实际走 /raw。
    // 若将来让 /text 支持 md，属行为变更，应同步更新本断言。
    const text = await fetch(`${BASE}/api/doc/${encodeURIComponent(name)}/text?cwd=${encodeURIComponent(AGENT_WORKSPACE)}`);
    assert.equal(text.status, 404, "当前 /text 对 md 是 404（预览走 /raw）");
  } finally {
    const del = await j(await fetch(`${BASE}/api/files/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workspace: AGENT_WORKSPACE }),
    }));
    assert.equal(del.ok, true, "清理临时文件失败");
  }
});
await test("目录参数路径穿越被拒绝（400 invalid dir）", async () => {
  const res = await fetch(`${BASE}/api/files?dir=../`);
  assert.equal(res.status, 400);
  const body = await j(res);
  assert.equal(body.error, "invalid dir");
});

console.log("\n▶ 产物证据链（run 记录里的 artifact 结构）");
await test("最近一次带产物的完成 Run：validation 与 verification 均通过", async () => {
  const data = await j(await fetch(`${BASE}/api/runs`));
  const runs = data.runs || [];
  const hit = runs.find((r) => r.status === "completed" && Array.isArray(r.artifacts) && r.artifacts.length > 0);
  if (!hit) { console.log("    （无已完成带产物的 Run：先在界面跑一次文档任务，历史保存在 .oaw/runs）"); throw new Error("__SKIP__"); }
  const a = hit.artifacts[0];
  assert.ok(typeof a.path === "string" && a.path.length > 0, "artifact.path 应为非空字符串");
  assert.equal(a.validation.status, "passed", "产物预检应通过");
  assert.equal(a.verificationStatus, "passed", "产物验收状态应为 passed");
});

console.log("\n▶ 模式工具策略（纯函数，不依赖服务器）");
await test("Chat 模式工具表不含写入类工具，Agent 模式包含", async () => {
  const { toolPolicyForMode } = await import("../../server/task.mjs");
  const chat = toolPolicyForMode("chat").tools;
  for (const t of ["write", "edit", "bash", "officecli"]) {
    assert.ok(!chat.includes(t), `Chat 模式不应有 ${t}，实际含：${chat.join(",")}`);
  }
  const agent = toolPolicyForMode("agent").tools;
  for (const t of ["write", "edit", "bash", "officecli"]) {
    assert.ok(agent.includes(t), `Agent 模式应有 ${t}`);
  }
});
await test("引用不存在的 docx 时不给 edit 路由（v0.13.3 四路由照实断言）", async () => {
  // v0.13.3 起路由改为意图制（edit/generate/template/none）：edit 要求能定位既有文件，
  // 文件不存在则不触发 edit → officecli 为 not_needed（旧版行为是 lazy，已随四路由改造变化）。
  const { planTaskCapabilities } = await import("../../server/task.mjs");
  const r = planTaskCapabilities({ text: "修改 基线不存在的报告XYZ.docx 里的预算表", task: { mode: "agent" } });
  assert.equal(r.routing.officecli, "not_needed");
  assert.equal(r.route, "read", "文件不可定位时退化为读文档意图（v0.13.3 实际行为）");
});

console.log(`\n${failed ? "✗" : "✓"} 基线测试完成：${failed ? "有失败" : "全部通过"}（SKIP ${skipped}）`);
process.exit(failed ? 1 : 0);
