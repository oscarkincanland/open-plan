// v0.13.8 音视频附件与大小约束的纯逻辑（无 JSX，供 ChatPanel 与测试共用）：
// 附件白名单扩展音视频（mp4/webm/mov、mp3/wav/m4a）；音视频不作为图片进模型，
// 作为附件暂存、由 Agent 通过工作区读取；单文件上限 100MB，超限提示不阻塞输入。
export const ATTACHMENT_SIZE_LIMIT = 100 * 1024 * 1024;
export const ATTACHMENT_ALLOWED_EXT = /\.(docx|xlsx|pptx|md|markdown|txt|pdf|html|htm|csv|json|mp4|webm|mov|mp3|wav|m4a)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

// 媒体分类：video / audio / document（图片走 images 通道，不经过这里）
export function mediaKindFor(name = "") {
  const value = String(name || "");
  if (VIDEO_EXT.test(value)) return "video";
  if (AUDIO_EXT.test(value)) return "audio";
  return "document";
}

// 附件卡片大小展示（B/KB/MB/GB，保留一位小数）
export function formatBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}
