/**
 * 类型化 Resource Scope。
 *
 * 事实源：docs/architecture/security.md 。
 *
 * resource_scope_json 存储类型化选择器，服务端按 action_code + resource_scope 判断。
 * - 空 allowlist（既无 wildcard 也无 ids）= 全 deny（最小权限）。
 * - 未知 scope type / 无法解析 JSON = deny + 报错。
 * - 外部角色只通过 principal_binding 映射，不直接出现在 scope 判断分支。
 *
 * 本模块不导入 action-codes.ts，避免循环依赖；action-codes.ts 单向导入本模块的类型与错误类。
 */

/** Resource Scope 类型全集（方案 资源 Scope 列表）。 */
export const RESOURCE_SCOPE_TYPES = [
 "agent",
 "team",
 "environment",
 "provider",
 "tool",
 "tenant",
 "policy",
 "connection",
 "principal",
 "workspace",
 "organization",
 "job_type",
 "owner",
 "consumer",
 "artifact_type",
 "project",
 "data_class",
 "self",
 "time_range",
 "runtime",
 "skill",
 "knowledge_base",
 "knowledge_document",
 // S12-W05：Workload Token 撤销按 Invocation 维度授权
 "invocation",
] as const;

export type ResourceScopeType = (typeof RESOURCE_SCOPE_TYPES)[number];

const RESOURCE_SCOPE_TYPE_SET: ReadonlySet<string> = new Set(RESOURCE_SCOPE_TYPES);

/** 判断 scope type 是否在目录内。 */
export function isKnownResourceScopeType(type: string): type is ResourceScopeType {
 return RESOURCE_SCOPE_TYPE_SET.has(type);
}

/** 类型化资源选择器。 */
export interface ResourceScope {
 /** 资源类型，必须命中 ACTION_RESOURCE_TYPES 允许列表。 */
 type: ResourceScopeType;
 /** 限定资源 id 列表；wildcard=true 时忽略。空数组 + wildcard=false 视为空 allowlist。 */
 ids?: string[];
 /** 通配，覆盖该 type 下所有资源。 */
 wildcard?: boolean;
}

/** Resource Scope 解析/校验错误。 */
export class ResourceScopeError extends Error {
 constructor(
 public readonly code: "malformed_scope" | "unknown_scope_type" | "scope_type_mismatch",
 message: string,
 ) {
 super(message);
 }
}

/**
 * 解析 resource_scope_json 字符串为类型化 ResourceScope。
 * @throws ResourceScopeError malformed_scope / unknown_scope_type
 */
export function parseResourceScope(json: string): ResourceScope {
 let parsed: unknown;
 try {
 parsed = JSON.parse(json);
 } catch {
 throw new ResourceScopeError("malformed_scope", "resource_scope_json 不是合法 JSON");
 }
 return validateResourceScope(parsed);
}

/**
 * 校验裸对象为类型化 ResourceScope。
 * @throws ResourceScopeError malformed_scope / unknown_scope_type
 */
export function validateResourceScope(raw: unknown): ResourceScope {
 if (typeof raw !== "object" || raw === null) {
 throw new ResourceScopeError("malformed_scope", "resource_scope 必须是对象");
 }
 const obj = raw as Record<string, unknown>;
 const type = obj.type;
 if (typeof type !== "string") {
 throw new ResourceScopeError("malformed_scope", "resource_scope.type 必须是字符串");
 }
 if (!isKnownResourceScopeType(type)) {
 throw new ResourceScopeError("unknown_scope_type", `未知 resource scope type: ${type}`);
 }

 const scope: ResourceScope = { type };

 if (obj.wildcard === true) {
 scope.wildcard = true;
 }

 if (obj.ids !== undefined) {
 if (!Array.isArray(obj.ids) || !obj.ids.every((id) => typeof id === "string")) {
 throw new ResourceScopeError("malformed_scope", "ids 必须是字符串数组");
 }
 scope.ids = obj.ids as string[];
 }

 // 空 allowlist = 全 deny（最小权限）：既无 wildcard 也无非空 ids。
 if (!scope.wildcard && (!scope.ids || scope.ids.length === 0)) {
 throw new ResourceScopeError("malformed_scope", "resource_scope 必须指定 wildcard 或非空 ids");
 }

 return scope;
}

/** 将 ResourceScope 序列化为 resource_scope_json（稳定字段顺序，便于 hash）。 */
export function serializeResourceScope(scope: ResourceScope): string {
 return JSON.stringify(scope, ["type", "wildcard", "ids"]);
}

/**
 * 判断 binding scope 是否覆盖请求的资源。
 *
 * 规则：
 * - type 不匹配 → false（agent scope 不能覆盖 tool 资源）。
 * - wildcard=true → 覆盖该 type 下所有资源。
 * - 否则 ids 必须包含 requested.id。
 */
export function scopeCovers(
 binding: ResourceScope,
 requested: { type: ResourceScopeType; id: string },
): boolean {
 if (binding.type !== requested.type) return false;
 if (binding.wildcard) return true;
 return Array.isArray(binding.ids) && binding.ids.includes(requested.id);
}
