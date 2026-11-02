/**
 * 文件树抽屉的作用域：只服务文档/工作产物/改动。
 * 浏览器、对象、工作流、地图预览等标签不占抽屉空间，切换时自动收起。
 */
export const SIDE_DRAWER_TAB_KINDS = new Set(["doc", "artifacts", "changes"]);

export function sideDrawerAllowed(kind) {
  return SIDE_DRAWER_TAB_KINDS.has(String(kind || ""));
}
