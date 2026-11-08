import { createPortal } from "react-dom";

/**
 * 地图弹窗/右键菜单的统一挂载点。
 *
 * 背景：地图模块容器 .mp 是 position:fixed，本身会形成层叠上下文；
 * 右侧对话栏 .center-chat-slot.map-mode 的 z-index 更高（220），
 * 导致属性表、右键菜单等弹窗被对话栏/画布遮挡。把这些弹窗 portal 到 body，
 * 它们的 z-index 才能参与根层叠上下文并正确盖住对话栏。
 */
export default function OverlayPortal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
