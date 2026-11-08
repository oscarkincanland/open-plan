/**
 * 技能依赖安装（2026-11-08，D1；计划 2026-11-08-001 §9）
 *
 * 硬规则：
 *   - 只能由用户在技能广场/设置里显式确认触发，Agent 不得自动调用；
 *   - 只安装到 `<workspace>/.oaw/skill-deps/<skill>/`（隔离 venv / node_modules）；
 *   - 不写系统 Python、全局 npm、用户 home；不执行 npm 的 postinstall（--ignore-scripts）；
 *   - 复用 `.oaw/jobs` 后台任务机制：有 jobId、进度日志、超时、可取消；
 *   - 安装结果写 manifest.json（技能、包、解释器、镜像、时间），供只读预检与卸载使用。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createJob, appendJobOutput, finishJob, publicJob, getJob } from "./后台任务.mjs";
import {
  parseRequires,
  findExecutable,
  resolvePython,
  skillDepsDir,
  skillVenvPython,
  writeManifest,
  readManifest,
  removeSkillDeps,
} from "./技能依赖.mjs";

const INSTALL_TIMEOUT_MS = Math.max(30_000, Number.parseInt(process.env.OAW_SKILL_INSTALL_TIMEOUT_MS || "600000", 10) || 600_000);
const active = new Map(); // jobId -> { child, abort }

/** 默认命令执行器（生产路径）：流式输出 + 超时 + 可取消。 */
export function defaultInstallRunner(command, args, { cwd = "", onData = null, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish({ exitCode: 124, timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      });
    } catch (error) {
      finish({ exitCode: 1, error: String(error?.message || error) });
      return;
    }
    child.stdout?.on("data", (chunk) => onData?.(String(chunk)));
    child.stderr?.on("data", (chunk) => onData?.(String(chunk)));
    child.on("error", (error) => finish({ exitCode: 1, error: String(error?.message || error) }));
    child.on("close", (code) => finish({ exitCode: code ?? 1 }));
  });
}

function emitStep(onEvent, step, status, detail = "") {
  try { onEvent?.({ type: "step", step, status, detail }); } catch {}
}

function describeRequires(requires) {
  return {
    python: requires?.python || [],
    npm: requires?.npm || [],
    runtime: requires?.runtime || [],
    exec: requires?.exec || [],
    install: requires?.install || { python: "", npm: "" },
  };
}

/**
 * 启动安装 job。
 * @param {{skill:object, workspace:string, runId?:string, threadId?:string, mirror?:string, onEvent?:Function, runner?:Function}} input
 * @returns {{ok:boolean, jobId?:string, dir?:string, error?:string, code?:string}}
 */
