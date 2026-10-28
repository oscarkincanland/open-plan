#!/usr/bin/env node
/**
 * Office 预览能力矩阵回归：确保 UI 对外声明与实际渲染路径一致，
 * 不把“能打开”误报成“完整保真”。
 */
import assert from "node:assert/strict";
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

console.log("Office 预览能力测试：通过");
