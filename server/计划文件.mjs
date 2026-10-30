/**
 * 计划文件持久化（H4-4）
 *
 * 注意：这不是 PlanMode，也不引入新的权限模式。只把复杂任务的计划落成
 * 工作区内的 Markdown 文件，Run 恢复/用户回看时可读。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteFile, ensureDirectory } from "./持久化工具.mjs";

export function plansDir(workspace) {
  const root = normalizeWorkspace(workspace);
  return path.join(root || String(workspace || "."), ".plans");
}

export function safePlanName(value) {
  const clean = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || `plan-${Date.now()}`;
}

export function planFileName(title = "") {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${stamp}-${safePlanName(title || "plan")}.md`;
}

export function writePlan({ workspace, title = "任务计划", content = "", runId = null, name = null } = {}) {
  const root = normalizeWorkspace(workspace);
  if (!root) return { ok: false, error: "工作区不可用" };
  const dir = plansDir(root);
  ensureDirectory(dir);
  const file = path.join(dir, name ? `${safePlanName(name)}.md` : planFileName(title));
  const header = [
    `# ${title}`,
    "",
    `> 生成时间：${new Date().toISOString()}`,
    runId ? `> Run：${runId}` : "",
    "",
    String(content || "").trim(),
    "",
  ].filter((line) => line !== "").join("\n");
  atomicWriteFile(file, header, "utf8");
  return { ok: true, path: file, relativePath: path.relative(root, file).replace(/\\/g, "/"), name: path.basename(file) };
}

export function readPlan(workspace, name) {
  const root = normalizeWorkspace(workspace);
  if (!root) return null;
  const file = path.join(plansDir(root), path.basename(String(name || "")));
  try {
    return { name: path.basename(file), path: file, content: fs.readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

export function listPlans(workspace) {
  const root = normalizeWorkspace(workspace);
  if (!root) return [];
  const dir = plansDir(root);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort().map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { name, path: file, bytes: stat.size, mtime: stat.mtime.toISOString(), source: "workspace.plans" };
    });
  } catch {
    return [];
  }
}

/** 从 todo 列表生成 Markdown 计划；只做展示，不改变 todos。 */
export function persistPlanFromTodo({ workspace, todoItems = [], runId = null, title = "任务计划", goal = "" } = {}) {
  const items = Array.isArray(todoItems) ? todoItems : [];
  const lines = items.map((item) => {
    const text = String(item?.content || item?.title || item || "").trim();
    if (!text) return "";
    const checked = ["completed", "done"].includes(String(item?.status || "")) ? "x" : " ";
    return `- [${checked}] ${text}`;
  }).filter(Boolean);
  const content = [goal ? `## 目标\n${goal}` : "", "## 待办", ...lines].filter(Boolean).join("\n");
  return writePlan({ workspace, title, content, runId, name: runId ? `${safePlanName(title)}-${crypto.createHash("sha1").update(String(runId)).digest("hex").slice(0, 8)}` : null });
}
