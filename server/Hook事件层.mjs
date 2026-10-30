/**
 * Hook 声明式事件层（H3-1）
 *
 * 先支持 4 个高价值事件：UserPromptSubmit / PreToolUse / PostToolUse / Stop。
 * 安全约束（重要）：
 *   - 默认关闭（OAW_HOOK_EVENTS）；
 *   - 只允许用 node 执行工作区内脚本，不经过 shell，不允许 -e；
 *   - 超时杀进程、输出上限、声明哈希；可选信任三态。
 *
 * 本模块不修改 Pi 内核；调用方在对应时机 dispatch。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./持久化工具.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024;

export const HOOK_EVENTS = Object.freeze(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
export const HOOK_EVENT_SET = new Set(HOOK_EVENTS);

export function hookConfigPath(workspace) {
  return path.join(String(workspace || "."), ".oaw", "hooks.json");
}

export function hookTrustPath(workspace) {
  return path.join(String(workspace || "."), ".oaw", "hooks-trust.json");
}

function userHookConfigPath() {
  return process.env.OAW_USER_HOOKS_FILE || path.join(os.homedir(), ".open-plan", "hooks.json");
}

function readConfigFile(file) {
  const value = readJsonFile(file, null);
  if (!value || typeof value !== "object") return { version: 1, hooks: [], requireTrust: false };
  return {
    version: Number(value.version) || 1,
    requireTrust: value.requireTrust === true,
    hooks: Array.isArray(value.hooks) ? value.hooks : [],
  };
}

/** 合并用户级与工作区级配置；工作区同名 hook id 覆盖用户级。 */
export function loadHookConfig({ workspace, userFile = userHookConfigPath() } = {}) {
  const user = readConfigFile(userFile);
  const local = readConfigFile(hookConfigPath(workspace));
  const byId = new Map();
  for (const hook of user.hooks) {
    const id = String(hook?.id || hook?.script || hook?.command || crypto.randomUUID());
    byId.set(id, { ...hook, id, source: "user" });
  }
  for (const hook of local.hooks) {
    const id = String(hook?.id || hook?.script || hook?.command || crypto.randomUUID());
    byId.set(id, { ...hook, id, source: "workspace" });
  }
  const hooks = [...byId.values()];
  const errors = [];
  for (const hook of hooks) {
    if (!HOOK_EVENT_SET.has(hook.event)) errors.push(`${hook.id}: 未知事件 ${hook.event}`);
    if (hook.enabled === false) continue;
    if (!hook.script && !hook.command) errors.push(`${hook.id}: 缺少 script/command`);
  }
  return { version: 1, requireTrust: local.requireTrust || user.requireTrust, hooks, errors, userFile, localFile: hookConfigPath(workspace) };
}

export function hookDeclarationHash(hook = {}) {
  const source = JSON.stringify({
    event: hook.event || "",
    script: hook.script || "",
    command: hook.command || "",
    args: Array.isArray(hook.args) ? hook.args : [],
    matcher: hook.matcher || null,
  });
  return crypto.createHash("sha256").update(source).digest("hex");
}

function loadTrust(workspace) {
  const value = readJsonFile(hookTrustPath(workspace), null);
  return value && typeof value === "object" && value.hashes && typeof value.hashes === "object" ? value : { version: 1, hashes: {} };
}

export function hookTrustState(hook, workspace) {
  const trust = loadTrust(workspace);
  const hash = hookDeclarationHash(hook);
  const trusted = trust.hashes[hook.id] === hash;
  return { trusted, hash, expected: trust.hashes[hook.id] || null, state: trusted ? "trusted" : (trust.hashes[hook.id] ? "revoked" : "pending") };
}

export function trustHook(hook, workspace) {
  const trust = loadTrust(workspace);
  trust.hashes[hook.id] = hookDeclarationHash(hook);
  trust.updatedAt = new Date().toISOString();
  ensureDirectory(path.dirname(hookTrustPath(workspace)));
  atomicWriteJson(hookTrustPath(workspace), trust);
  return hookTrustState(hook, workspace);
}

export function revokeHook(hook, workspace) {
  const trust = loadTrust(workspace);
  delete trust.hashes[hook.id];
  trust.updatedAt = new Date().toISOString();
  ensureDirectory(path.dirname(hookTrustPath(workspace)));
  atomicWriteJson(hookTrustPath(workspace), trust);
  return hookTrustState(hook, workspace);
}

function matches(pattern, value) {
  if (!pattern) return true;
  try {
    return new RegExp(String(pattern), "i").test(String(value || ""));
  } catch {
    return false;
  }
}

export function hookMatches(hook, payload = {}) {
  const matcher = hook?.matcher && typeof hook.matcher === "object" ? hook.matcher : {};
  if (matcher.tool && !matches(matcher.tool, payload.tool)) return false;
  if (matcher.input && !matches(matcher.input, payload.inputText ?? payload.input)) return false;
  if (matcher.path && !matches(matcher.path, payload.path)) return false;
  return true;
}

function resolveScript(hook, workspace) {
  const raw = String(hook.script || hook.args?.[0] || "").trim();
  if (!raw) throw new Error("Hook 缺少 script");
  const root = path.resolve(workspace || ".");
  const target = path.resolve(root, raw);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Hook 脚本必须位于当前工作区内");
  if (!/\.(?:[cm]?[jt]s)$/i.test(target)) throw new Error("Hook 脚本必须是 .js/.mjs/.cjs/.ts 文件");
  if (!fs.existsSync(target)) throw new Error(`Hook 脚本不存在：${raw}`);
  return target;
}

