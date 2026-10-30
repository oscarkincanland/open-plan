/**
 * 资源发现（H3-4 读取侧）
 *
 * 把“同名资源用了哪一份”从隐式顺序变成带 source 的候选列表：
 *   显式 > 用户目录 > 工作区目录 > 额外目录
 * 本模块只做纯路径排序与来源标注，不读文件内容、不改既有默认顺序。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverResources } from "./配置来源.mjs";

/**
 * @returns {Array<{path:string, source:string, rank:number, kind:string}>}
 */
export function skillRootCandidates({
  agentDir = "",
  userProfile = process.env.USERPROFILE || os.homedir(),
  projectDir = "",
} = {}) {
  const userRoots = [
    agentDir ? path.join(agentDir, "skills") : "",
    path.join(userProfile, ".agents", "skills"),
    path.join(userProfile, ".claude", "skills"),
  ].filter(Boolean);
  const workspaceRoots = [
    projectDir ? path.join(projectDir, ".agents", "skills") : "",
    projectDir ? path.join(projectDir, ".pi", "skills") : "",
    projectDir ? path.join(projectDir, ".claude", "skills") : "",
    projectDir ? path.resolve(projectDir, "..", ".claude", "skills") : "",
  ].filter(Boolean);
  const kindByPath = new Map([
    [agentDir ? path.join(agentDir, "skills") : "", "agent.skills"],
    [path.join(userProfile, ".agents", "skills"), "user.agents"],
    [path.join(userProfile, ".claude", "skills"), "user.claude"],
    [projectDir ? path.join(projectDir, ".agents", "skills") : "", "project.agents"],
    [projectDir ? path.join(projectDir, ".pi", "skills") : "", "project.pi"],
    [projectDir ? path.join(projectDir, ".claude", "skills") : "", "project.claude"],
    [projectDir ? path.resolve(projectDir, "..", ".claude", "skills") : "", "parent.claude"],
  ]);
  return discoverResources({ user: userRoots, workspace: workspaceRoots }).map((item) => ({
    ...item,
    kind: kindByPath.get(item.path) || item.source,
  }));
}

export function listExistingSkillRoots(options = {}) {
  return skillRootCandidates(options)
    .filter((item) => {
      try { return fs.statSync(item.path).isDirectory(); } catch { return false; }
    })
    .map((item) => ({ ...item, exists: true }));
}
