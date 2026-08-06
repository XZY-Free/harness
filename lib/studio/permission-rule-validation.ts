import {
 PERMISSION_DECISIONS,
 PERMISSION_SCOPES,
 type PermissionDecision,
 type PermissionScope,
} from "@/lib/db/schema";
import { isReDoSRisky } from "@/lib/permission/engine";

/**
 * permission rule 入参校验。
 *
 * 复用引擎的 isReDoSRisky（07-）在写入 DB 前拒绝灾难性正则——连根拔同类问题:
 * 存入前拒绝比运行时 safeCompile 回退更早阻断,避免危险规则落库后只在执行时静默失效。
 */

/** argMatcher 合法形状（与引擎 PermissionRule.argMatcher 对齐）。 */
export type ArgMatcher = { pathRegex?: string; commandRegex?: string; risk?: string } | null;

export class PermissionRuleValidationError extends Error {
 constructor(
 message: string,
 readonly code: string,
 ) {
 super(message);
 this.name = "PermissionRuleValidationError";
 }
}

const SCOPE_SET = new Set<string>(PERMISSION_SCOPES);
const DECISION_SET = new Set<string>(PERMISSION_DECISIONS);
/** scopeRef 为 null 仅 global 合法;其余 scope 须绑定具体 id。 */
function normalizeScope(scope: unknown): PermissionScope {
 if (typeof scope !== "string" || !SCOPE_SET.has(scope)) {
 throw new PermissionRuleValidationError("scope 非法", "invalid_scope");
 }
 return scope as PermissionScope;
}
function normalizeDecision(decision: unknown): PermissionDecision {
 if (typeof decision !== "string" || !DECISION_SET.has(decision)) {
 throw new PermissionRuleValidationError("decision 非法", "invalid_decision");
 }
 return decision as PermissionDecision;
}

/** 校验单个正则源:语法合法 + 非 ReDoS。空串视为无约束(返回 null 由调用方处理)。 */
function validateRegexSource(source: unknown, field: string): string | undefined {
 if (source === undefined || source === null) return undefined;
 if (typeof source !== "string") {
 throw new PermissionRuleValidationError(`${field} 必须是字符串`, "invalid_arg_matcher");
 }
 if (source === "") return undefined;
 if (isReDoSRisky(source)) {
 throw new PermissionRuleValidationError(
 `${field} 有 ReDoS 风险(嵌套量词/重叠交替),拒绝写入`,
 "redos_risky",
 );
 }
 try {
 new RegExp(source);
 } catch {
 throw new PermissionRuleValidationError(`${field} 正则语法非法`, "invalid_regex");
 }
 return source;
}

/** 校验 argMatcher 形状 + 内部正则。null/undefined → null(无 arg 约束)。 */
export function normalizeArgMatcher(input: unknown): ArgMatcher {
 if (input === undefined || input === null) return null;
 if (typeof input !== "object" || Array.isArray(input)) {
 throw new PermissionRuleValidationError("argMatcher 必须是对象", "invalid_arg_matcher");
 }
 const obj = input as Record<string, unknown>;
 const result: NonNullable<ArgMatcher> = {};
 const pathRegex = validateRegexSource(obj.pathRegex, "pathRegex");
 const commandRegex = validateRegexSource(obj.commandRegex, "commandRegex");
 if (pathRegex !== undefined) result.pathRegex = pathRegex;
 if (commandRegex !== undefined) result.commandRegex = commandRegex;
 // risk 为自由标签字符串(如 "high"/"destructive"),仅校验类型与长度
 if (obj.risk !== undefined && obj.risk !== null) {
 if (typeof obj.risk !== "string" || obj.risk.length > 32) {
 throw new PermissionRuleValidationError("risk 必须是短字符串(≤32)", "invalid_arg_matcher");
 }
 result.risk = obj.risk;
 }
 return Object.keys(result).length > 0 ? result : null;
}

