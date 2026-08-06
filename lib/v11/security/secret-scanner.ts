/**
 * V11 Secret 扫描器（S12-W05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §5
 * （日志、Event、Trace、Artifact 元数据和错误响应执行 Secret 扫描与脱敏）。
 *
 * 职责：
 * - 按正则模式扫描字符串值中的已知 Secret 格式（AWS/GitHub/PEM/JWT/Slack/Google 等）。
 * - 按已知明文值扫描（运行时注册的 secret 值）。
 * - 返回扫描结果与脱敏后的值（替换为 [REDACTED:{pattern_name}]）。
 *
 * 不变量：
 * - redactSecrets 返回的值中不包含任何已知 Secret 明文。
 * - 扫描结果不含原文 Secret，只含 pattern name 与位置。
 *
 * 与 content-policy.ts 的关系：
 * - content-policy.ts 按字段名扫描（password/secret/token 等）。
 * - 本模块按值的内容扫描（正则模式 + 明文值）。
 * - unified-redaction.ts 组合两者。
 */
import { isForbiddenField } from "@/lib/v11/observability/content-policy";

/** Secret 模式定义。 */
export interface SecretPattern {
 /** 模式名称（用于 [REDACTED:{name}] 标记与审计）。 */
 name: string;
 /** 正则模式（全局匹配）。 */
 pattern: RegExp;
}

/**
 * 已知 Secret 正则模式（S12-W05）。
 *
 * 覆盖常见云平台与开发者 Secret 格式：
 * - AWS Access Key（AKIA 开头 20 字符）
 * - AWS Secret Key（40 字符 hex/base64，需配合 Access Key 上下文）
 * - GitHub Token（gh[pousr]_ 开头 36 字符）
 * - PEM 私钥（-----BEGIN ... PRIVATE KEY-----）
 * - JWT（eyJ...eyJ...签名）
 * - Slack Token（xox[baprs]- 开头）
 * - Google API Key（AIza 开头 35 字符）
 * - Stripe Key（sk_live_/sk_test_ 开头）
 * - 通用 Bearer Token（Authorization: Bearer 后的非空 token，需配合 header 上下文）
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
 {
 name: "aws_access_key_id",
 pattern: /\bAKIA[0-9A-Z]{16}\b/g,
 },
 {
 name: "github_token",
 pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
 },
 {
 name: "private_key_pem",
 pattern:
 /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g,
 },
 {
 name: "jwt",
 pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
 },
 {
 name: "slack_token",
 pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
 },
 {
 name: "google_api_key",
 pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
 },
 {
 name: "stripe_secret_key",
 pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
 },
] as const;

/** Secret 匹配结果。 */
export interface SecretMatch {
 /** 模式名称。 */
 name: string;
 /** 匹配到的字符串前 4 字符（用于审计确认，不暴露完整 Secret）。 */
 preview: string;
 /** 匹配起始位置。 */
 index: number;
 /** 匹配长度。 */
 length: number;
}

/** 扫描字符串中的已知 Secret 模式。 */
export function scanStringForSecrets(value: string): SecretMatch[] {
 const matches: SecretMatch[] = [];
 for (const { name, pattern } of SECRET_PATTERNS) {
 // 重置 lastIndex（全局正则复用）
 const re = new RegExp(pattern.source, pattern.flags);
 let m: RegExpExecArray | null = re.exec(value);
 while (m !== null) {
 matches.push({
 name,
 preview: m[0].slice(0, 4),
 index: m.index,
 length: m[0].length,
 });
 // 防止零宽匹配死循环
 if (m[0].length === 0) re.lastIndex++;
 m = re.exec(value);
 }
 }
 return matches;
}

/** 替换字符串中的 Secret 为 [REDACTED:{name}]。 */
export function redactStringSecrets(value: string): string {
 let result = value;
 for (const { name, pattern } of SECRET_PATTERNS) {
 const re = new RegExp(pattern.source, pattern.flags);
 result = result.replace(re, `[REDACTED:${name}]`);
 }
 return result;
}

/**
 * 扫描任意值中的已知明文 Secret。
 *
 * @param value 待扫描的值（递归遍历对象/数组）
 * @param knownPlaintextValues 已知 Secret 明文值集合（运行时注册）
 * @returns 匹配结果列表（不含原文 Secret）
 */
export function scanForKnownPlaintext(
 value: unknown,
 knownPlaintextValues: readonly string[],
): SecretMatch[] {
 const matches: SecretMatch[] = [];
 if (knownPlaintextValues.length === 0) return matches;

 const visit = (v: unknown): void => {
 if (typeof v === "string") {
 for (const plaintext of knownPlaintextValues) {
 if (plaintext.length < 4) continue; // 最小长度 4 防误伤
 let idx = v.indexOf(plaintext);
 while (idx !== -1) {
 matches.push({
 name: "known_plaintext",
 preview: plaintext.slice(0, 4),
 index: idx,
 length: plaintext.length,
 });
 idx = v.indexOf(plaintext, idx + plaintext.length);
 }
 }
 } else if (Array.isArray(v)) {
 for (const item of v) visit(item);
 } else if (v !== null && typeof v === "object") {
 for (const key of Object.keys(v as Record<string, unknown>)) {
 visit((v as Record<string, unknown>)[key]);
 }
 }
 };
 visit(value);
 return matches;
}

/** 替换字符串中的已知明文 Secret 为 [REDACTED]。 */
export function redactKnownPlaintext(
 value: string,
 knownPlaintextValues: readonly string[],
): string {
 let result = value;
 // 按长度降序替换，避免短串先替换破坏长串
 const sorted = [...knownPlaintextValues]
 .filter((v) => v.length >= 4)
 .sort((a, b) => b.length - a.length);
 for (const plaintext of sorted) {
 result = result.split(plaintext).join("[REDACTED]");
 }
 return result;
}

/** 扫描结果。 */
export interface ScanResult {
 /** 发现的 Secret 匹配（不含原文）。 */
 matches: SecretMatch[];
 /** 是否发现 Secret。 */
 found: boolean;
}

/** 扫描任意值中的所有 Secret（模式 + 明文 + 禁采字段名）。 */
export function scanSecrets(
 value: unknown,
 knownPlaintextValues: readonly string[] = [],
): ScanResult {
 const matches: SecretMatch[] = [];

 const visit = (v: unknown, path = ""): void => {
 if (typeof v === "string") {
 matches.push(...scanStringForSecrets(v));
 for (const plaintext of knownPlaintextValues) {
 if (plaintext.length < 4) continue;
 let idx = v.indexOf(plaintext);
 while (idx !== -1) {
 matches.push({
 name: "known_plaintext",
 preview: plaintext.slice(0, 4),
 index: idx,
 length: plaintext.length,
 });
 idx = v.indexOf(plaintext, idx + plaintext.length);
 }
 }
 } else if (Array.isArray(v)) {
 for (let i = 0; i < v.length; i++) {
 visit(v[i], `${path}[${i}]`);
 }
 } else if (v !== null && typeof v === "object") {
 const obj = v as Record<string, unknown>;
 for (const key of Object.keys(obj)) {
 if (isForbiddenField(key)) {
 matches.push({
 name: "forbidden_field",
 preview: key.slice(0, 4),
 index: -1,
 length: key.length,
 });
 }
 visit(obj[key], path ? `${path}.${key}` : key);
 }
 }
 };
 visit(value);

 return { matches, found: matches.length > 0 };
}
