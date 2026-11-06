/**
 * 桌面宿主服务入口（ADR 0024 壳优先）。
 *
 * 为什么需要这一层：`server/index.mjs` 是「副作用式入口」——模块加载即监听，
 * 且 HOST/PORT 在模块顶层从 env 读取。桌面主进程要在**设置完 env 之后**再加载它，
 * 并拿到「端口 / token / 就绪信号」，所以用一个薄包装：
 *
 *   1. 选一个空闲端口（避免 3002 被其他程序占用）；
 *   2. 生成一次性 API token（只监听回环，仍强制鉴权，防本机其他进程直连）；
 *   3. 注入宿主 env（OAW_DESKTOP / OAW_USER_DATA_DIR / OAW_RESOURCES_DIR / OAW_CLIENT_DIST）；
 *   4. 动态 import index.mjs（此时才真正监听）；
 *   5. 轮询 /api/health（或根路径）确认就绪后返回句柄。
 *
 * 停止：服务与桌面主进程同进程，直接 `app.exit()` 即可；本模块额外提供
 * 尽力而为的优雅收尾（触发 SIGTERM 处理链会退出进程，故不在此调用）。
 */

import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

/** 向系统要一个空闲端口（拿到后立刻释放，交给服务监听）。 */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      // 任何 HTTP 响应都说明监听成功（404/401 也算就绪）
      if (res.status > 0) {
        try { await res.arrayBuffer(); } catch {}
        return true;
      }
    } catch (error) {
      lastError = String((error && error.message) || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastError}`);
}

/**
 * 启动桌面端内嵌服务。
 * @param {{projectDir:string, userDataDir:string, resourcesDir:string, clientDist:string}} options
 * @returns {Promise<{port:number, token:string, url:string, host:string, stop:()=>Promise<void>}>}
 */
export async function startDesktopService(options) {
  const { projectDir, userDataDir, resourcesDir, clientDist } = options || {};
  const port = await pickFreePort();
  const token = crypto.randomBytes(24).toString("hex");
  const host = "127.0.0.1";

  // 关键：必须在 import index.mjs 之前注入，因为 HOST/PORT/API_TOKEN 在模块顶层读取。
  process.env.OAW_DESKTOP = "1";
  process.env.OAW_USER_DATA_DIR = String(userDataDir || "");
  process.env.OAW_RESOURCES_DIR = String(resourcesDir || "");
  process.env.OAW_CLIENT_DIST = String(clientDist || "");
  process.env.OAW_API_TOKEN = token;
  process.env.HOST = host;
  process.env.PORT = String(port);

  const entry = path.join(projectDir || process.cwd(), "server", "index.mjs");
  const url = `http://${host}:${port}`;

  // 动态 import：副作用式入口，加载即监听。
  await import(`file://${entry.replace(/\\/g, "/")}`);
  await waitForReady(`${url}/api/status`);

  return {
    port,
    token,
    url,
    host,
    /** 同进程内无需额外关闭 HTTP；保留签名供主进程统一调用。 */
    async stop() {
      return true;
    },
  };
}
