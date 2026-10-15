/**
 * 前端运行开关（与服务端 运行开关.mjs 对应的只读消费端）。
 *
 * 服务端经 /api/status 的 runtimeFlags 快照下发（评审 R8 管道）；
 * 快照到达前所有开关按「关闭」处理 —— 关闭即基线行为，因此早期渲染天然安全。
 */

let snapshot = {};

export async function initRuntimeFlags() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" }).then((x) => x.json());
    if (r && typeof r === "object" && r.runtimeFlags && typeof r.runtimeFlags === "object") {
      snapshot = r.runtimeFlags;
    }
  } catch {
    // 拉取失败保持全关 = 基线行为，无需降级逻辑
  }
}

/** 只读访问；未知开关名一律视为关闭。 */
export function flag(name) {
  return snapshot[name] === true;
}
