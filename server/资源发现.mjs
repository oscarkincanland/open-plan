/**
 * 资源发现（H3-4 读取侧，2026-11-04 技能目录改造）
 *
 * 技能根按“当前任务 workspace > 应用项目 > 用户目录”排序：
 *   1. <workspace>/.zcode/skills、.agents/skills、.pi/skills、.claude/skills、.oaw/skills
 *   2. <projectDir>/.agents/skills、.pi/skills、.claude/skills、父目录 .claude/skills
 *   3. agentDir/skills、~/.agents/skills、~/.claude/skills
 *
 * 早先只扫 projectDir（应用仓库），任务工作区里的技能完全不可见；
 * 这里把 workspace 作为一等来源，并按 rank 升序返回（rank 越小越优先）。
 * 同名技能由调用方按数组顺序先到先得。
 *
 * @returns {Array<{path:string, source:string, rank:number, kind:string}>}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function skillRootCandidates({
  agentDir = "",
  userProfile = process.env.USERPROFILE || os.homedir(),
  projectDir = "",
  workspace = "",
} = {}) {
  const roots = [];
  const push = (base, sub, kind, rank, source) => {
    if (!base) return;
    roots.push({ path: path.resolve(base, sub), kind, rank, source });
  };
  if (workspace) {
    push(workspace, ".zcode/skills", "workspace.zcode", 10, "workspace");
    push(workspace, ".agents/skills", "workspace.agents", 11, "workspace");
    push(workspace, ".pi/skills", "workspace.pi", 12, "workspace");
    push(workspace, ".claude/skills", "workspace.claude", 13, "workspace");
    push(workspace, ".oaw/skills", "workspace.oaw", 14, "workspace");
  }
  if (projectDir) {
    push(projectDir, ".agents/skills", "project.agents", 20, "project");
    push(projectDir, ".pi/skills", "project.pi", 21, "project");
    push(projectDir, ".claude/skills", "project.claude", 22, "project");
    push(path.resolve(projectDir, ".."), ".claude/skills", "parent.claude", 23, "project");
  }
  if (agentDir) push(agentDir, "skills", "agent.skills", 30, "user");
  push(userProfile, ".agents/skills", "user.agents", 31, "user");
  push(userProfile, ".claude/skills", "user.claude", 32, "user");

  const seen = new Set();
  return roots
    .filter((item) => {
      const key = process.platform === "win32" ? item.path.toLowerCase() : item.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.rank - right.rank);
}

export function listExistingSkillRoots(options = {}) {
  return skillRootCandidates(options)
    .filter((item) => {
      try { return fs.statSync(item.path).isDirectory(); } catch { return false; }
    })
    .map((item) => ({ ...item, exists: true }));
}
