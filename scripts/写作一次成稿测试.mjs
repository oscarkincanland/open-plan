#!/usr/bin/env node
/**
 * 写作一次成稿测试（计划 2026-11-08-001 §12 / ADR-0028，D4）。
 *
 * 覆盖：
 *   1. flag 门控：writingOneShot 关闭时 playbook / 澄清最小集 / 思考档位与基线逐字一致；
 *      打开时切换为「一次成稿 → sourceMarkdown 直通 → batch 排版 → 一次验收」。
 *   2. 写作路由 playbook 文案：一次成稿、不先出大纲、Markdown 直通、预览即终稿、一次验收。
 *   3. officecli 工具描述：batch 批量下发（禁止逐属性 set）、一次验收；错误处理与安全规则保留。
 *   4. 澄清最小集：只含阻塞项（文档类型/产物格式/必须包含的数据/覆盖范围），
 *      篇幅/受众/风格不再进入缺失集。
 *   5. 思考档位：写作路由在开关打开且用户未显式指定时默认 medium，不覆盖用户显式档位。
 *   6. 编辑流水线：开关打开时忽略 autoClarify；sourceMarkdown 直通（跳过 Planner/Writer）可用。
 *   7. 执行闸门：D1 的技能白名单与收窄后的 Office 生成判定保持，不放宽 write/edit 写 Office 二进制拦截。
 *   8. 回归：串行跑既有写作相关测试脚本。
 *
 * 用法: node scripts/写作一次成稿测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const TASK_SOURCE = read("server/task.mjs");
const AGENT_SOURCE = read("server/agent.mjs");
const PIPELINE_SOURCE = read("server/编辑流水线.mjs");
const GATE_SOURCE = read("server/office规范/执行闸门.mjs");

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (error) => {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  },
);

/**
 * 子进程加载真实模块：RUNTIME_FLAGS 在模块加载时读取 env，因此开/关两组行为
 * 必须用独立子进程验证（与 Office写作闸门通电测试 同一模式）。
 *
 * 注意：本机沙箱禁止子进程管道 stdio，因此结果通过临时文件回传（stdio: "ignore"）。
 */
