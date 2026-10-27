/**
 * Skill 注入格式与预算（H2-4）
 * 纯函数，便于单测；agent.mjs 的 skills_read 调用本模块。
 */
import crypto from "node:crypto";
import { previewText } from "./工具结果外置.mjs";

export const DEFAULT_SKILL_MAX_BYTES = 20 * 1024;

export function buildSkillInjection({ name = "", raw = "", maxBytes = DEFAULT_SKILL_MAX_BYTES, source = "" } = {}) {
  const text = String(raw || "");
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_SKILL_MAX_BYTES);
  const content = previewText(text, limit, "head");
  const truncated = Buffer.byteLength(content, "utf8") < Buffer.byteLength(text, "utf8");
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  return {
    text: `<skill_content name="${String(name)}" hash="${hash}"${truncated ? ' truncated="true"' : ""}>\n${content}\n</skill_content>`,
    hash,
    truncated,
    bytes: Buffer.byteLength(content, "utf8"),
    fullBytes: Buffer.byteLength(text, "utf8"),
    source: source || null,
  };
}
