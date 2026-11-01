#!/usr/bin/env node
/**
 * Office 写作闸门通电测试（计划 2026-10-31-003 / N-01、N-02、N-03、N-08）。
 *
 * 覆盖：
 *   1. officeGateActiveFor(route, mode) 的开启/退出/边界判定（ADR 0012）；
 *   2. 执行闸门在写作路由下拦截绕过管线的操作，--allow-manual 可逃逸；
 *   3. 澄清闸门：shouldAsk 判定与"你看着办"跳过；
 *   4. 写作工具书：提示词含五步流程与样式禁令；
 *   5. 能力计划：写作路由声明 editorial_pipeline，非写作路由不声明；
 *   6. bash 不可用时的结构化错误（WSL 探测桩）。
 *
 * 用法: node scripts/Office写作闸门通电测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
function pathToFileURL(p) {
  return new URL(`file://${p.replace(/\\/g, "/")}`);
}

console.log("\n▶ ADR 0012：闸门判定（开启 / 退出 / 边界）");

// 环境变量在模块加载时读取，因此每组判定用独立子进程验证不同 env 组合。
async function gateWithEnv(env, route, mode) {
  const script = `
    import { officeGateActiveFor } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "server/运行开关.mjs")).href)};
    process.stdout.write(String(officeGateActiveFor(${JSON.stringify(route)}, ${JSON.stringify(mode)})));
  `;
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  if (result.status !== 0) throw new Error(`子进程失败：${result.stderr || result.stdout}`);
  return result.stdout.trim() === "true";
}

await test("未设 env：template/generate + agent → 闸门生效", async () => {
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "template", "agent"), true);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "generate", "agent"), true);
});

await test("OAW_OFFICE_FORMAT=off → 显式退出，所有路由一律关闭", async () => {
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "off" }, "template", "agent"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "off" }, "generate", "agent"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "0" }, "template", "agent"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "false" }, "generate", "agent"), false);
});

await test("非写作路由（edit/read）→ 闸门不生效", async () => {
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "edit", "agent"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "read", "agent"), false);
});

await test("Chat / Review 只读模式 → 闸门不生效", async () => {
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "template", "chat"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "generate", "chat"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "template", "review"), false);
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "generate", "review"), false);
});

await test("办公兼容模式（office）与 agent 等价，仍通电", async () => {
  assert.equal(await gateWithEnv({ OAW_OFFICE_FORMAT: "" }, "template", "office"), true);
});

console.log("\n▶ 执行闸门（写作路由拦截绕过管线）");

const { classifyToolCall, isReadonlyBash, isMutatingOfficecli } = await load("server/office规范/执行闸门.mjs");

await test("写作路由 + 管线未产出：officecli 变更类命令被拦", () => {
  const ctx = { route: "template", officeFormat: true, pipelineProduced: false, clarificationPending: null, mode: "agent" };
  const gate = classifyToolCall({ tool: "officecli", input: { args: "add 报告.docx / --type markdown --prop src=ch1.md" }, context: ctx });
  assert.equal(gate.blocked, true, "管线产出前不应允许 add markdown");
  assert.ok(gate.code, "被拦时必须给错误码");
});

await test("bash 生成文档脚本在写作路由下被拦", () => {
  const ctx = { route: "template", officeFormat: true, pipelineProduced: false, clarificationPending: null, mode: "agent" };
  const gate = classifyToolCall({ tool: "bash", input: { command: "node gen.js" }, context: ctx });
  assert.equal(gate.blocked, true, "bash 生成脚本应被拦截");
});

await test("--allow-manual 逃逸阀：显式声明后放行", () => {
  const ctx = { route: "template", officeFormat: true, pipelineProduced: false, clarificationPending: null, mode: "agent" };
  const gate = classifyToolCall({ tool: "bash", input: { command: "node gen.js --allow-manual" }, context: ctx });
  assert.equal(gate.blocked, false, "显式 --allow-manual 应放行");
});

await test("Chat 模式：执行闸门完全放行", () => {
  const ctx = { route: "read", officeFormat: false, pipelineProduced: false, clarificationPending: null, mode: "chat" };
  const gate = classifyToolCall({ tool: "bash", input: { command: "node gen.js" }, context: ctx });
  assert.equal(gate.blocked, false);
});

await test("只读判定辅助：bash 只读命令与 officecli 变更命令", () => {
  assert.equal(isReadonlyBash("ls -la"), true);
  assert.equal(isReadonlyBash("cat notes.md"), true);
  assert.equal(isReadonlyBash("node gen.js"), false);
  assert.equal(isMutatingOfficecli("add 报告.docx / --type markdown --prop src=a.md"), true);
  assert.equal(isMutatingOfficecli("view 报告.docx text"), false);
  assert.equal(isMutatingOfficecli("get 报告.docx /body/p[1]"), false);
});

console.log("\n▶ 澄清闸门");

const { assessClarification, routeTaskIntent, planTaskCapabilities } = await load("server/task.mjs");

await test("缺 ≥2 项信息时提问，只问最阻塞的一项", () => {
  const result = assessClarification({ text: "写个报告", route: "template", template: { relPath: "t.md" }, scene: null });
  assert.equal(result.shouldAsk, true);
  assert.equal(result.missing.length >= 2, true, "应识别出多项缺失");
  assert.ok(result.question?.text, "必须给出问题文案");
  assert.ok(Array.isArray(result.question.options) && result.question.options.length > 0, "必须给出可选答案");
});

await test("信息齐备时不提问", () => {
  const text = "写一份面向主管部门的研究报告，3000字，用工作区的数据素材，风格正式严谨";
  const result = assessClarification({ text, route: "template", template: { relPath: "t.md" }, scene: null });
  assert.equal(result.shouldAsk, false, `不该提问，missing=${result.missing.join(",")}`);
});

await test("用户说「你看着办」时跳过提问并标注假设", () => {
  const result = assessClarification({ text: "写个报告，你看着办", route: "generate", template: null, scene: null });
  assert.equal(result.shouldAsk, false);
  assert.ok(result.assumption.includes("假设"), "必须说明按默认值处理");
});

console.log("\n▶ 写作工具书与能力计划");

await test("写作路由提示包含五步流程与样式禁令", () => {
  const { officeWritingHintFor } = { officeWritingHintFor: null };
  // officeWritingHint 不是导出项，通过 planTaskCapabilities 间接验证不了提示词；
  // 直接读源文件断言关键片段存在，避免提示词被静默删掉。
  const source = fs.readFileSync(path.join(ROOT, "server/task.mjs"), "utf8");
  assert.ok(source.includes("OFFICE_WRITING_PLAYBOOK"), "缺少写作工具书常量");
  assert.ok(source.includes("editorial_pipeline"), "提示词未提到编辑流水线");
  assert.ok(source.includes("raw-set"), "缺少样式禁令");
  assert.ok(source.includes("write→add"), "缺少 write→add 成对写入提示");
});

await test("officecli 工具描述含写作流程与错误速查", () => {
  const source = fs.readFileSync(path.join(ROOT, "server/agent.mjs"), "utf8");
  assert.ok(source.includes("WRITING PLAYBOOK"), "工具描述缺少写作流程");
  assert.ok(source.includes("STYLE BAN"), "工具描述缺少样式禁令");
  assert.ok(source.includes("Image file not found"), "工具描述缺少图片缺失速查");
  assert.ok(source.includes("Malformed XML"), "工具描述缺少 XML 损坏速查");
});

await test("能力计划：写作路由声明 editorial_pipeline 且状态为 preferred", () => {
  const plan = planTaskCapabilities({ text: "帮我写一份规划文本", task: { mode: "agent" } });
  assert.equal(plan.route, "template", `路由应为 template，实际 ${plan.route}`);
  const pipeline = plan.capabilities.find((item) => item.id === "editorial_pipeline");
  assert.ok(pipeline, "能力计划未声明 editorial_pipeline");
  assert.equal(pipeline.status, "preferred");
  assert.equal(pipeline.provider, "native");
});

await test("能力计划：Chat 模式不声明 editorial_pipeline（只读边界）", () => {
  const plan = planTaskCapabilities({ text: "帮我写一份规划文本", task: { mode: "chat" } });
  assert.equal(plan.route, "read", "Chat 不应进入写作路由");
  assert.equal(plan.capabilities.some((item) => item.id === "editorial_pipeline"), false);
});

await test("能力计划：写作路由 routing.officeFormat 为 auto", () => {
  const plan = planTaskCapabilities({ text: "帮我写一份规划文本", task: { mode: "agent" } });
  assert.equal(plan.routing.officeFormat, "auto");
});

await test("能力计划：编辑既有文档时 routing.officeFormat 为 off（不越界）", () => {
  const plan = planTaskCapabilities({
    text: "修改 报告.docx 的第三段",
    task: { mode: "agent" },
    references: [{ kind: "file", target: "报告.docx" }],
  });
  assert.equal(plan.routing.officeFormat, "off", `编辑路由不应通电，实际 ${plan.routing.officeFormat}`);
});

console.log("\n▶ bash 环境预检（N-08）");

const { probeBashAvailability, bashUnavailableError, bashEnvironmentHint, resetBashAvailabilityCache } = await load("server/环境能力.mjs");

await test("探测结果结构完整且带时间戳", () => {
  resetBashAvailabilityCache();
  const probe = probeBashAvailability();
  assert.equal(typeof probe.available, "boolean");
  assert.ok(probe.platform);
  assert.ok(probe.probedAt);
});

await test("探测结果被缓存（二次调用不再重探）", () => {
  resetBashAvailabilityCache();
  const first = probeBashAvailability();
  const second = probeBashAvailability();
  assert.equal(first.probedAt, second.probedAt, "同一次进程内不应重复探测");
});

await test("不可用时给出结构化错误与可执行建议", () => {
  const unavailable = bashUnavailableError();
  assert.equal(unavailable.code, "bash_unavailable");
  assert.ok(unavailable.message.includes("bash"), "错误文案应点明 bash");
  assert.ok(unavailable.suggestion.includes("officecli"), "建议应指向可用工具");
  assert.ok(unavailable.suggestion.includes("read"), "建议应指向可用工具");
});

await test("环境提示：不可用时提示改用其它工具，可用时为空", () => {
  const probe = probeBashAvailability();
  const hint = bashEnvironmentHint();
  if (probe.available) {
    assert.equal(hint, "", "可用时不应添加提示");
  } else {
    assert.ok(hint.includes("NOT available"), "不可用时应明确告知模型");
    assert.ok(hint.includes("Do not retry"), "不可用时应劝阻重试");
  }
});

await test("探测判据是「能否真的执行命令」而非 wsl --status（实测 --status 恒返回 0）", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "环境能力.mjs"), "utf8");
  assert.ok(!source.includes('"--status"'), "不能用 wsl.exe --status 判定：未装发行版时它也返回 0");
  assert.ok(source.includes("__oaw_probe__"), "应实际执行一次命令来判定可用性");
});

await test("探测失败原因不包含 UTF-16 乱码（模型看不懂）", () => {
  const probe = probeBashAvailability();
  if (!probe.available) {
    assert.ok(!/[\uFFFD]/.test(probe.reason), "原因文案不得含替换字符");
    assert.ok(probe.reason.length < 200, "原因文案应简短可读");
  }
});

console.log(failed ? "\n✗ 闸门通电测试存在失败项\n" : "\n✓ 闸门通电测试全部通过\n");
process.exit(failed ? 1 : 0);
