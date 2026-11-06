/**
 * 预览结果缓存（进程内、按文件指纹失效）。
 *
 * 为什么需要：Word 预览链路里有两段「与文件内容无关、只与文件版本有关」的重活：
 *   1. OfficeCLI 批注查询（`query … comment --json`）——实测冷启动 1.5–2.6 s，
 *      且每次都要把整份文件复制到临时目录再起一个进程；
 *   2. OfficeCLI 高保真 HTML 渲染——实测 17 MB 文档 3.0 s 且产出 18 MB。
 * 同一份文件反复打开、切标签回来、刷新渲染都会重复付这笔成本。
 *
 * 失效策略：键里带 `mtimeMs + size` 指纹——文件被 Agent/用户改动后自动 miss，
 * 不依赖任何显式失效调用，也不会读到旧内容（预览身份头照旧逐次下发）。
 *
 * 约束：纯内存、有字节预算、超出即淘汰最旧条目（LRU），不落盘、不写运行时目录。
 */

const DEFAULT_MAX_ENTRIES = 24;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MB：约可容纳 3 份 18 MB 高保真 HTML

function fingerprintOf(stat) {
  return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

export function createPreviewCache({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  /** key -> { value, bytes, at } */
  const store = new Map();
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;

  const drop = (key) => {
    const entry = store.get(key);
    if (!entry) return;
    totalBytes -= entry.bytes;
    store.delete(key);
  };

  return {
    /**
     * 读缓存。命中返回缓存值，未命中调用 producer 并把结果写入缓存。
     * @param {string} key 逻辑键（如 "comments" / "html"）
     * @param {{mtimeMs:number,size:number}} stat 文件 stat（指纹来源）
     * @param {() => Promise<any>} producer 未命中时的生产者
     * @param {{measure?: (value:any) => number}} [options] 体积测量（默认按字符串长度估算）
     */
    async resolve(key, stat, producer, options = {}) {
      const fp = `${key}::${fingerprintOf(stat)}`;
      const hit = store.get(fp);
      if (hit) {
        hits += 1;
        // 刷新 LRU 顺序
        store.delete(fp);
        store.set(fp, hit);
        return hit.value;
      }
      misses += 1;
      const value = await producer();
      const measure = options.measure || ((v) => (typeof v === "string" ? v.length * 2 : 2048));
      const bytes = Math.max(0, Number(measure(value)) || 0);
      if (bytes <= maxBytes) {
        drop(fp);
        store.set(fp, { value, bytes, at: Date.now() });
        totalBytes += bytes;
        while (store.size > maxEntries || totalBytes > maxBytes) {
          const oldest = store.keys().next().value;
          if (oldest === undefined) break;
          drop(oldest);
        }
      }
      return value;
    },
    /** 只读探测（不触发生产），供诊断/测试使用。 */
    peek(key, stat) {
      return store.get(`${key}::${fingerprintOf(stat)}`)?.value;
    },
    clear() {
      store.clear();
      totalBytes = 0;
    },
    stats() {
      return { entries: store.size, bytes: totalBytes, hits, misses, maxEntries, maxBytes };
    },
  };
}

/** 进程内单例：预览链路共用（批注 / 高保真 HTML 各自用不同 key 前缀）。 */
export const previewCache = createPreviewCache();
