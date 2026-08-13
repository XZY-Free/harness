/**
 * 动作资源授权守卫。
 *
 * 事实源：
 * - docs/architecture/security.md §5
 * - docs/architecture/api-and-events.md §9
 *
 * 服务端只依赖 action_code + resource_scope 判断；UI 菜单权限不能代替服务端 action_code。
 * - 空 allowlist、未知 action、无法解析 scope 全部拒绝（fail-closed）。
 * - 外部角色只通过 principal_binding 映射，不直接出现在业务判断分支。
 * - 管理员也不能读取 Credential 原值（由 route 层配合 Credential 不可见规则保证）。
 *
 * 身份分发：
 * - Principal（employee/admin audience）→ 查 role_action_binding。
 * - WorkloadPrincipal callerType=service → 查 CICD_SERVICE_ALLOWED_ACTIONS（无 resource_scope 绑定）。
 * - WorkloadPrincipal callerType=workload（runtime/gateway）→ 不走 action scope（由 ExecutionBinding 约束）→ 拒绝。
 */
import type { ApiErrorCode } from "@/lib/error-codes";
import { apiError, generateRequestId } from "@/lib/http";
import {
 type ActionCode,
 type ResourceScopeType,
 isKnownActionCode,
} from "@/lib/identity/action-codes";
import type { Principal, WorkloadPrincipal } from "@/lib/identity/resolver";
import type { ResourceScope } from "@/lib/identity/resource-scope";
import { scopeCovers } from "@/lib/identity/resource-scope";
import {
 listActiveActionBindingsForUser,
 parseBindingScope,
} from "@/lib/identity/role-action-queries";
import { isServiceActionAllowed } from "@/lib/identity/workload-token";

/** 授权检查请求：action_code + 目标资源。 */
export interface ActionScopeRequest {
 actionCode: ActionCode;
 /** 目标资源（type + id）。wildcard 绑定覆盖同 type 下所有 id。 */
 resource: { type: ResourceScopeType; id: string };
}

/** 授权失败原因。 */
export type AuthorizationDenyReason =
 | "unknown_action"
 | "empty_allowlist"
 | "action_scope_denied"
 | "workload_not_action_scoped";

/**
 * 检查员工/管理员主体是否拥有 action scope。
 *
 * 流程：
 * 1. actionCode 不在稳定目录 → false（unknown_action）。
 * 2. 查用户当前有效的 role_action_binding → 空 → false（empty_allowlist）。
 * 3. 遍历绑定，解析 resource_scope → scopeCovers(request.resource) → true。
 * 4. 全部不匹配 → false（action_scope_denied）。
 *
 * @returns true=允许，false=拒绝
 */
export async function checkActionScope(
 tenantId: string,
 userIdentityId: string,
 request: ActionScopeRequest,
): Promise<{ allowed: boolean; reason?: AuthorizationDenyReason }> {
 // 未知 action 一律拒绝（fail-closed）。
 if (!isKnownActionCode(request.actionCode)) {
 return { allowed: false, reason: "unknown_action" };
 }

 const bindings = await listActiveActionBindingsForUser(tenantId, userIdentityId);

 // 仅过滤 actionCode 匹配的绑定（listActiveActionBindingsForUser 返回全部 action 的绑定）。
 const matching = bindings.filter((b) => b.actionCode === request.actionCode);
 if (matching.length === 0) {
 return { allowed: false, reason: "empty_allowlist" };
 }

 for (const binding of matching) {
 const scope = parseBindingScope(binding);
 // DB 中存了非法 scope（不应发生）→ 跳过该绑定（fail-closed）。
 if (scope === null) continue;
 if (scopeCovers(scope, request.resource)) {
 return { allowed: true };
 }
 }

 return { allowed: false, reason: "action_scope_denied" };
}

/**
 * 检查 Service Identity 是否拥有 action scope。
 *
 * Service Identity 不走 role_action_binding（无 principal_binding）。
 * 授权由 CICD_SERVICE_ALLOWED_ACTIONS 白名单决定（workload-token.ts）。
 * 资源 scope 由 route 层单独校验（如 CI/CD 只能提交本项目的 attestation）。
 *
 * @returns true=允许（action 在白名单内），false=拒绝
 */
export function checkServiceActionScope(
 serviceId: string,
 request: ActionScopeRequest,
): { allowed: boolean; reason?: AuthorizationDenyReason } {
 if (!isKnownActionCode(request.actionCode)) {
 return { allowed: false, reason: "unknown_action" };
 }
 if (!isServiceActionAllowed(serviceId, request.actionCode)) {
 return { allowed: false, reason: "action_scope_denied" };
 }
 return { allowed: true };
}

/**
 * 统一授权入口：根据主体类型分发检查，失败返回 403 ACTION_SCOPE_DENIED 响应。
 *
 * 用法：
 * ```ts
 * const r = await requireActionScope(principal, { actionCode: "agent.publish", resource: { type: "agent", id: agentId } }, requestId);
 * if (!r.ok) return r.response;
 * ```
 *
 * @param principal Principal（employee/admin）或 WorkloadPrincipal（service/workload）
 * @param request action_code + resource
 * @param requestId 请求 id（来自 getRequestId），缺省自动生成
 */
export async function requireActionScope(
 principal: Principal | WorkloadPrincipal,
 request: ActionScopeRequest,
 requestId: string = generateRequestId(),
): Promise<{ ok: true } | { ok: false; response: Response }> {
 let result: { allowed: boolean; reason?: AuthorizationDenyReason };

 if ("userIdentityId" in principal) {
 // Principal（employee/admin）
 result = await checkActionScope(principal.tenantId, principal.userIdentityId, request);
 } else if (principal.callerType === "service") {
 // CI/CD Service Identity
 result = checkServiceActionScope(principal.serviceId ?? "", request);
 } else {
 // runtime/gateway workload — 不走 action scope
 result = { allowed: false, reason: "workload_not_action_scoped" };
 }

 if (result.allowed) {
 return { ok: true };
 }

 const message = denyMessage(result.reason, request);
 const code: ApiErrorCode = "ACTION_SCOPE_DENIED";
 return { ok: false, response: apiError(code, message, { requestId }) };
}

function denyMessage(
 reason: AuthorizationDenyReason | undefined,
 request: ActionScopeRequest,
): string {
 switch (reason) {
 case "unknown_action":
 return `未知 action code: ${request.actionCode}`;
 case "empty_allowlist":
 return `主体无 ${request.actionCode} 授权`;
 case "workload_not_action_scoped":
 return "Runtime/Gateway Workload 不走 action scope 授权";
 case "action_scope_denied":
 return `主体无 ${request.actionCode} 对资源 ${request.resource.type}:${request.resource.id} 的授权`;
 default:
 return `主体无 ${request.actionCode} 对资源 ${request.resource.type}:${request.resource.id} 的授权`;
 }
}
