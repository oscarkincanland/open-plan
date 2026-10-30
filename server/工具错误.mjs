/**
 * 统一工具错误 envelope（H3-3）
 *
 * 约定：放在工具返回的 details.error 中，保持 Pi 的 { content, isError, details } 不变。
 * 字段：code（稳定机器可读）、message、suggestion（可直接执行）、retryable。
 */

const RETRYABLE_CODES = new Set([
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "temporarily_unavailable",
  "network_error",
  "busy",
]);

const DEFAULT_SUGGESTIONS = {
  invalid_value: "请检查参数类型与取值范围后重试。",
  missing_argument: "请补齐必填参数后重试。",
  not_found: "请确认路径/名称存在，或先列出可用项。",
  permission_denied: "请检查审批策略或切换到有权限的模式。",
  approval_denied: "用户拒绝了该操作；请调整方案或先征求确认。",
  approval_timeout: "审批超时；请重新发起并等待用户确认。",
  path_outside_workspace: "请把目标路径限制在当前工作区内。",
  unsupported_format: "请改用受支持的格式，或先转换文件。",
  external_service_unavailable: "请检查网络/配置后重试，或改用手动方案。",
  internal_error: "请重试；若持续失败，请查看运行日志定位。",
};

export function toolError(code, message, suggestion = "", retryable = undefined) {
  const normalizedCode = String(code || "internal_error");
  return {
    code: normalizedCode,
    message: String(message || "工具执行失败"),
    suggestion: String(suggestion || DEFAULT_SUGGESTIONS[normalizedCode] || "请检查输入后重试。"),
    retryable: retryable === undefined ? RETRYABLE_CODES.has(normalizedCode) : retryable === true,
  };
}

export function normalizeToolError(error, fallbackCode = "internal_error") {
  if (!error) return toolError(fallbackCode, "未知错误");
  if (error.error && typeof error.error === "object" && error.error.code) return error.error;
  const code = String(error.code || fallbackCode);
  return toolError(code, error.message || String(error), error.suggestion || "", error.retryable);
}

/** 包装为 Pi 工具可返回的 details.error。 */
export function toToolDetailsError(error, fallbackCode = "internal_error") {
  return { error: normalizeToolError(error, fallbackCode) };
}

/** 包装 execute：捕获异常并返回统一 envelope（保持 content/isError）。 */
export function withToolErrorEnvelope(toolName, execute) {
  return async (...args) => {
    try {
      return await execute(...args);
    } catch (error) {
      const normalized = normalizeToolError(error, "internal_error");
      return {
        content: [{ type: "text", text: `${toolName} 失败：${normalized.message}${normalized.suggestion ? `\n建议：${normalized.suggestion}` : ""}` }],
        isError: true,
        details: { error: normalized },
      };
    }
  };
}

export function isRetryable(code) {
  return RETRYABLE_CODES.has(String(code || ""));
}

export function listDefaultSuggestions() {
  return { ...DEFAULT_SUGGESTIONS };
}
