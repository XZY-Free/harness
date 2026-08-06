import {
 redactObject,
 redactObjectGlobal,
 redactText,
 redactTextGlobal,
} from "@/lib/runtime/secret-redaction";

type LogFields = Record<string, unknown>;

/**
 * 日志禁止输出的敏感字段名（小写匹配）。
 *
 * - Authorization/Cookie/Credential 类：HTTP 认证头与凭据，绝不进日志。
 * - 一次性 code/state/nonce：OAuth/PKCE 一次性值。业务侧稳定 `code`（错误码）、
 * `state`（线程/轮次状态）是公开语义，不在本表；OAuth 一次性值用带前缀的名字
 * （auth_code/oauth_state/oauth_nonce/code_verifier/code_challenge）登记，确保被脱敏。
 */
const SENSITIVE_LOG_FIELDS = new Set([
 "authorization",
 "cookie",
 "set-cookie",
 "credential",
 "credentials",
 "password",
 "secret",
 "token",
 "access_token",
 "refresh_token",
 "id_token",
 "api_key",
 "apikey",
 "private_key",
 "nonce",
 "auth_code",
 "authorization_code",
 "oauth_code",
 "oauth_state",
 "oauth_nonce",
 "code_verifier",
 "code_challenge",
 "pkce_verifier",
]);

/** 未授权本地绝对路径前缀（macOS/Linux 常见）。 */
const LOCAL_PATH_PATTERN = /(?:^|[\s"'])(\/(?:Users|home|private|tmp|var|opt|etc|root)\/[^\s"']+)/g;

/** 把字符串中的本地绝对路径替换为 [PATH]。 */
function redactPaths(value: string): string {
 return value.replace(LOCAL_PATH_PATTERN, (match, _p1) => {
 // 保留匹配前导字符（空格/引号），只替换路径本身
 const leading = match.charAt(0);
 return leading === "/" ? "[PATH]" : `${leading}[PATH]`;
 });
}

/** 递归脱敏日志字段：敏感字段置 [REDACTED]，字符串值去本地绝对路径。 */
function redactSensitiveFields(fields: LogFields): LogFields {
 const out: LogFields = {};
 for (const [key, value] of Object.entries(fields)) {
 if (SENSITIVE_LOG_FIELDS.has(key.toLowerCase())) {
 out[key] = "[REDACTED]";
 continue;
 }
 out[key] = redactValueDeep(value);
 }
 return out;
}

function redactValueDeep(value: unknown): unknown {
 if (typeof value === "string") {
 return redactPaths(value);
 }
 if (Array.isArray(value)) {
 return value.map(redactValueDeep);
 }
 if (value && typeof value === "object") {
 return redactSensitiveFields(value as LogFields);
 }
 return value;
}

function emit(level: "info" | "warn" | "error", msg: string, fields?: LogFields) {
 // 日志脱敏（secret 明文不进日志）。
 // 审计修复：有 threadId 时按该 thread 注册的 secret 脱敏；
 // 无 threadId 时扫描所有已注册 thread 的 secret（全局脱敏），防止 secret 泄漏到日志。
 const tid = typeof fields?.threadId === "string" ? fields.threadId : undefined;
 const safeMsg = tid ? redactPaths(redactText(msg, tid)) : redactPaths(redactTextGlobal(msg));
 let safeFields: LogFields | undefined;
 if (fields) {
 const secretRedacted = tid ? redactObject(fields, tid) : redactObjectGlobal(fields);
 // 再叠加 HTTP/认证敏感字段与本地路径脱敏。
 safeFields = redactSensitiveFields(secretRedacted as LogFields);
 }
 const line = JSON.stringify({
 ts: new Date().toISOString(),
 level,
 msg: safeMsg,
 ...safeFields,
 });
 if (level === "error") {
 console.error(line);
 } else {
 console.log(line);
 }
}

/** 结构化 JSON 日志。约定带 threadId 字段便于按线程定位。 */
export const logger = {
 info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
 warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
 error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};

// 导出供测试与调用方复用。
export { redactSensitiveFields, redactPaths, SENSITIVE_LOG_FIELDS };
