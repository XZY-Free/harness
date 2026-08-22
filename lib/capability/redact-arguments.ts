/**
 * 参数脱敏（关口02 02-6 · 冻结方案 §16.2）。
 *
 * Runtime 提交的 arguments 契约上「只含业务参数；无 user/tenant/credential」（§5.1），
 * 但 Gateway 仍须防御性脱敏已知敏感键，再计算 argumentsHash 与持久化
 * `argumentsRedactedJson`。脱敏结果绝不含 Secret/PII 原文。
 */
const SENSITIVE_KEY_RE =
  /^(password|passwd|pwd|token|secret|secret_key|secrettoken|api_key|apikey|access_key|accesskey|auth|authorization|authorizationheader|credential|credentials|privatekey|private_key|client_secret|refresh_token)$/i;

/** 值掩码；对象/数组保留结构（递归），标量替换。 */
const MASK = "[REDACTED]";

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? maskValue(value) : redactValue(value);
  }
  return out;
}

/** 敏感键：对象整体掩码（保留结构便于调用方识别），标量直接掩码。 */
function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(() => MASK);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) out[key] = MASK;
    return out;
  }
  return MASK;
}

/** 返回脱敏后的 arguments（新对象，不修改入参）。 */
export function redactArguments(argumentsJson: unknown): Record<string, unknown> {
  if (typeof argumentsJson !== "object" || argumentsJson === null || Array.isArray(argumentsJson)) {
    return {};
  }
  return redactObject(argumentsJson as Record<string, unknown>);
}
