/**
 * 纯 JS 开销测量：base64 膨胀 + JSON 往返 + base64 解码（不需要浏览器）
 * 用法：node docs/audits/2026-11-06-内置浏览器体验调研/bench/encoding-overhead.mjs
 *
 * 采样字节数取自项目 .oaw/browser-shots/ 的真实截图：
 *   简单页 8-20KB / 常规页 64-90KB / 内容密集页 140-243KB（1406x803, JPEG q70）
 */
const samples = [64 * 1024, 145 * 1024, 250 * 1024];
const FPS = 1000 / 90; // server/内置浏览器.mjs: FRAME_BROADCAST_INTERVAL_MS = 90

const rows = [];
for (const n of samples) {
  const buf = Buffer.alloc(n, 0x5a);
  const b64 = buf.toString("base64");
  const payload = { type: "frame", data: { data: b64, at: Date.now(), width: 1440, height: 900 } };
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (let i = 0; i < 3; i += 1) { JSON.parse(JSON.stringify(payload)); Buffer.from(b64, "base64"); }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) JSON.parse(JSON.stringify(payload));
  const jsonMs = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) Buffer.from(b64, "base64");
  const b64Ms = Number(process.hrtime.bigint() - t1) / 1e6 / 20;
  rows.push({
    jpegKB: Number((n / 1024).toFixed(1)),
    base64KB: Number((Buffer.byteLength(b64) / 1024).toFixed(1)),
    sseChunkKB: Number((Buffer.byteLength(chunk) / 1024).toFixed(1)),
    expansion: Number((Buffer.byteLength(b64) / n).toFixed(3)),
    jsonRoundTripMs: Number(jsonMs.toFixed(2)),
    base64DecodeMs: Number(b64Ms.toFixed(2)),
    mbpsAt11fps: Number((Buffer.byteLength(chunk) * 8 * FPS / 1e6).toFixed(1)),
    mainThreadMsPerSec: Number(((jsonMs + b64Ms) * FPS).toFixed(1)),
  });
}
console.table(rows);
const avg = rows.reduce((acc, r) => acc + r.mainThreadMsPerSec, 0) / rows.length;
console.log(`仅 JSON 解析 + base64 解码，11fps 下平均占用主线程 ${avg.toFixed(1)} ms/s（不含 React render 与 JPEG 解码）`);
console.log(`对比：若改为二进制 WebSocket 直传 JPEG，省去 base64(33%) 与 JSON 文本包装，且解码走 blob->createImageBitmap 的异步路径`);
