#!/usr/bin/env node
/**
 * Office 预览能力矩阵回归：确保 UI 对外声明与实际渲染路径一致，
 * 不把“能打开”误报成“完整保真”。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { PREVIEW_CAPABILITIES, previewCapability } from "../client/src/预览能力.js";

assert.equal(previewCapability("docx").level, "partial", "docx 应为部分保真（浏览器排版）");
assert.match(previewCapability("docx").detail, /OfficeCLI 高保真/, "docx 必须声明高保真回退");
assert.equal(previewCapability("pptx").level, "partial", "pptx 应为部分保真（Canvas）");
assert.equal(previewCapability("xlsx").level, "values-only", "xlsx 网格只显示值");
assert.match(previewCapability("xlsx").detail, /公式/, "xlsx 必须声明公式/样式限制");
assert.equal(previewCapability("doc").level, "unsupported", "旧 .doc 不支持预览");
assert.equal(previewCapability("wps").level, "unsupported", "WPS 专有格式不支持预览");
assert.equal(previewCapability("pdf").level, "full", "PDF 为完整预览");
assert.equal(previewCapability("PNG").level, "full", "扩展名大小写不敏感");
assert.equal(previewCapability("unknown-ext").level, "unknown", "未知格式回退 unknown");
assert.equal(previewCapability("").level, "unknown");
assert.ok(Object.keys(PREVIEW_CAPABILITIES).length >= 15, "能力矩阵应覆盖常见格式");

// 视频预览（2026-11-15-006）：三个容器格式声明为完整只读预览
for (const ext of ["mp4", "webm", "ogv"]) {
  const capability = previewCapability(ext);
  assert.equal(capability.level, "full", `${ext} 应为完整预览`);
  assert.equal(capability.label, "视频", `${ext} 能力标签应为 视频`);
  assert.equal(capability.editable, "只读", `${ext} 应为只读`);
  assert.match(capability.detail, /Range/, `${ext} 应声明 Range 分段加载`);
}
assert.equal(previewCapability("MP4").level, "full", "视频扩展名大小写不敏感");

// 接线契约：服务端分派 kind:"video" + /raw 视频 MIME；DocViewer 有 video 分支
const serverSource = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
assert.match(serverSource, /VIDEO_EXTENSIONS = new Set\(\["mp4", "webm", "ogv"\]\)/, "服务端应登记视频扩展名集合");
assert.match(serverSource, /kind: "video", name: fileName, ext, identity, url: `\/api\/doc\/\$\{encodeURIComponent\(fileName\)\}\/raw/, "分派应返回 kind:video 且走 /raw");
assert.match(serverSource, /mp4: "video\/mp4"/, "/raw mimeMap 应含 video/mp4");
assert.match(serverSource, /webm: "video\/webm"/, "/raw mimeMap 应含 video/webm");
assert.match(serverSource, /ogv: "video\/ogg"/, "/raw mimeMap 应含 video/ogg");
const docViewerSource = fs.readFileSync(new URL("../client/src/components/DocViewer.jsx", import.meta.url), "utf8");
assert.match(docViewerSource, /doc\.kind === "video"/, "DocViewer 应有 video 渲染分支");
assert.match(docViewerSource, /import VideoViewer from "\.\/VideoViewer\.jsx"/, "DocViewer 应引入 VideoViewer");
const videoViewerSource = fs.readFileSync(new URL("../client/src/components/VideoViewer.jsx", import.meta.url), "utf8");
assert.match(videoViewerSource, /<video/, "VideoViewer 应使用原生 video 元素");
assert.match(videoViewerSource, /controls/, "视频播放器应带 controls");
assert.ok(!/autoPlay/i.test(videoViewerSource), "预览视频不自动播放");

console.log("Office 预览能力测试：通过");