/** 校验 toolPattern:非空、长度限制、须含点号或通配(形如 tool.xxx / tool.* / *)。 */
export function normalizeToolPattern(input: unknown): string {
 if (typeof input !== "string" || input.trim() === "") {
 throw new PermissionRuleValidationError("toolPattern 不能为空", "invalid_tool_pattern");
 }
 const pattern = input.trim();
 if (pattern.length > 128) {
 throw new PermissionRuleValidationError("toolPattern 最长 128 字符", "invalid_tool_pattern");
 }
 return pattern;
}

/** 校验 priority:整数,允许负值(低优先级)。 */
export function normalizePriority(input: unknown): number {
 if (input === undefined || input === null) return 0;
 if (typeof input !== "number" || !Number.isInteger(input)) {
 throw new PermissionRuleValidationError("priority 必须是整数", "invalid_priority");
 }
 return input;
}

export type NormalizedRuleInput = {
 scope: PermissionScope;
 scopeRef: string | null;
 toolPattern: string;
 argMatcher: ArgMatcher;
 decision: PermissionDecision;
 reason: string | null;
 priority: number;
};

/** 校验 scopeRef 与 scope 的一致性:global 须 null,其余须非空 id。 */
function normalizeScopeRef(scope: PermissionScope, input: unknown): string | null {
 if (scope === "global") {
 return null;
 }
 if (typeof input !== "string" || input.trim() === "") {
 throw new PermissionRuleValidationError(
 `scope=${scope} 须绑定 scopeRef(非空 id)`,
 "invalid_scope_ref",
 );
 }
 return input.trim();
}

/** 校验完整新建输入(POST)。 */
export function validateCreateInput(body: unknown): NormalizedRuleInput {
 if (typeof body !== "object" || body === null || Array.isArray(body)) {
 throw new PermissionRuleValidationError("请求体必须是对象", "invalid_body");
 }
 const obj = body as Record<string, unknown>;
 const scope = normalizeScope(obj.scope ?? "global");
 return {
 scope,
 scopeRef: normalizeScopeRef(scope, obj.scopeRef),
 toolPattern: normalizeToolPattern(obj.toolPattern),
 argMatcher: normalizeArgMatcher(obj.argMatcher),
 decision: normalizeDecision(obj.decision),
 reason:
 typeof obj.reason === "string" && obj.reason.trim() !== ""
 ? obj.reason.trim().slice(0, 256)
 : null,
 priority: normalizePriority(obj.priority),
 };
}

/** 校验更新输入(PATCH)——全字段可选,仅校验传入字段。 */
export function validateUpdateInput(body: unknown): Partial<NormalizedRuleInput> {
 if (typeof body !== "object" || body === null || Array.isArray(body)) {
 throw new PermissionRuleValidationError("请求体必须是对象", "invalid_body");
 }
 const obj = body as Record<string, unknown>;
 const patch: Partial<NormalizedRuleInput> = {};
 if (obj.scope !== undefined) {
 const scope = normalizeScope(obj.scope);
 patch.scope = scope;
 // scope 改变时连带校验/重置 scopeRef:传了 scopeRef 则校验,未传则按 scope 归零
 patch.scopeRef = normalizeScopeRef(scope, obj.scopeRef);
 } else if (obj.scopeRef !== undefined) {
 // 单独改 scopeRef:无法脱离 scope 校验一致性,要求同时传 scope
 throw new PermissionRuleValidationError(
 "改 scopeRef 须同时传 scope 以校验一致性",
 "invalid_scope_ref",
 );
 }
 if (obj.toolPattern !== undefined) patch.toolPattern = normalizeToolPattern(obj.toolPattern);
 if (obj.argMatcher !== undefined) patch.argMatcher = normalizeArgMatcher(obj.argMatcher);
 if (obj.decision !== undefined) patch.decision = normalizeDecision(obj.decision);
 if (obj.reason !== undefined) {
 patch.reason =
 typeof obj.reason === "string" && obj.reason.trim() !== ""
 ? obj.reason.trim().slice(0, 256)
 : null;
 }
 if (obj.priority !== undefined) patch.priority = normalizePriority(obj.priority);
 return patch;
}
