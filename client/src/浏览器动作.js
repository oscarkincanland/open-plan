/**
 * 浏览器动作展示工具（会话流卡片与浏览器面板共用）。
 *
 * 只做展示归一化：动词映射、站点提取、时间格式。
 * 不引入 React，不读全局状态，Node 测试可直接 import。
 */

/** browser_* 工具 kind → 中文动词。 */
export const BROWSER_STEP_VERBS = {
  open: "打开",
  snapshot: "读取页面",
  click: "点击",
  type: "输入",
  press: "按键",
  scroll: "滚动",
  screenshot: "截图",
  tabs: "标签页",
  back: "后退",
  close: "关闭",
  wait: "等待",
  act: "点击并等待",
  extract: "抽取正文",
  select: "选择下拉",
};

/** URL → 站点（去掉 www.）；错误页明确显示“加载失败”，非 http(s) 不冒充站点。 */
export function browserStepHost(url) {
  const value = String(url || "");
  if (!value) return "";
  if (/^chrome-error:\/\//i.test(value)) return "加载失败";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.host.replace(/^www\./, "");
  } catch {
    return value.slice(0, 40);
  }
}

/** 时间戳 → 本地 HH:MM:SS（操作记录用）。 */
export function formatClock(at) {
  const date = new Date(Number(at) || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