function resolveCommand(hook, workspace) {
  // command 只允许 "node" + 工作区内脚本；不允许 -e / shell 元字符。
  const command = String(hook.command || "").trim();
  if (!command) return null;
  if (!/^(?:node|node\.exe)$/i.test(command)) throw new Error("Hook command 只允许 node");
  const args = Array.isArray(hook.args) ? hook.args.map(String) : [];
  if (!args.length) throw new Error("Hook command 缺少脚本参数");
  if (args.some((arg) => arg === "-e" || arg === "--eval")) throw new Error("Hook 禁止 -e/--eval");
  const script = args[0];
  const target = resolveScript({ script }, workspace);
  return { executable: process.execPath, args: [target, ...args.slice(1)] };
}

function parseHookOutput(text) {
  const source = String(text || "").trim();
  if (!source) return { behavior: "allow" };
  try {
    const parsed = JSON.parse(source);
    const behavior = String(parsed.behavior || "").toLowerCase();
    if (behavior === "deny") return { behavior: "deny", message: String(parsed.message || "").slice(0, 1000) };
    if (behavior === "allow" || behavior === "") {
      return {
        behavior: "allow",
        message: parsed.message ? String(parsed.message).slice(0, 1000) : undefined,
        updatedInput: parsed.updatedInput,
        permissionUpdates: parsed.permissionUpdates,
      };
    }
    return { behavior: "allow", warning: `未知 behavior：${behavior}` };
  } catch {
    return { behavior: "allow", warning: "Hook 输出不是 JSON，按 allow 处理" };
  }
}

/**
 * 执行单个 Hook。
 * @returns {Promise<{behavior:"allow"|"deny", message?:string, updatedInput?:any, output?:string, error?:string}>}
 */
export async function runHook(hook, payload = {}, { workspace, timeoutMs = 3000 } = {}) {
  const command = resolveCommand(hook, workspace);
  const script = command ? null : resolveScript(hook, workspace);
  const args = command ? command.args : (Array.isArray(hook.args) ? hook.args.map(String) : []);
  const executable = command ? command.executable : process.execPath;
  const finalArgs = command ? args : [script, ...args];
  const input = JSON.stringify(payload ?? {});
  try {
    const { stdout } = await execFileAsync(executable, finalArgs, {
      cwd: path.resolve(workspace || "."),
      timeout: Math.max(100, Number(timeoutMs) || 3000),
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { ...process.env, OAW_HOOK_EVENT: String(payload.event || ""), OAW_HOOK_PAYLOAD: input },
    });
    const parsed = parseHookOutput(stdout);
    return { ...parsed, output: String(stdout || "").slice(0, 4000) };
  } catch (error) {
    const timedOut = error?.killed || error?.signal === "SIGTERM" || /timed?\s*out/i.test(String(error?.message || ""));
    return {
      behavior: "allow",
      error: timedOut ? "hook_timeout" : `hook_failed: ${String(error?.message || error).slice(0, 300)}`,
    };
  }
}

/**
 * 按事件派发所有匹配的 Hook；任一 deny 立即短路。
 * @returns {Promise<{behavior:"allow"|"deny", reason?:string, hookId?:string, messages:string[], updatedInput?:any, results:Array}>}
 */
export async function dispatchHooks({
  event,
  payload = {},
  workspace,
  config = null,
  timeoutMs = 3000,
  runner = runHook,
} = {}) {
  const name = String(event || "");
  if (!HOOK_EVENT_SET.has(name)) return { behavior: "allow", messages: [], results: [], reason: "unknown_event" };
  const cfg = config || loadHookConfig({ workspace });
  const hooks = (cfg.hooks || []).filter((hook) => hook.enabled !== false && hook.event === name && hookMatches(hook, payload));
  const results = [];
  const messages = [];
  let updatedInput;
  for (const hook of hooks) {
    if (cfg.requireTrust) {
      const trust = hookTrustState(hook, workspace);
      if (!trust.trusted) {
        results.push({ hookId: hook.id, behavior: "deny", error: `hook_${trust.state}`, hash: trust.hash });
        return { behavior: "deny", reason: `Hook ${hook.id} 未授信（${trust.state}）`, hookId: hook.id, messages, results };
      }
    }
    let outcome;
    try {
      outcome = await runner(hook, { ...payload, event: name }, { workspace, timeoutMs: Number(hook.timeoutMs) || timeoutMs });
    } catch (error) {
      outcome = { behavior: "allow", error: `hook_dispatch_failed: ${String(error?.message || error).slice(0, 300)}` };
    }
    results.push({ hookId: hook.id, ...outcome });
    if (outcome.message) messages.push(outcome.message);
    if (outcome.updatedInput && typeof outcome.updatedInput === "object") updatedInput = outcome.updatedInput;
    if (outcome.behavior === "deny") {
      return { behavior: "deny", reason: outcome.message || `Hook ${hook.id} 拒绝`, hookId: hook.id, messages, updatedInput, results };
    }
  }
  return { behavior: "allow", messages, updatedInput, results };
}