function runChild(script, env = {}) {
  const outFile = path.join(os.tmpdir(), `oaw-oneshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "ignore",
      env: { ...process.env, ...env, OAW_TEST_OUT: outFile },
      timeout: 120000,
    });
    if (!fs.existsSync(outFile)) {
      throw new Error(`子进程未产出结果（exit ${result.status}，signal ${result.signal || "无"}）`);
    }
    const output = JSON.parse(fs.readFileSync(outFile, "utf8"));
    if (output && output.error) throw new Error(`子进程脚本失败：${output.error}`);
    return output;
  } finally {
    try { fs.rmSync(outFile, { force: true }); } catch {}
  }
}

const taskProbeScript = (props) => `
  import fs from "node:fs";
  import { taskSummary, missingInfoFields, assessClarification, resolveWritingThinkingLevel } from ${JSON.stringify(url("server/task.mjs"))};
  let output;
  try {
    const task = ${JSON.stringify(props)};
    const text = "帮我写个文档";
    output = {
      summary: taskSummary(task),
      templateSummary: taskSummary(${JSON.stringify({ capabilityPlan: { route: "template", template: { relPath: "templates/traffic-material/04_工程可行性研究报告模板.md" }, scene: { label: "可行性研究" } } })}),
      missing: missingInfoFields({ text, route: "generate" }),
      clarify: assessClarification({ text, route: "generate" }),
      thinking: {
        default: resolveWritingThinkingLevel({ route: "generate", mode: "agent" }),
        explicitHigh: resolveWritingThinkingLevel({ effort: "high", route: "generate", mode: "agent" }),
        explicitDefault: resolveWritingThinkingLevel({ effort: "default", route: "generate", mode: "agent" }),
        readRoute: resolveWritingThinkingLevel({ route: "read", mode: "agent" }),
        chatMode: resolveWritingThinkingLevel({ route: "generate", mode: "chat" }),
      },
    };
  } catch (error) {
    output = { error: String(error?.stack || error) };
  }
  fs.writeFileSync(process.env.OAW_TEST_OUT, JSON.stringify(output));
`;

const OFF_ENV = { OAW_WRITING_ONESHOT: "0" };
const ON_ENV = { OAW_WRITING_ONESHOT: "1" };
const generateTask = { capabilityPlan: { route: "generate", scene: { label: "汇报材料" } } };

/* ============================ 1. 静态接线：flag 门控 ============================ */
console.log("\n▶ flag 门控（静态接线）");

await test("task.mjs：writingOneShot 门控 playbook / 澄清最小集 / 写作思考档位", () => {
  assert.ok(/RUNTIME_FLAGS\.writingOneShot/.test(TASK_SOURCE), "task.mjs 应引用 writingOneShot");
  assert.ok(TASK_SOURCE.includes("function officeWritingPlaybookOneShot("), "缺少一次成稿 playbook 分支");
  assert.ok(TASK_SOURCE.includes("if (RUNTIME_FLAGS.writingOneShot) return officeWritingPlaybookOneShot();"), "playbook 分支应被 flag 门控");
  assert.ok(TASK_SOURCE.includes("export function isWritingRoute("), "缺少写作路由判定");
  assert.ok(TASK_SOURCE.includes("export function resolveWritingThinkingLevel("), "缺少写作思考档位判定");
  assert.ok(/if \(RUNTIME_FLAGS\.writingOneShot\) \{[\s\S]{0,900}missing\.push\("format"\)/.test(TASK_SOURCE), "澄清最小集应在 flag 内计算阻塞项");
  assert.ok(TASK_SOURCE.includes('id: "format"') && TASK_SOURCE.includes('id: "scope"'), "缺少产物格式/覆盖范围字段");
});

await test("agent.mjs：写作提示词与 officecli 描述均按 flag 分支，默认保留基线文案", () => {
  assert.ok(/\.\.\.\(RUNTIME_FLAGS\.writingOneShot \? \[[\s\S]{0,1600}写作一次成稿（D4，已开启）/.test(AGENT_SOURCE), "写作提示词块应只在开关打开时注入");
  assert.ok(AGENT_SOURCE.includes("officecliWritingPlaybook"), "officecli 描述应走一次性成稿 playbook 变量");
  assert.ok(AGENT_SOURCE.includes("写报告/规划文本/公文时的标准五步流程"), "关闭分支应保留基线五步流程");
  assert.ok(AGENT_SOURCE.includes("resolveWritingThinkingLevel("), "思考档位应复用 task.mjs 判定");
  assert.ok(AGENT_SOURCE.includes("autoClarify: RUNTIME_FLAGS.officeFormat && !RUNTIME_FLAGS.writingOneShot"), "编辑流水线调用应在开关打开时关闭 autoClarify");
});

await test("编辑流水线.mjs：flag 内默认不做澄清，sourceMarkdown 直通为默认推荐", () => {
  assert.ok(PIPELINE_SOURCE.includes("RUNTIME_FLAGS.writingOneShot"), "编辑流水线应读取 writingOneShot");
  assert.ok(PIPELINE_SOURCE.includes("effectiveAutoClarify"), "应计算 effectiveAutoClarify");
  assert.ok(/const effectiveAutoClarify = autoClarify && !oneShot;/.test(PIPELINE_SOURCE), "开关打开时 autoClarify 应被忽略");
  assert.ok(PIPELINE_SOURCE.includes("sourceMarkdown 直通"), "应保留 sourceMarkdown 直通说明");
});

await test("执行闸门.mjs：D1 技能白名单与 Office 生成判定保持，不因 D4 放宽", () => {
  assert.ok(GATE_SOURCE.includes("OFFICE_BINARY"), "缺少 Office 二进制识别");
  assert.ok(GATE_SOURCE.includes("DOCX_GENERATION"), "缺少收窄后的 Office 生成判定");
  assert.ok(GATE_SOURCE.includes("referencesSkillScript"), "缺少 D1 技能脚本白名单");
  assert.ok(GATE_SOURCE.includes("WRITE_INDICATORS"), "缺少 write/edit 写 Office 二进制拦截");
  assert.equal(GATE_SOURCE.includes("writingOneShot"), false, "执行闸门不应由 D4 开关改变拦截范围");
});

/* ============================ 2. 动态：flag 关闭 = 基线 ============================ */
console.log("\n▶ flag 关闭：与基线一致（子进程真实加载模块）");

const off = runChild(taskProbeScript(generateTask), OFF_ENV);

await test("关闭时 playbook 仍是基线六步（不出现一次成稿文案）", () => {
  assert.ok(off.summary.includes("写作流程（按序执行）"));
  assert.ok(off.summary.includes("Planner→Writer→Formatter"));
  assert.ok(off.summary.includes("write→add 成对出现"));
  assert.equal(off.summary.includes("写作流程（一次成稿"), false);
});

await test("关闭时澄清最小集包含篇幅/受众/风格（基线口径）", () => {
  for (const id of ["length", "audience", "style"]) assert.ok(off.missing.includes(id), `缺失集应含 ${id}`);
  assert.equal(off.clarify.question?.field, "length");
});

await test("关闭时思考档位维持基线 default（不强制 medium）", () => {
  assert.equal(off.thinking.default, "default");
  assert.equal(off.thinking.explicitHigh, "high");
});

/* ============================ 3. 动态：flag 打开 = 一次成稿 ============================ */
console.log("\n▶ flag 打开：一次成稿（子进程真实加载模块）");

const on = runChild(taskProbeScript(generateTask), ON_ENV);

await test("playbook 切换为一次成稿 + Markdown 直通 + batch + 一次验收", () => {
  assert.ok(on.summary.includes("写作流程（一次成稿"));
  assert.ok(on.summary.includes("不先出独立大纲"));
  assert.ok(on.summary.includes("sourceMarkdown 直通"));
  assert.ok(on.summary.includes("batch 批量下发"));
  assert.ok(on.summary.includes("禁止逐属性 set"));
  assert.ok(on.summary.includes("预览即终稿"));
  assert.ok(on.summary.includes("一次验收"));
  assert.ok(on.summary.includes("只跑一遍"));
  assert.equal(on.summary.includes("写作流程（按序执行）"), false);
  assert.equal(on.summary.includes("write→add 成对出现"), false);
});

await test("模板路由提示改为“先读模板/素材后一次成稿”", () => {
  assert.ok(on.templateSummary.includes("先读取模板/素材"));
  assert.ok(on.templateSummary.includes("写作流程（一次成稿"));
});

await test("不再有“是否继续/下一步/是否写回”类收尾提问（仅保留禁令）", () => {
  const text = on.summary;
  assert.equal(/是否继续[？?]/.test(text), false);
  assert.equal(/是否写回[？?]/.test(text), false);
  assert.equal(/请(?:用户)?确认是否/.test(text), false);
  assert.equal(/下一步[：:]/.test(text), false);
  assert.ok(text.includes("不要问“是否继续/下一步/是否写回”"), "应显式禁止收尾确认提问");
});

await test("澄清最小集只含阻塞项：类型/格式/数据来源/覆盖范围", () => {
  const blocking = new Set(["type", "format", "source", "scope"]);
  assert.ok(on.missing.length > 0, "示例文本应缺阻塞项");
  for (const id of on.missing) assert.ok(blocking.has(id), `非阻塞项不应进入缺失集：${id}`);
  for (const id of ["length", "audience", "style"]) assert.equal(on.missing.includes(id), false, `${id} 不应再计入缺失`);
  assert.equal(on.clarify.shouldAsk, true);
  assert.equal(on.clarify.question.field, "format", "缺 ≥2 项时应只问第一个阻塞项");
});

await test("写作路由默认 thinking=medium，且不覆盖用户显式档位", () => {
  assert.equal(on.thinking.default, "medium");
  assert.equal(on.thinking.explicitDefault, "medium");
  assert.equal(on.thinking.explicitHigh, "high");
  assert.equal(on.thinking.readRoute, "default");
  assert.equal(on.thinking.chatMode, "default");
});

/* ============================ 4. 动态：编辑流水线一次成稿 ============================ */
console.log("\n▶ 编辑流水线：一次成稿默认不做澄清 + sourceMarkdown 直通");

const pipelineProbeScript = `
  import fs from "node:fs";
  import os from "node:os";
  import path from "node:path";
  import { runEditorialPipeline } from ${JSON.stringify(url("server/编辑流水线.mjs"))};
  let output;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-oneshot-"));
  try {
    const markdown = "# 测试报告\\n\\n## 一、背景\\n\\n这是正文内容，长度足够用于中文首行缩进检查。";
    let modelCalls = 0;
    const result = await runEditorialPipeline({
      format: "docx",
      goal: "写个文档",
      workspace,
      autoClarify: true,
      sourceMarkdown: markdown,
      modelReview: false,
      runModelTask: async () => { modelCalls += 1; throw new Error("一次成稿不应调用模型"); },
    });
    output = {
      status: result.status,
      deliverable: result.deliverable,
      source: result.source || null,
      modelCalls,
      exists: result.deliverable ? fs.existsSync(path.join(workspace, result.deliverable)) : false,
    };
  } catch (error) {
    output = { error: String(error?.stack || error) };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  fs.writeFileSync(process.env.OAW_TEST_OUT, JSON.stringify(output));
`;

const pipelineOn = runChild(pipelineProbeScript, ON_ENV);

await test("开启：autoClarify=true 被忽略，sourceMarkdown 直通完成且不调用模型", () => {
  assert.equal(pipelineOn.status, "completed");
  assert.equal(pipelineOn.source, "markdown");
  assert.equal(pipelineOn.modelCalls, 0);
  assert.equal(pipelineOn.exists, true);
});

const pipelineOff = runChild(pipelineProbeScript, OFF_ENV);

await test("关闭：同一调用仍走澄清闸门（needs_clarification，与基线一致）", () => {
  assert.equal(pipelineOff.status, "needs_clarification");
  assert.equal(pipelineOff.deliverable, null);
});

/* ============================ 5. officecli 描述：batch 指引与安全规则 ============================ */
console.log("\n▶ officecli 工具描述（一次成稿分支）");

await test("一次成稿分支：样式用一次 batch、禁止逐属性 set、一次验收", () => {
  assert.ok(AGENT_SOURCE.includes("apply ALL style/format changes in ONE 'batch' command"));
  assert.ok(AGENT_SOURCE.includes("NEVER run one 'set' per attribute"));
  assert.ok(AGENT_SOURCE.includes("batches of at most 5"));
  assert.ok(AGENT_SOURCE.includes("run exactly ONE acceptance pass"));
  assert.ok(AGENT_SOURCE.includes("do not start extra revision rounds"));
});

await test("错误处理与安全规则保留（关闭分支与公共段落不删）", () => {
  for (const marker of ["STRICT RULES (avoid wasted retries)", "STYLE BAN", "KNOWN ERRORS (avoid loops)", "Prefer this tool over bash for all document operations"]) {
    assert.ok(AGENT_SOURCE.includes(marker), `应保留安全/错误规则：${marker}`);
  }
  assert.ok(/STEP 4 run exactly ONE acceptance pass/.test(AGENT_SOURCE));
});

/* ============================ 6. 回归：既有写作相关测试 ============================ */
if (String(process.env.OAW_ONESHOT_REGRESSION || "") !== "0") {
  console.log("\n▶ 回归：既有写作相关测试（串行）");
  const regression = [
    "Office路由与澄清测试.mjs",
    "Office澄清闸门测试.mjs",
    "Office生成回归测试.mjs",
    "Office验收规则测试.mjs",
    "编辑流水线测试.mjs",
    "Office写作契约回归测试.mjs",
  ];
  for (const name of regression) {
    console.log(`\n-- ${name}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit" });
    if (result.status !== 0) {
      failed = 1;
      console.error(`✗ ${name} 失败（exit ${result.status}）`);
    }
  }
}

console.log(failed ? "\n写作一次成稿测试：存在失败" : "\n写作一次成稿测试：全部通过");
process.exitCode = failed ? 1 : 0;
