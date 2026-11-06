#!/usr/bin/env node
/**
 * 桌面服务自检（由 scripts/桌面端契约测试.mjs 以子进程方式调用）。
 *
 * 为什么单独一个进程：桌面服务与 Electron 主进程同进程（ADR 0024 壳优先），
 * 在测试进程里启动/关闭它会与 Node 的 libuv 收尾竞争（Windows 上表现为
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`）。放到子进程里跑，
 * 父进程只按输出判定，互不干扰。
 *
 * 输出契约（父进程按行匹配）：
 *   SELF_CHECK_PORT=<port>
 *   SELF_CHECK_TOKEN_LEN=<n>
 *   SELF_CHECK_ROOT=<status>:<content-type>
 *   SELF_CHECK_AUTH=<status>        （未带 token 访问 API 的状态码）
 *   SELF_CHECK_OK
 */

import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function print(key, value) {
  process.stdout.write(`${key}=${value}\n`);
}

try {
  // Windows 下 ESM 动态 import 必须用 file:// URL，不能直接给绝对路径
  const entryUrl = pathToFileURL(path.join(ROOT, "server", "服务入口.mjs")).href;
  const { startDesktopService } = await import(entryUrl);
  const svc = await startDesktopService({
    projectDir: ROOT,
    userDataDir: path.join(process.env.TEMP || ROOT, "oaw-desktop-contract"),
    resourcesDir: ROOT,
    clientDist: path.join(ROOT, "client", "dist"),
  });

  print("SELF_CHECK_PORT", svc.port);
  print("SELF_CHECK_TOKEN_LEN", svc.token.length);

  const root = await fetch(svc.url + "/");
  print("SELF_CHECK_ROOT", `${root.status}:${(root.headers.get("content-type") || "").slice(0, 30)}`);
  await root.arrayBuffer();

  const noToken = await fetch(svc.url + "/api/sessions");
  print("SELF_CHECK_AUTH", noToken.status);
  await noToken.arrayBuffer();

  await svc.stop();
  // 主动断开 keep-alive 连接，减少退出期句柄竞争
  try { http.globalAgent.destroy(); } catch {}
  // undici（Node 18+ 的全局 fetch）连接池
  try {
    const { getGlobalDispatcher } = await import("node:undici").catch(() => ({}));
    if (typeof getGlobalDispatcher === "function") getGlobalDispatcher().destroy?.();
  } catch {}

  print("SELF_CHECK_OK", 1);
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 120);
} catch (error) {
  process.stderr.write(`SELF_CHECK_FAILED: ${String(error?.stack || error?.message || error)}\n`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50);
}
