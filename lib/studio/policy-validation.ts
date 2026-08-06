/**
 * Policy 编辑 payload 服务端校验。
 *
 * Policy PUT 采用「整配置提交」：必须同时提供 4 个白名单 key，禁止任意 JSON passthrough，
 * 避免局部更新导致 UI 状态与 DB 行不一致，或写入运行时解释器无法理解的字段。
 *
 * 校验是唯一可信边界——前端轻量校验仅为体验，服务端此处才是真值。
 * 校验通过后返回**规范化**的 rows（丢弃未知字段），写库与回显都用它。
 */

export type NormalizedPolicyRow =
 | { key: "protectedPaths"; value: string[] }
 | { key: "commandDenyList"; value: string[] }
 | { key: "formatOnWrite"; value: { enabled: boolean; command: string } }
 | {
 key: "verifyBeforeDelivery";
 value: {
 enabled: boolean;
 command: string;
 timeoutMs: number;
 timeoutIsFailure: boolean;
 testFilePattern: string;
 };
 };

/** Policy PUT 唯一错误码；route 映射为 400。 */
export class PolicyValidationError extends Error {
 readonly code = "invalid_policy" as const;
 constructor(message: string) {
 super(message);
 this.name = "PolicyValidationError";
 }
}

const POLICY_KEYS = [
 "protectedPaths",
 "commandDenyList",
 "formatOnWrite",
 "verifyBeforeDelivery",
] as const;
const POLICY_KEY_SET = new Set<string>(POLICY_KEYS);

const MAX_STR = 512;
const MAX_ARRAY = 50;
const TIMEOUT_MIN = 1_000;
const TIMEOUT_MAX = 300_000;

function isObject(v: unknown): v is Record<string, unknown> {
 return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 编译正则源；非法抛 PolicyValidationError。 */
function compileRegex(source: string, label: string): void {
 try {
 new RegExp(source);
 } catch {
 throw new PolicyValidationError(`${label} 含非法正则: ${source}`);
 }
}

function validateRegexArray(value: unknown, key: string): string[] {
 if (!Array.isArray(value)) throw new PolicyValidationError(`${key} 必须是数组`);
 if (value.length > MAX_ARRAY) throw new PolicyValidationError(`${key} 长度超过 ${MAX_ARRAY}`);
 const out: string[] = [];
 for (const item of value) {
 if (typeof item !== "string") throw new PolicyValidationError(`${key} 每项必须是字符串`);
 if (item.length === 0) throw new PolicyValidationError(`${key} 每项不能为空`);
 if (item.length > MAX_STR) throw new PolicyValidationError(`${key} 每项长度超过 ${MAX_STR}`);
 compileRegex(item, key);
 out.push(item);
 }
 return out;
}

function validateFormatOnWrite(value: unknown): { enabled: boolean; command: string } {
 if (!isObject(value)) throw new PolicyValidationError("formatOnWrite 必须是对象");
 const { enabled, command } = value;
 if (typeof enabled !== "boolean") {
 throw new PolicyValidationError("formatOnWrite.enabled 必须是 boolean");
 }
 if (typeof command !== "string") {
 throw new PolicyValidationError("formatOnWrite.command 必须是字符串");
 }
 if (command.includes("\0"))
 throw new PolicyValidationError("formatOnWrite.command 不允许 NUL 字符");
 if (command.length > MAX_STR) {
 throw new PolicyValidationError(`formatOnWrite.command 长度超过 ${MAX_STR}`);
 }
 // 允许空 command（表示 no-op），不自动补默认值
 return { enabled, command };
}

function validateVerifyBeforeDelivery(value: unknown): {
 enabled: boolean;
 command: string;
 timeoutMs: number;
 timeoutIsFailure: boolean;
 testFilePattern: string;
} {
 if (!isObject(value)) throw new PolicyValidationError("verifyBeforeDelivery 必须是对象");
 const { enabled, command, timeoutMs, timeoutIsFailure, testFilePattern } = value;
 if (typeof enabled !== "boolean") {
 throw new PolicyValidationError("verifyBeforeDelivery.enabled 必须是 boolean");
 }
 if (typeof command !== "string") {
 throw new PolicyValidationError("verifyBeforeDelivery.command 必须是字符串");
 }
 if (command.length > MAX_STR) {
 throw new PolicyValidationError(`verifyBeforeDelivery.command 长度超过 ${MAX_STR}`);
 }
 if (
 typeof timeoutMs !== "number" ||
 !Number.isFinite(timeoutMs) ||
 !Number.isInteger(timeoutMs) ||
 timeoutMs < TIMEOUT_MIN ||
 timeoutMs > TIMEOUT_MAX
 ) {
 throw new PolicyValidationError(
 `verifyBeforeDelivery.timeoutMs 必须是 ${TIMEOUT_MIN}..${TIMEOUT_MAX} 的整数`,
 );
 }
 if (typeof timeoutIsFailure !== "boolean") {
 throw new PolicyValidationError("verifyBeforeDelivery.timeoutIsFailure 必须是 boolean");
 }
 if (typeof testFilePattern !== "string" || testFilePattern.length > MAX_STR) {
 throw new PolicyValidationError(
 `verifyBeforeDelivery.testFilePattern 必须是字符串且长度 <= ${MAX_STR}`,
 );
 }
 compileRegex(testFilePattern, "verifyBeforeDelivery.testFilePattern");
 return { enabled, command, timeoutMs, timeoutIsFailure, testFilePattern };
}

/**
 * 校验 policy rows 输入（未知结构），返回规范化的 4 行（固定顺序）。
 * 未知字段被丢弃；缺 key / 多 key / 重复 key / 非法形状 / 非法正则 / 越界 → 抛 invalid_policy。
 */
export function validatePolicyRows(input: unknown): NormalizedPolicyRow[] {
 if (!Array.isArray(input)) throw new PolicyValidationError("rows 必须是数组");
 const seen = new Map<string, unknown>();
 for (const item of input) {
 if (!isObject(item) || typeof item.key !== "string") {
 throw new PolicyValidationError("每行必须是 { key, value }");
 }
 if (!POLICY_KEY_SET.has(item.key)) {
 throw new PolicyValidationError(`未知 policy key: ${item.key}`);
 }
 if (seen.has(item.key)) {
 throw new PolicyValidationError(`重复 policy key: ${item.key}`);
 }
 seen.set(item.key, item.value);
 }
 for (const k of POLICY_KEYS) {
 if (!seen.has(k)) throw new PolicyValidationError(`缺少 policy key: ${k}`);
 }

 return [
 {
 key: "protectedPaths",
 value: validateRegexArray(seen.get("protectedPaths"), "protectedPaths"),
 },
 {
 key: "commandDenyList",
 value: validateRegexArray(seen.get("commandDenyList"), "commandDenyList"),
 },
 { key: "formatOnWrite", value: validateFormatOnWrite(seen.get("formatOnWrite")) },
 {
 key: "verifyBeforeDelivery",
 value: validateVerifyBeforeDelivery(seen.get("verifyBeforeDelivery")),
 },
 ];
}
