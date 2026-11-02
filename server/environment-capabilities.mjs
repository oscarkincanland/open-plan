/**
 * 环境能力探测（计划 2026-10-31-003 / N-08）。
 *
 * 背景：bash 工具在本机依赖 WSL。实测 run_05198175 里模型调用 bash 三次全部失败，
 * 错误是 UTF-16 编码的乱码（"Linux 的 Windows 子系统没有已安装的分发版"），
 * 模型看不懂、反复重试。2026-10-30 用户专门开过一轮任务装 WSL，也没装成。
 *
 * 这里做一次启动期探测并缓存结果：
 *   - 可用：bash 照常工作，零改动；
 *   - 不可用：bash 调用直接返回结构化错误 { code: "bash_unavailable" }，
 *     并在工具描述里说明"本机 bash 不可用，文档处理请用 officecli/read/write"，
 *     避免模型盲目重试。
 */
import { spawnSync } from "node:child_process";

/** 探测结果缓存：同一进程内只探测一次。 */
let cached = null;

/**
 * 探测 bash 是否可用。
 *
 * @param {{force?:boolean, timeoutMs?:number}} [options]
 * @returns {{available:boolean, reason:string, platform:string, probedAt:string}}
 */
export function probeBashAvailability({ force = false, timeoutMs = 4000 } = {}) {
  if (cached && !force) return cached;
  const platform = process.platform;
  const now = new Date().toISOString();
  // 非 Windows：bash 是系统原生命令，默认可用（不再多探一次）。
  if (platform !== "win32") {
    cached = { available: true, reason: "", platform, probedAt: now };
    return cached;
  }
  // Windows：探测 WSL 是否真的能执行命令。
  //
  // 关键：`wsl.exe --status` 只报告"默认版本"设置，**即使一个发行版都没装也返回 0**
  // （实测本机：`--status` 退出码 0，但 `wsl.exe -l -v` 退出码 -1 并报
  // "适用于 Linux 的 Windows 子系统没有已安装的分发版"）。
  // 真正能执行命令的是 `wsl.exe echo ...`——它直接暴露"没有已安装的发行版"。
  let available = false;
  let reason = "";
  try {
    const result = spawnSync("wsl.exe", ["echo", "__oaw_probe__"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) {
      reason = `wsl.exe 不可用：${String(result.error.message || result.error).slice(0, 120)}`;
    } else if (Number(result.status) !== 0 || !String(result.stdout || "").includes("__oaw_probe__")) {
      // 输出是 UTF-16 乱码，只有退出码可靠——错误文案里不要复述乱码。
      reason = `WSL 未就绪（wsl.exe echo 退出码 ${result.status}）：未安装可用的 Linux 发行版`;
    } else {
      available = true;
    }
  } catch (error) {
    reason = `WSL 探测异常：${String(error?.message || error).slice(0, 120)}`;
  }
  cached = { available, reason, platform, probedAt: now };
  return cached;
}

/** 清除缓存（测试用）。 */
export function resetBashAvailabilityCache() {
  cached = null;
}

/**
 * bash 不可用时的结构化错误提示。
 * @returns {{code:string, message:string, suggestion:string}}
 */
export function bashUnavailableError() {
  const probe = probeBashAvailability();
  return {
    code: "bash_unavailable",
    message: `本机 bash 不可用（${probe.reason || "WSL 未就绪"}）。`,
    suggestion: "请改用其它工具完成工作："
      + "文本读写用 read / write / edit；"
      + "Office 文档用 officecli（原生引擎优先）或 editorial_pipeline；"
      + "目录浏览用 ls / find；"
      + "确实需要 bash 时，请先让用户安装 WSL（wsl --install）后重试。",
  };
}

/** bash 工具描述里的环境说明（可用时为空串）。 */
export function bashEnvironmentHint() {
  const probe = probeBashAvailability();
  if (probe.available) return "";
  return ` NOTE: bash is NOT available on this machine (${probe.reason || "WSL not ready"}). `
    + "Use read/write/edit for text, officecli or editorial_pipeline for Office documents, "
    + "and ls/find for browsing. Do not retry bash calls that fail.";
}
