/**
 * OfficeCLI 自带检查接入（P0，计划 008 后续）。
 *
 * 只做两件事：
 *   1. `view <file> issues --json` 的 17 类规则结果归一化；
 *   2. `validate <file> --json` 的 OpenXML schema 校验结果归一化。
 *
 * 独立模块、不 import Pi 运行时：流水线与测试都可以安全引用。
 * officecli 不可用时返回 available:false，由调用方跳过，不阻断任务。
 */
import { spawn } from "node:child_process";
import { OFFICECLI } from "../workspace.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

function runCli(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(OFFICECLI, args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error?.message || error), json: null });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      if (!settled) {
        settled = true;
        resolve({ code: -1, stdout: out, stderr: `${err}\n超时（${timeoutMs}ms）`.trim(), json: null });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: -1, stdout: out, stderr: `${err}\n${e?.message || e}`.trim(), json: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let json = null;
      const text = out.trim();
      if (text.startsWith("{") || text.startsWith("[")) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      resolve({ code, stdout: out, stderr: err, json });
    });
  });
}

/** OfficeCLI `view issues` 的 severity：1 = 提示，>=2 = 错误；缺省按提示处理。 */
export function normalizeOfficeIssues(payload) {
  const list = Array.isArray(payload?.issues)
    ? payload.issues
    : Array.isArray(payload?.data?.issues)
      ? payload.data.issues
      : [];
  return list.map((item, index) => ({
    rule: `officecli_${item?.id || item?.type || index}`,
    severity: Number(item?.severity) >= 2 ? "error" : "warn",
    message: String(item?.message || item?.suggestion || "OfficeCLI issue").slice(0, 400),
    source: "officecli",
    path: item?.path || null,
  }));
}

/**
 * 运行 OfficeCLI 自带检查。
 * @param {string} file 绝对路径或相对 cwd 的路径
 * @param {{cwd?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{available:boolean, issues:Array, checks:string[]}>}
 */
export async function collectOfficeCliIssues(file, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const issuesResult = await runCli(["view", file, "issues", "--json"], { cwd, timeoutMs });
  if (issuesResult.code === -1) {
    return { available: false, issues: [], checks: [`officecli issues 跳过：${issuesResult.stderr.slice(0, 160)}`] };
  }
  const issues = normalizeOfficeIssues(issuesResult.json);
  const checks = [`officecli issues ${issues.length} 条`];

  const validateResult = await runCli(["validate", file, "--json"], { cwd, timeoutMs });
  if (validateResult.code === -1) {
    checks.push("officecli validate 跳过");
    await runCli(["close", file, "--json"], { cwd, timeoutMs });
    return { available: true, issues, checks };
  }
  if (Number(validateResult.code) === 0) {
    checks.push("officecli validate ok");
  } else {
    const warnings = Array.isArray(validateResult.json?.warnings) ? validateResult.json.warnings : [];
    const severity = Number(validateResult.code) === 2 ? "warn" : "error";
    issues.push({
      rule: "officecli_validate",
      severity,
      message: String(
        warnings.map((item) => item?.message || item).filter(Boolean).join("；")
        || validateResult.stderr
        || validateResult.stdout
        || `OpenXML schema 校验退出码 ${validateResult.code}`,
      ).slice(0, 400),
      source: "officecli",
    });
    checks.push(`officecli validate 退出码 ${validateResult.code}`);
  }
  // 释放 resident，避免调用方的临时目录清理被占用。
  await runCli(["close", file, "--json"], { cwd, timeoutMs });
  return { available: true, issues, checks };
}
