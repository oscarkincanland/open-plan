/**
 * 外部二进制解析（平台适配层，ADR 0024）。
 *
 * 三类外部工具，解析优先级统一为「显式 env → 随包目录 → 系统 PATH → 常见安装路径」：
 *   officecli       文档引擎（docx/xlsx/pptx 高保真、批注查询）
 *   dwg2dxf         LibreDWG，DWG → DXF（**随包**，覆盖 DWG 读取）
 *   ODAFileConverter ODA，DWG 读写双向（**不随包**，仅原格式写回需要）
 *
 * 随包目录：桌面端 `resources/bin`，web 端仓库 `bin/`。
 * 本模块不 import electron、不承载业务逻辑。
 */

import fs from "node:fs";
import path from "node:path";
import { resourcesDir, PROJECT_DIR } from "./宿主信息.mjs";

const isWin = process.platform === "win32";

/** 随包二进制目录：优先 resources/bin，其次仓库 bin/（web 与开发态）。 */
export function bundledBinDir() {
  const fromResources = path.join(resourcesDir(), "bin");
  try { if (fs.existsSync(fromResources)) return fromResources; } catch {}
  return path.join(PROJECT_DIR, "bin");
}

function existsFile(p) {
  try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsFile(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------- OfficeCLI ----------------

/** 历史行为保留：Windows 官方安装脚本的默认落盘位置。 */
export function officecliInstallFallback() {
  const localAppData = process.env.LOCALAPPDATA
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Local");
  return path.join(localAppData, "OfficeCLI", isWin ? "officecli.exe" : "officecli");
}

/**
 * 解析 officecli 路径。
 * 顺序：OFFICECLI_BIN → 随包 bin/ → PATH（非 Windows）→ Windows 安装默认路径。
 * 注意：返回路径**不保证存在**（历史契约如此，调用方用 checkOfficecli 探测）。
 */
export function resolveOfficecli() {
  if (process.env.OFFICECLI_BIN) return process.env.OFFICECLI_BIN;
  const bundled = path.join(bundledBinDir(), isWin ? "officecli.exe" : "officecli");
  if (existsFile(bundled)) return bundled;
  if (!isWin) {
    const onPath = findOnPath(["officecli"]);
    if (onPath) return onPath;
  }
  return officecliInstallFallback();
}

// ---------------- LibreDWG（随包） ----------------

/** 随包 LibreDWG 的 dwg2dxf 路径（不存在返回 null）。 */
export function bundledLibreDwg() {
  const p = path.join(bundledBinDir(), "libredwg", isWin ? "dwg2dxf.exe" : "dwg2dxf");
  return existsFile(p) ? p : null;
}

// ---------------- ODA（不随包） ----------------

/** 随包 ODA 路径（本项目不随包，保留探测以兼容用户自行放置）。 */
export function bundledOda() {
  const p = path.join(bundledBinDir(), "oda", isWin ? "ODAFileConverter.exe" : "ODAFileConverter");
  return existsFile(p) ? p : null;
}

/**
 * 解析 DWG 转换器。
 * @param {"read"|"write"} _purpose 保留参数（读=DWG→DXF，写=DXF→DWG）
 * @returns {{program: string, kind: "oda"|"libredwg", source: string} | null}
 */
export function resolveDwgConverter(purpose = "read") {
  const explicit = String(process.env.OAW_DWG_CONVERTER || "").trim();
  if (explicit) {
    const name = path.basename(explicit).toLowerCase();
    return { program: explicit, kind: name.startsWith("dwg2dxf") ? "libredwg" : "oda", source: "env" };
  }
  const lb = bundledLibreDwg();
  if (lb && purpose === "read") return { program: lb, kind: "libredwg", source: "bundled" };
  const oda = bundledOda();
  if (oda) return { program: oda, kind: "oda", source: "bundled" };
  const onPath = findOnPath(["dwg2dxf", "dwg2dxf.exe"]);
  if (onPath && purpose === "read") return { program: onPath, kind: "libredwg", source: "path" };
  const odaPath = findOnPath(["ODAFileConverter", "ODAFileConverter.exe"]);
  if (odaPath) return { program: odaPath, kind: "oda", source: "path" };
  if (isWin) {
    const programFiles = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(Boolean);
    for (const pf of programFiles) {
      const candidate = path.join(pf, "ODA", "ODAFileConverter 25.12.0", "ODAFileConverter.exe");
      if (existsFile(candidate)) return { program: candidate, kind: "oda", source: "install" };
    }
  }
  return null;
}

/** 诊断用：三个外部工具的可解析结果（不含敏感信息）。 */
export function externalBinaryReport() {
  return {
    bundledBinDir: bundledBinDir(),
    officecli: resolveOfficecli(),
    libreDwg: bundledLibreDwg(),
    oda: bundledOda(),
    dwgConverterRead: resolveDwgConverter("read"),
    dwgConverterWrite: resolveDwgConverter("write"),
  };
}
