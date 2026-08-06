/**
 * V11 Observation 内容策略（S11-W05）。
 *
 * 事实源：../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W05。
 *
 * 内容模式：
 * - metadata：仅元数据（kind/name/时长/状态/计数），不含内容。
 * - redacted：已脱敏的内容（敏感字段已替换为 [REDACTED]）。
 * - diagnostic：诊断内容（含详细 args/result，但仍禁采 Secret/Cookie/验证码/私钥/隐藏思维链）。
 *
 * 永不采集的字段（任何模式下均不可写入 Observation）：
 * - Secret/Credential 原值
 * - Cookie 原值
 * - 验证码（OTP/SMS code）
 * - 私钥（private key）
 * - 隐藏思维链（hidden chain of thought）
 * - HTTP Authorization 头原值
 *
 * 不变量：
 * - containsSecret 永远为 false：写入前由本模块脱敏，调用方不可绕过。
 * - redactionSummary 记录脱敏摘要，便于审计与排障。
 */

/** 禁采字段名（小写匹配）。 */
export const FORBIDDEN_FIELDS = [
 "password",
 "secret",
 "token",
 "api_key",
 "apikey",
 "api_secret",
 "credential",
 "cookie",
 "otp",
 "sms_code",
 "verification_code",
 "private_key",
 "privatekey",
 "chain_of_thought",
 "chainofthought",
 "cot",
 "authorization",
] as const;

/** 禁采字段名正则模式（覆盖驼峰/下划线/连字符变体）。 */
export const FORBIDDEN_FIELD_PATTERNS = [
 /password/i,
 /secret/i,
 /token/i,
 /api[_-]?key/i,
 /credential/i,
 /cookie/i,
 /otp/i,
 /sms[_-]?code/i,
 /verification[_-]?code/i,
 /private[_-]?key/i,
 /chain[_-]?of[_-]?thought/i,
 /\bcot\b/i,
 /authorization/i,
] as const;

/** 检测字段名是否在禁采列表。 */
export function isForbiddenField(fieldName: string): boolean {
 const lower = fieldName.toLowerCase();
 if ((FORBIDDEN_FIELDS as readonly string[]).includes(lower)) return true;
 return FORBIDDEN_FIELD_PATTERNS.some((p) => p.test(fieldName));
}

/** 递归扫描对象，发现禁采字段返回 true。 */
export function containsForbiddenField(value: unknown): boolean {
 if (value === null || value === undefined) return false;
 if (typeof value !== "object") return false;
 if (Array.isArray(value)) {
 return value.some((v) => containsForbiddenField(v));
 }
 const obj = value as Record<string, unknown>;
 for (const key of Object.keys(obj)) {
 if (isForbiddenField(key)) return true;
 if (containsForbiddenField(obj[key])) return true;
 }
 return false;
}

/** redactContent 返回值。 */
export interface RedactResult {
 content: unknown;
 containsSecret: boolean;
 redactionSummary: string | null;
}

/** 按 contentMode 脱敏内容。containsSecret 永远返回 false（已脱敏）。 */
export function redactContent(
 value: unknown,
 mode: "metadata" | "redacted" | "diagnostic",
): RedactResult {
 // metadata 模式：返回 null（仅元数据）
 if (mode === "metadata") {
 return { content: null, containsSecret: false, redactionSummary: "metadata-only" };
 }
 // redacted/diagnostic 模式：扫描禁采字段
 const hasSecret = containsForbiddenField(value);
 if (hasSecret) {
 const redacted = redactForbiddenFields(value);
 return {
 content: redacted,
 containsSecret: false,
 redactionSummary: `removed forbidden fields (mode=${mode})`,
 };
 }
 return { content: value, containsSecret: false, redactionSummary: null };
}

/** 递归替换禁采字段值为 [REDACTED]。 */
function redactForbiddenFields(value: unknown): unknown {
 if (value === null || value === undefined) return value;
 if (typeof value !== "object") return value;
 if (Array.isArray(value)) return value.map((v) => redactForbiddenFields(v));
 const obj = value as Record<string, unknown>;
 const result: Record<string, unknown> = {};
 for (const key of Object.keys(obj)) {
 if (isForbiddenField(key)) {
 result[key] = "[REDACTED]";
 } else {
 result[key] = redactForbiddenFields(obj[key]);
 }
 }
 return result;
}
