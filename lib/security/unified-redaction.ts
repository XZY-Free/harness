/**
 * V11 统一脱敏入口（S12-W05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §5
 * （日志、Event、Trace、Artifact 元数据和错误响应执行 Secret 扫描与脱敏）。
 *
 * 职责：
 * - 统一组合三类脱敏：① 禁采字段名扫描（content-policy.ts）；② Secret 正则模式扫描；
 * ③ 已知明文值扫描。
 * - 提供 redactForV11 统一入口，供 Event/Trace/Artifact/错误响应/日志调用。
 *
 * 与 content-policy.ts 的关系：
 * - content-policy.ts 的 redactContent 按 contentMode（metadata/redacted/diagnostic）三级处理。
 * - 本模块的 redactForV11 在 redacted/diagnostic 模式下额外执行 Secret 模式扫描。
 * - metadata 模式仍返回 null（仅元数据）。
 *
 * 已知明文值注册：
 * - registerV11SecretValues(scope, values) 按 scope（invocationId/threadId）注册。
 * - getV11SecretValues(scope) 返回注册的明文值集合。
 * - clearV11SecretValues(scope) 清除 scope 的注册值。
 * - 进程内 Map，不持久化；生命周期与 Invocation 绑定。
 */
import {
 type RedactResult,
 isForbiddenField,
 redactContent,
} from "@/lib/observability/content-policy";
import { redactKnownPlaintext, redactStringSecrets } from "@/lib/security/secret-scanner";

// ─── 已知明文值注册（进程内 Map） ─────────────────────────

const secretStore = new Map<string, Set<string>>();

/** 注册已知 Secret 明文值（按 scope）。 */
export function registerV11SecretValues(scope: string, values: readonly string[]): void {
 let set = secretStore.get(scope);
 if (!set) {
 set = new Set();
 secretStore.set(scope, set);
 }
 for (const v of values) {
 if (v && v.length >= 4) set.add(v);
 }
}

/** 获取 scope 注册的明文值集合。 */
export function getV11SecretValues(scope: string): string[] {
 return Array.from(secretStore.get(scope) ?? []);
}

/** 清除 scope 的注册值。 */
export function clearV11SecretValues(scope: string): void {
 secretStore.delete(scope);
}

/** 获取所有 scope 的明文值合集（用于无 scope 扫描）。 */
export function getAllV11SecretValues(): string[] {
 const all: string[] = [];
 for (const set of secretStore.values()) {
 for (const v of set) all.push(v);
 }
 return all;
}

// ─── 统一脱敏入口 ──────────────────────────────────────────

/**
 * 统一脱敏：组合禁采字段名 + Secret 模式 + 已知明文值扫描。
 *
 * @param value 待脱敏的值
 * @param mode 脱敏模式：metadata（仅元数据）/ redacted（脱敏内容）/ diagnostic（诊断内容）
 * @param options.scope 已知明文值的 scope（invocationId/threadId）；不传则扫描所有注册值
 * @param options.additionalKnownValues 额外已知明文值（本次调用临时补充）
 * @returns 脱敏结果
 */
export function redactForV11(
 value: unknown,
 mode: "metadata" | "redacted" | "diagnostic",
 options?: {
 scope?: string;
 additionalKnownValues?: readonly string[];
 },
): RedactResult {
 // metadata 模式：返回 null（仅元数据）
 if (mode === "metadata") {
 return { content: null, containsSecret: false, redactionSummary: "metadata-only" };
 }

 // 收集已知明文值
 const knownValues: string[] = [];
 if (options?.scope) {
 knownValues.push(...getV11SecretValues(options.scope));
 } else {
 knownValues.push(...getAllV11SecretValues());
 }
 if (options?.additionalKnownValues) {
 knownValues.push(...options.additionalKnownValues);
 }

 // 第一层：禁采字段名扫描（content-policy.ts）
 let intermediate = value;
 let redactionCount = 0;

 if (containsForbiddenFieldCheck(value)) {
 intermediate = redactForbiddenFieldsDeep(intermediate);
 redactionCount++;
 }

 // 第二层：Secret 模式 + 已知明文值扫描（递归处理字符串）
 const { redacted: finalValue, scanCount } = redactSecretsDeep(intermediate, knownValues);
 redactionCount += scanCount;

 if (redactionCount > 0) {
 return {
 content: finalValue,
 containsSecret: false,
 redactionSummary: `redacted ${redactionCount} secret(s) (mode=${mode})`,
 };
 }

 return { content: value, containsSecret: false, redactionSummary: null };
}

/** content-policy.ts 的 redactContent 入口。 */
export function redactForV11Legacy(
 value: unknown,
 mode: "metadata" | "redacted" | "diagnostic",
): RedactResult {
 return redactContent(value, mode);
}

// ─── 内部辅助 ──────────────────────────────────────────────

function containsForbiddenFieldCheck(value: unknown): boolean {
 if (value === null || value === undefined) return false;
 if (typeof value !== "object") return false;
 if (Array.isArray(value)) {
 return value.some((v) => containsForbiddenFieldCheck(v));
 }
 const obj = value as Record<string, unknown>;
 for (const key of Object.keys(obj)) {
 if (isForbiddenField(key)) return true;
 if (containsForbiddenFieldCheck(obj[key])) return true;
 }
 return false;
}

function redactForbiddenFieldsDeep(value: unknown): unknown {
 if (value === null || value === undefined) return value;
 if (typeof value !== "object") return value;
 if (Array.isArray(value)) return value.map((v) => redactForbiddenFieldsDeep(v));
 const obj = value as Record<string, unknown>;
 const result: Record<string, unknown> = {};
 for (const key of Object.keys(obj)) {
 if (isForbiddenField(key)) {
 result[key] = "[REDACTED]";
 } else {
 result[key] = redactForbiddenFieldsDeep(obj[key]);
 }
 }
 return result;
}

function redactSecretsDeep(
 value: unknown,
 knownValues: readonly string[],
): { redacted: unknown; scanCount: number } {
 let scanCount = 0;

 const visit = (v: unknown): unknown => {
 if (typeof v === "string") {
 let result = v;
 const before = result;
 result = redactStringSecrets(result);
 if (knownValues.length > 0) {
 result = redactKnownPlaintext(result, knownValues);
 }
 if (result !== before) scanCount++;
 return result;
 }
 if (v === null || v === undefined) return v;
 if (Array.isArray(v)) return v.map((item) => visit(item));
 if (typeof v === "object") {
 const obj = v as Record<string, unknown>;
 const result: Record<string, unknown> = {};
 for (const key of Object.keys(obj)) {
 result[key] = visit(obj[key]);
 }
 return result;
 }
 return v;
 };

 return { redacted: visit(value), scanCount };
}
