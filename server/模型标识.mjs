/**
 * 模型标识规则（2026-11-11-003）。
 *
 * 模型 ID 允许包含斜线：Command Code 等网关会使用 `deepseek/deepseek-v4-flash`、
 * `Qwen/Qwen3.8-27B` 这类带命名空间前缀的 ID。运行时始终按第一个斜线切分
 * provider（见 server/agent.mjs applyModelSpec），斜线之后的全部内容都是模型 ID。
 *
 * 这里只拦真正会破坏解析或路径含义的输入：空白、反斜线、控制字符、首尾斜线、
 * 连续斜线、`.` / `..` 路径段。展示名称不受此规则限制。
 */
export const MODEL_ID_MAX_LENGTH = 160;

export function normalizeModelId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > MODEL_ID_MAX_LENGTH) return null;
  if (/[\s\\\u0000-\u001f]/.test(id)) return null;
  if (id.startsWith("/") || id.endsWith("/")) return null;
  if (id.includes("//")) return null;
  if (id.split("/").some((part) => part === "." || part === "..")) return null;
  return id;
}

export function isValidModelId(value) {
  return normalizeModelId(value) !== null;
}
