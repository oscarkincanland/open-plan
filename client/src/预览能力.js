/**
 * 前端预览能力矩阵（唯一事实来源）。
 *
 * 用于预览头部与帮助说明：让用户明确当前格式是“完整/部分/仅值/不支持”，
 * 而不是把“能打开”误认为“与 Office 完全一致”。
 * level: full | partial | values-only | unsupported | unknown
 */
export const PREVIEW_CAPABILITIES = Object.freeze({
  docx: {
    level: "partial",
    label: "Word · 浏览器排版",
    detail: "支持段落、基础表格、图片、批注与修订；复杂对象（文本框/形状/SmartArt/图表/公式/域）与 Word 真实分页不保证。可手动切换 OfficeCLI 高保真预览。",
    editable: "简化编辑（保存会重建文档）",
  },
  doc: {
    level: "unsupported",
    label: "旧版 Word 不支持预览",
    detail: "老式 .doc 二进制格式不被预览引擎支持，请另存为 .docx。",
    editable: "无",
  },
  wps: {
    level: "unsupported",
    label: "WPS 格式不支持预览",
    detail: "WPS 专有格式不被预览引擎支持，请另存为 .docx。",
    editable: "无",
  },
  pptx: {
    level: "partial",
    label: "PPT · Canvas 预览",
    detail: "逐页 Canvas 渲染，支持图表；不播放动画/切换，文本不可选，字体可能替换。超大或渲染失败可切 OfficeCLI 高保真。",
    editable: "只读",
  },
  xlsx: {
    level: "values-only",
    label: "Excel · 仅单元格值",
    detail: "网格只显示单元格文本；公式、样式、合并单元格、条件格式、图表与图片不在网格中。可切换 OfficeCLI 高保真只读预览。",
    editable: "单元格值编辑（保存会写回值）",
  },
  xls: {
    level: "values-only",
    label: "Excel · 仅单元格值",
    detail: "旧版 .xls 由服务端解析为值网格；公式/样式/合并单元格不保证。建议另存为 .xlsx 后使用。",
    editable: "只读值网格",
  },
  pdf: { level: "full", label: "PDF", detail: "浏览器 PDF 查看器。", editable: "只读" },
  md: { level: "full", label: "Markdown", detail: "Markdown 渲染与目录。", editable: "只读" },
  markdown: { level: "full", label: "Markdown", detail: "Markdown 渲染与目录。", editable: "只读" },
  txt: { level: "full", label: "文本", detail: "纯文本预览。", editable: "只读" },
  csv: { level: "full", label: "CSV", detail: "按文本预览。", editable: "只读" },
  json: { level: "full", label: "JSON", detail: "按文本预览。", editable: "只读" },
  html: { level: "full", label: "HTML", detail: "本地 HTML iframe 预览。", editable: "只读" },
  htm: { level: "full", label: "HTML", detail: "本地 HTML iframe 预览。", editable: "只读" },
  png: { level: "full", label: "图片", detail: "图片查看器。", editable: "只读" },
  jpg: { level: "full", label: "图片", detail: "图片查看器。", editable: "只读" },
  jpeg: { level: "full", label: "图片", detail: "图片查看器。", editable: "只读" },
  gif: { level: "full", label: "图片", detail: "图片查看器。", editable: "只读" },
  webp: { level: "full", label: "图片", detail: "图片查看器。", editable: "只读" },
  bmp: { level: "full", label: "图片", detail: "图片查看器。", editable: "只读" },
  svg: { level: "full", label: "图片", detail: "图片查看器（脚本不执行）。", editable: "只读" },
});

const UNKNOWN_CAPABILITY = Object.freeze({ level: "unknown", label: "未知格式", detail: "该格式没有登记预览能力。", editable: "只读" });

export function previewCapability(ext) {
  const key = String(ext || "").toLowerCase().replace(/^\./, "");
  return PREVIEW_CAPABILITIES[key] || UNKNOWN_CAPABILITY;
}
