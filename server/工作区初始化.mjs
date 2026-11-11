/**
 * 工作区初始化（2026-11-03 / 计划 006 阶段 C）。
 *
 * 只写缺失文件，绝不覆盖用户已有内容：
 *   - AGENTS.md：项目规则（L1，用户可改）；
 *   - memory/MEMORY.md：项目事实/工作规则/偏好/经验（L2，memory_update 审核写入）。
 *
 * 运行宪法（L0）在 server/智能体运行宪法.mjs，不写入工作区。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteFile, ensureDirectory } from "./持久化工具.mjs";

export const WORKSPACE_SEED_VERSION = "1.0";

const AGENTS_MD = `# 项目规则（Open Plan 工作区）

> 本文件是当前工作区的项目规则（L1）。运行宪法由产品内置（L0），不要在此重复抄写。
> 修改本文件会立即影响本工作区的 Agent 行为；记忆（L2）只放事实与偏好，不放规则。

## 1. 对象与表达
- 面向交通规划工程师；默认中文，结论先行，少复述过程。
- 三种模式：Chat 只读；Work 可写；Review 只审不写。当前模式以系统提示为准。

## 2. 交付与文件
- 所有产物写入当前工作区；中间文件放 \`.work/\`，收尾清理。
- 写交通规划文体前，先读 \`templates/traffic-material/\` 对应模板（13 份写作模板 + 1 份素材库维护文档），按其章节骨架写作，不凭记忆自造结构。
- 新建 Word/Excel/PPT 优先内置 OOXML 引擎；修改既有文档先用 officecli \`view/get\` 确认真实路径，再 \`set/add\`。
- Word 批注先用 \`get/query\` 找真实段落路径，再 \`add --type comment\`，完成后回读校验。

## 3. 交通数据硬约束
- WGS84 中国范围：经度 73–135°E、纬度 18–54°N；越界立即阻断并说明 \`geo_out_of_range\`。
- OD/客流导入必须校验记录数 \`expected vs actual\`；不一致停止并说明 \`data_integrity_failed\`。
- 演示数据必须标注“演示数据”，不得表述为真实调查/监测数据。
- 地图项目位于 \`maps/{project}/\`；正式图层与分析结果按项目规范落盘，临时层不得冒充正式层。

## 4. 审查
- 每条审查结论必须绑定实际读取的本地规范文件；不得凭记忆编造依据。

## 5. 收尾
- 最终答复写清：做了什么、关键结果（含数字）、产物路径、如何验证、未完成项/风险。
- 不调用完成声明工具，不复述工具调用流水。

## 6. 记忆
- 只沉淀稳定事实、规则、偏好、可复用经验；不记临时状态、完整对话、凭据、大段原文。
- 新记忆走 memory_update 审核；不要直接改 memory/。
`;

const MEMORY_MD = `# 记忆索引

## 项目信息
- 当前工作区默认用于交通规划文档、地图与数据分析；产物必须落在本工作区。
- 规划素材模板在项目目录 \`templates/traffic-material/\`（不在工作区），共 13 份写作模板 + 1 份素材库维护文档。

## 工作规则
- 写交通规划文体前先读对应模板，不要凭记忆自造章节结构。
- 修改既有 Office 文档：先 view/get，再 set/add；不要 set 未知路径。
- 大改动先列 2–6 项待办；收尾写清产物路径、验证方式、未完成项。

## 用户偏好
- 默认中文；结论先行，少复述工具调用流水。
- 产物落在当前工作区；中间文件放 \`.work/\` 并清理。
- 不调用 complete_task；用原生终稿收尾。

## 经验教训
- OD/客流数据先校验记录数；不一致不要继续。
- 坐标按 WGS84 中国范围校验；越界立即阻断。
- 演示数据必须标注“演示数据”。
- 地图临时层不要当作正式层；正式图层按项目目录落盘。
- Word 批注先 get/query 找真实段落路径，再 add comment，完成后回读校验。
`;

export function buildWorkspaceSeed() {
  return { agentsMd: AGENTS_MD, memoryMd: MEMORY_MD, version: WORKSPACE_SEED_VERSION };
}

// 旧版 /api/memory/init 生成的通用占位；只有内容完全匹配时才升级，避免覆盖用户真实内容。
const LEGACY_AGENTS = "# AGENTS.md\n\n## 项目说明\n\n在此添加项目指令和上下文信息。\n\n## 工作偏好\n\n在此添加工作偏好。\n";
const LEGACY_MEMORY = "# 记忆索引\n\n这是一个长期记忆文件，记录跨会话的上下文信息。\n\n## 项目信息\n\n## 工作规则\n\n## 用户偏好\n\n## 经验教训\n\n";

function readIfExists(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : ""; } catch { return ""; }
}

function isLegacyPlaceholder(file, legacy) {
  const text = readIfExists(file).trim();
  return Boolean(text) && text === legacy.trim();
}

export function initializeWorkspace(workspace, { create = true } = {}) {
  const root = normalizeWorkspace(workspace, { create });
  if (!root) return { ok: false, code: "WORKSPACE_INVALID", error: "工作区不存在或不是文件夹，无法初始化" };
  const agentsFile = path.join(root, "AGENTS.md");
  const memoryDir = path.join(root, "memory");
  const memoryFile = path.join(memoryDir, "MEMORY.md");
  const seed = buildWorkspaceSeed();
  const created = [];
  const upgraded = [];
  const skipped = [];
  try {
    if (!fs.existsSync(agentsFile)) {
      atomicWriteFile(agentsFile, seed.agentsMd, "utf8");
      created.push("AGENTS.md");
    } else if (isLegacyPlaceholder(agentsFile, LEGACY_AGENTS)) {
      atomicWriteFile(agentsFile, seed.agentsMd, "utf8");
      upgraded.push("AGENTS.md");
    } else {
      skipped.push("AGENTS.md");
    }
    ensureDirectory(memoryDir);
    if (!fs.existsSync(memoryFile)) {
      atomicWriteFile(memoryFile, seed.memoryMd, "utf8");
      created.push("memory/MEMORY.md");
    } else if (isLegacyPlaceholder(memoryFile, LEGACY_MEMORY)) {
      atomicWriteFile(memoryFile, seed.memoryMd, "utf8");
      upgraded.push("memory/MEMORY.md");
    } else {
      skipped.push("memory/MEMORY.md");
    }
    return { ok: true, workspace: root, version: seed.version, created, upgraded, skipped };
  } catch (error) {
    return { ok: false, code: "WORKSPACE_INIT_FAILED", error: error.message, workspace: root, created, upgraded, skipped };
  }
}
