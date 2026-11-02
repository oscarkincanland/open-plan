/**
 * 图片粘贴/上传的纯逻辑与浏览器压缩（P4）。
 *
 * 设计目标：
 * - 剪贴板图片可能来自 items 或 files，两种都接；
 * - 同一张截图重复粘贴只保留一张（去重键）；
 * - 最多 8 张，超出明确提示而不是静默丢弃；
 * - 大图统一压到最长边 1600、JPEG 0.85，透明底转白，降低请求体积与首字延迟；
 * - 小图（≤300KB 且未超尺寸）不重编码，避免无谓损失。
 */

export const IMAGE_MAX_COUNT = 8;
export const IMAGE_MAX_SIDE = 1600;
export const IMAGE_JPEG_QUALITY = 0.85;
export const IMAGE_SKIP_COMPRESS_BYTES = 300 * 1024;

const IMAGE_TYPE = /^image\//i;

export function isImageFile(file) {
  return Boolean(file) && IMAGE_TYPE.test(String(file.type || ""));
}

/** 从 paste 事件取图片：优先 clipboardData.items，回退 clipboardData.files。 */
export function clipboardImageFiles(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const fromItems = Array.from(data.items || [])
    .filter((item) => item?.kind === "file" && IMAGE_TYPE.test(String(item.type || "")))
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
  if (fromItems.length) return fromItems;
  return Array.from(data.files || []).filter(isImageFile);
}

/** 去重键：同名同大小同修改时间视为同一张图。 */
export function imageDedupeKey(file) {
  return [file?.name || "", file?.size || 0, file?.lastModified || 0, file?.type || ""].join("|");
}

/** 内容哈希去重：剪贴板 getAsFile() 的 lastModified 每次可能不同，不能只靠元数据。 */
export async function imageContentKey(file) {
  const fallback = imageDedupeKey(file);
  if (!file || typeof file.arrayBuffer !== "function" || typeof crypto === "undefined" || !crypto.subtle) return fallback;
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return fallback;
  }
}

/** 粘贴图片没有可用文件名时生成稳定名称（便于 chip 展示与排查）。 */
export function imageFileName(file, now = Date.now()) {
  const raw = String(file?.name || "").trim();
  if (raw && !/^image\.(png|jpe?g|webp|gif)$/i.test(raw)) return raw;
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  const ext = String(file?.type || "image/png").split("/")[1].replace(/^jpeg$/i, "jpg") || "png";
  return `粘贴图片-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${ext}`;
}

/** 数量上限：返回保留与拒绝两部分，调用方负责提示。 */
export function limitImages(list, max = IMAGE_MAX_COUNT) {
  const arr = Array.isArray(list) ? list : [];
  const limit = Math.max(0, Number(max) || 0);
  return { kept: arr.slice(0, limit), rejected: arr.slice(limit) };
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

async function loadImageSource(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("无法解码图片"));
      element.src = url;
    });
    return { source: image, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function resultFrom(mediaType, dataUrl, originalBytes, compressedBytes, width, height) {
  return {
    mediaType,
    data: String(dataUrl).split(",")[1] || "",
    dataUrl,
    originalBytes,
    compressedBytes,
    width,
    height,
  };
}

/**
 * 压缩单张图片；失败返回 null，由调用方回退到原始 fileToBase64。
 * 非浏览器环境（Node 测试）直接返回 null。
 */
export async function compressImage(file, options = {}) {
  if (!isImageFile(file) || typeof document === "undefined") return null;
  // 动图/矢量图重编码会丢帧或栅格化，保留原文件交给模型。
  if (/image\/(gif|svg\+xml)/i.test(String(file.type || ""))) return null;
  const maxSide = Math.max(320, Number(options.maxSide) || IMAGE_MAX_SIDE);
  const quality = Math.min(0.95, Math.max(0.5, Number(options.quality) || IMAGE_JPEG_QUALITY));
  const skipBelow = Math.max(0, Number(options.skipBelow) || IMAGE_SKIP_COMPRESS_BYTES);
  let loaded = null;
  try {
    loaded = await loadImageSource(file);
    const width = Math.max(1, Number(loaded.width) || 1);
    const height = Math.max(1, Number(loaded.height) || 1);
    const scale = Math.min(1, maxSide / Math.max(width, height));
    // 小图且尺寸未超限：不重编码，只转 dataURL
    if (scale === 1 && file.size <= skipBelow) {
      const dataUrl = await readBlobAsDataUrl(file);
      return resultFrom(file.type || "image/png", dataUrl, file.size, file.size, width, height);
    }
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // JPEG 不支持透明：先铺白，避免透明 PNG 变黑块
    context.fillStyle = "white";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(loaded.source, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return null;
    // 压缩反而变大且原图不算大：保留原图
    if (blob.size >= file.size && file.size <= 1.5 * 1024 * 1024) {
      const dataUrl = await readBlobAsDataUrl(file);
      return resultFrom(file.type || "image/png", dataUrl, file.size, file.size, width, height);
    }
    const dataUrl = await readBlobAsDataUrl(blob);
    return resultFrom("image/jpeg", dataUrl, file.size, blob.size, targetWidth, targetHeight);
  } catch {
    return null;
  } finally {
    try { loaded?.close?.(); } catch {}
  }
}

/** 压缩收益描述（用于 toast）：没有收益时返回空串。 */
export function compressionSummary(images = []) {
  const list = Array.isArray(images) ? images : [];
  const original = list.reduce((sum, item) => sum + (Number(item?.originalBytes) || 0), 0);
  const compressed = list.reduce((sum, item) => sum + (Number(item?.compressedBytes) || 0), 0);
  if (!original || !compressed || compressed >= original * 0.95) return "";
  return `压缩 ${Math.round((1 - compressed / original) * 100)}%`;
}
