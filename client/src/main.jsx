import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import DesktopAgentPrototype from "./components/桌面端Agent原型.jsx";
import { ThemeProvider } from "./theme.jsx";
import { installStaleChunkRecovery } from "./分包恢复.js";
import "./styles.css";

// 服务端重新构建后旧页面会持有已失效的分包哈希（组件加载失败），入口先装全局自动恢复
installStaleChunkRecovery();

// 某些第三方库会在 bundle 加载时把 window.FileReader 覆盖为自己的空壳类，
// 导致图片/附件导入的 FileReader.readAsDataURL 不可用。index.html 已保存原生引用，
// 这里恢复，并轮询防止后续懒加载 chunk 再次覆盖。
const restoreNativeFileApis = () => {
  if (window.__oawNativeFileReader && window.FileReader !== window.__oawNativeFileReader) window.FileReader = window.__oawNativeFileReader;
  if (window.__oawNativeFile && window.File !== window.__oawNativeFile) window.File = window.__oawNativeFile;
  if (window.__oawNativeBlob && window.Blob !== window.__oawNativeBlob) window.Blob = window.__oawNativeBlob;
  if (window.__oawNativeFileList && window.FileList !== window.__oawNativeFileList) window.FileList = window.__oawNativeFileList;
};
restoreNativeFileApis();
window.setInterval(restoreNativeFileApis, 1000);

const isDesktopPrototype = new URLSearchParams(window.location.search).get("prototype") === "desktop";

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    {isDesktopPrototype ? <DesktopAgentPrototype /> : <App />}
  </ThemeProvider>
);
