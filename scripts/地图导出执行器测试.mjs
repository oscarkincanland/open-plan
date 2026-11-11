/**
 * 地图导出执行器测试（test:map-export，2026-11-11-004 §5.1）。
 *
 * 覆盖：
 *   1) 纯逻辑：导出视图 URL 拼接（端口解析、layers/title）、单飞闸门语义；
 *   2) 源码契约：index.mjs 改用执行器模块（不再内联）、agent.mjs 定义并注册 map_export、
 *      task.mjs 白名单、审批策略 ask、工具元数据登记（ADR-0038 五条线）。
 *
 * 不启动浏览器、不联网、不写工作区（纯函数 + 静态源码断言）。
 * 用法：node scripts/地图导出执行器测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const 执行器 = await import("../server/地图导出执行器.mjs");

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
  }
};

check("buildExportViewUrl：query 拼接与端口解析（显式 > env > 3002）", () => {
  const job = { project: "lishui-od-demo", title: "丽水出行OD演示", layers: ["od_lines", "od_nodes"] };
  const url = 执行器.buildExportViewUrl(job, 4321);
  assert.ok(url.startsWith("http://127.0.0.1:4321/?"), `显式端口应生效：${url}`);
  const params = new URL(url).searchParams;
  assert.equal(params.get("export"), "map");
  assert.equal(params.get("project"), "lishui-od-demo");
  assert.equal(params.get("title"), "丽水出行OD演示");
  assert.equal(params.get("layers"), "od_lines,od_nodes");

  const noLayers = new URL(执行器.buildExportViewUrl({ project: "p", title: "" }, 4321)).searchParams;
  assert.equal(noLayers.get("layers"), null, "无 layers 时不写 layers 参数");

  const envPort = 执行器.buildExportViewUrl({ project: "p", title: "" }, undefined);
  assert.match(envPort, /^http:\/\/127\.0\.0\.1:\d+\/\?/, "缺省端口应落到 env PORT 或 3002");
  const envResolved = Number(new URL(envPort).port) || 80;
  assert.ok(envResolved === (Number(process.env.PORT) || 3002), `env 兜底端口应与 index.mjs 同源，实际 ${envResolved}`);
});

check("单飞闸门：占用互斥、owner 校验释放、空 owner 拒绝", () => {
  assert.ok(执行器.tryAcquireExportSlot("test-a"), "空闲时应能占用");
  assert.equal(执行器.tryAcquireExportSlot("test-b"), false, "已被占用时二次占用必须失败");
  assert.equal(执行器.currentExportOwner(), "test-a");
  执行器.releaseExportSlot("test-b");
  assert.equal(执行器.currentExportOwner(), "test-a", "非 owner 释放不得生效");
  assert.equal(执行器.releaseExportSlot("test-a"), undefined, "owner 释放不返回值");
  assert.equal(执行器.currentExportOwner(), "", "owner 释放后应空闲");
  assert.equal(执行器.tryAcquireExportSlot(""), false, "空 owner 拒绝占用");
  assert.equal(执行器.tryAcquireExportSlot("  "), false, "空白 owner 拒绝占用");
  assert.ok(执行器.tryAcquireExportSlot("test-c"), "释放后可再次占用");
  执行器.releaseExportSlot("test-c");
});

const index源码 = read("server/index.mjs");
const agent源码 = read("server/agent.mjs");
const task源码 = read("server/task.mjs");
const 审批源码 = read("server/审批策略.mjs");
const 元数据源码 = read("server/工具元数据.mjs");

check("index.mjs：G7 路由改用执行器模块，不再内联 executeExportJob", () => {
  assert.match(index源码, /import\("\.\/地图导出执行器\.mjs"\)/, "G7 路由必须引用执行器模块");
  assert.doesNotMatch(index源码, /async function executeExportJob/, "不得再内联执行器");
  assert.doesNotMatch(index源码, /mapExportActiveBatch/, "旧单飞变量应删除（闸门在执行器模块内）");
  assert.match(index源码, /地图导出执行器\.executeExportJob\(job, \{ workspace, port: PORT \}\)/, "G7 调用须传 workspace 与 PORT");
});

check("agent.mjs：map_export 工具定义并注册到 customTools", () => {
  assert.match(agent源码, /name: "map_export"/, "必须定义 map_export 工具");
  assert.match(agent源码, /mapProjectCreateTool, mapExportTool,/, "必须注册到 customTools 列表");
  assert.match(agent源码, /MAP_EXPORT_DISABLED/, "开关关闭时返回明确错误码");
  assert.match(agent源码, /tryAcquireExportSlot\("agent"\)/, "agent 导出必须走单飞闸门");
  assert.match(agent源码, /appendAgentManifest/, "产物必须写 manifest");
  assert.match(agent源码, /requireToolApproval\(\{\s*entry, tool: "map_export"/, "必须先审批");
  assert.match(agent源码, /action: "project_created"/, "map_project_create 成功后必须发 project_created 事件");
});

check("task.mjs：Work 白名单含 map_export，Chat/Review 不含", () => {
  const agent块 = /const AGENT_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(task源码)?.[1] || "";
  assert.match(agent块, /"map_export"/, "Work 白名单必须包含 map_export");
  const chat块 = /const CHAT_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(task源码)?.[1] || "";
  assert.doesNotMatch(chat块, /map_export/, "Chat 白名单不得包含 map_export");
  const review块 = /const REVIEW_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(task源码)?.[1] || "";
  assert.doesNotMatch(review块, /map_export/, "Review 白名单不得包含 map_export");
});

check("审批策略与元数据：map_export → ask + 登记", () => {
  assert.match(审批源码, /\{ tool: "map_export", pattern: "\*", action: "ask" \}/, "审批策略必须 ask");
  assert.match(元数据源码, /meta\("map_export"/, "工具元数据必须登记");
});

if (failed) {
  console.error("地图导出执行器测试：存在失败项");
  process.exitCode = 1;
} else {
  console.log("地图导出执行器测试：全部通过");
}