export function startSkillDepsInstall({
  skill = null,
  workspace = "",
  runId = "",
  threadId = "",
  mirror = "",
  onEvent = null,
  runner = defaultInstallRunner,
  pythonOverride = "",
  npmOverride = "",
} = {}) {
  const name = String(skill?.name || "").trim();
  if (!name) return { ok: false, error: "缺少技能名", code: "SKILL_INVALID" };
  if (!workspace) return { ok: false, error: "缺少工作区", code: "SKILL_INVALID" };
  const requires = parseRequires(skill.requiresText || "", skill.installText || "");
  if (!requires) return { ok: false, error: "该技能没有声明 requires，无需安装", code: "SKILL_DEPS_NONE" };

  const dir = skillDepsDir(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  const job = createJob({
    runId: runId || `skill_${path.basename(dir)}`,
    threadId,
    kind: "skill_deps",
    command: `install skill deps: ${name}`,
    cwd: workspace,
    mutating: true,
  });
  const state = { child: null, aborted: false };
  active.set(job.jobId, state);
  const write = (text) => {
    if (!text) return;
    appendJobOutput(job, text);
    try { onEvent?.({ type: "output", text }); } catch {}
  };
  const track = (child) => { state.child = child; };

  const promise = (async () => {
    emitStep(onEvent, "start", "running", `安装目录：${dir}`);
    write(`[install] skill=${name} dir=${dir}\n`);
    const summary = describeRequires(requires);
    const installed = { python: [], npm: [], mirror: mirror || "", startedAt: new Date().toISOString() };

    try {
      // ---- Python ----
      const needsPython = requires.runtime.some((item) => item.kind === "python") || requires.python.length > 0 || requires.exec.includes("python");
      if (needsPython) {
        const python = pythonOverride
          ? { path: pythonOverride, source: "override" }
          : resolvePython({ workspace, skillName: name });
        if (!python) {
          throw Object.assign(new Error("缺少 Python 运行时（未找到 python/python3）"), { code: "SKILL_DEP_RUNTIME_MISSING" });
        }
        const venvDir = path.join(dir, ".venv");
        const venvPython = skillVenvPython(workspace, name);
        if (!fs.existsSync(venvPython)) {
          emitStep(onEvent, "venv", "running", `创建隔离 venv：${venvDir}`);
          write(`[venv] ${python.path} -m venv .venv\n`);
          const result = await runner(python.path, ["-m", "venv", venvDir], { cwd: workspace, onData: write, timeoutMs: 180_000 });
          if (result.exitCode !== 0) {
            throw Object.assign(new Error(`创建 venv 失败（exit ${result.exitCode}）${result.error ? `：${result.error}` : ""}`), { code: "SKILL_DEP_VENV_FAILED" });
          }
        }
        emitStep(onEvent, "venv", "done", venvPython);

        const pipArgs = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input"];
        if (mirror) pipArgs.push("--index-url", mirror);
        // skill.path 在 Agent 目录项里指向 SKILL.md；在 /api/skills 投影里指向技能目录，两种都要兼容。
        const skillRoot = skill.path && /SKILL\.md$/i.test(String(skill.path))
          ? path.dirname(skill.path)
          : String(skill.path || "");
        const requirementsFile = requires.install?.python
          ? path.resolve(skillRoot, requires.install.python)
          : "";
        const hasRequirementsFile = requirementsFile && fs.existsSync(requirementsFile);
        if (hasRequirementsFile) pipArgs.push("-r", requirementsFile);
        if (requires.python.length) pipArgs.push(...requires.python);
        if (hasRequirementsFile || requires.python.length) {
          emitStep(onEvent, "python-packages", "running", `安装 ${requires.python.length || "requirements.txt"} 个 Python 依赖`);
          write(`[pip] ${pipArgs.join(" ")}\n`);
          const result = await runner(venvPython, pipArgs, { cwd: workspace, onData: write, timeoutMs: INSTALL_TIMEOUT_MS });
          if (result.exitCode !== 0) {
            throw Object.assign(new Error(`pip 安装失败（exit ${result.exitCode}）`), { code: "SKILL_DEP_INSTALL_FAILED" });
          }
          installed.python = requires.python.slice();
          emitStep(onEvent, "python-packages", "done", `${installed.python.length} 个包`);
        }
      }

      // ---- npm ----
      if (requires.npm.length) {
        const npm = npmOverride || findExecutable("npm");
        if (!npm) throw Object.assign(new Error("缺少 npm"), { code: "SKILL_DEP_RUNTIME_MISSING" });
        const npmArgs = ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund"];
        if (mirror) npmArgs.push(`--registry=${mirror}`);
        npmArgs.push(...requires.npm);
        emitStep(onEvent, "npm-packages", "running", `安装 ${requires.npm.length} 个 npm 依赖`);
        write(`[npm] ${npmArgs.join(" ")}\n`);
        const result = await runner(npm, npmArgs, { cwd: workspace, onData: write, timeoutMs: INSTALL_TIMEOUT_MS });
        if (result.exitCode !== 0) {
          throw Object.assign(new Error(`npm 安装失败（exit ${result.exitCode}）`), { code: "SKILL_DEP_INSTALL_FAILED" });
        }
        installed.npm = requires.npm.slice();
        emitStep(onEvent, "npm-packages", "done", `${installed.npm.length} 个包`);
      }

      if (state.aborted) throw Object.assign(new Error("安装已取消"), { code: "SKILL_DEP_INSTALL_CANCELLED" });

      const manifest = {
        status: "ready",
        installedAt: new Date().toISOString(),
        python: installed.python,
        npm: installed.npm,
        runtime: summary.runtime,
        mirror: installed.mirror,
        dir,
        jobId: job.jobId,
      };
      writeManifest(workspace, name, manifest);
      write(`[manifest] ${JSON.stringify(manifest)}\n`);
      finishJob(job, { status: "completed", exitCode: 0, summary: `installed ${installed.python.length + installed.npm.length} packages` });
      emitStep(onEvent, "done", "completed", JSON.stringify(manifest));
      try { onEvent?.({ type: "finished", status: "completed", manifest }); } catch {}
    } catch (error) {
      const code = error?.code || "SKILL_DEP_INSTALL_FAILED";
      const message = String(error?.message || error);
      write(`[error] ${code}: ${message}\n`);
      try {
        writeManifest(workspace, name, { status: "failed", error: message, code, dir, jobId: job.jobId });
      } catch {}
      finishJob(job, { status: state.aborted ? "cancelled" : "failed", exitCode: 1, error: message });
      emitStep(onEvent, "done", state.aborted ? "cancelled" : "failed", message);
      try { onEvent?.({ type: "finished", status: state.aborted ? "cancelled" : "failed", error: message, code }); } catch {}
    } finally {
      active.delete(job.jobId);
    }
  })();

  return { ok: true, jobId: job.jobId, dir, promise };
}

/** 取消安装（jobId）。 */
export function cancelSkillDepsInstall(jobId = "") {
  const state = active.get(String(jobId || ""));
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "job 不存在或已结束" };
  if (state) {
    state.aborted = true;
    try { state.child?.kill(); } catch {}
  }
  finishJob(job, { status: "cancelled", exitCode: 130, error: "用户取消安装" });
  return { ok: true };
}

/** 安装 job 的公开快照（供 UI 轮询）。 */
export function skillInstallJob(jobId = "") {
  return publicJob(getJob(jobId));
}

/** 卸载工作区内的技能依赖。 */
export function uninstallSkillDeps({ workspace = "", name = "", confirm = false } = {}) {
  if (confirm !== true) return { ok: false, error: "卸载需要 confirm=true", code: "SKILL_DEPS_CONFIRM_REQUIRED" };
  const result = removeSkillDeps(workspace, name);
  return result.removed
    ? { ok: true, dir: result.dir }
    : { ok: false, error: result.reason || "卸载失败", code: "SKILL_DEPS_UNINSTALL_FAILED" };
}

export { readManifest };
