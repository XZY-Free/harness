/**
 * 动作资源授权守卫（消费方薄壳）。
 *
 * nexharness 已不是授权权威：role/assignment/policy 数据与评测引擎都在 auth-center
 * （消费方模型，见 docs/split 施工图 v4）。本模块保留历史签名，内部分两路：
 *
 * - **实时授权**（变更/敏感操作、显式 `realtime: true`、快照不可用时的兜底）：
 *   auth-center `POST /api/authorize`，fail-closed。
 * - **快照本地匹配**（默认路径，快照命中时）：auth-center 权限快照（提前展开的
 *   允许清单）缓存在进程内，直接做清单匹配，不做角色模板推导。
 *
 * 覆盖投影 `resolveActionScopeCoverage` 恒走快照（导航/入口可见性）；快照不可用
 * 时返回空覆盖（fail-closed，不误暴露入口）。
 *
 * 身份分发（不变）：
 * - Principal（employee/admin）→ 上述两路。
 * - ServicePrincipal → CI/CD 动作白名单（本地，无 resource_scope 绑定）。
 * - WorkloadPrincipal（runtime/gateway）→ 不走 action scope → 拒绝。
 */
import type { ApiErrorCode } from "@/lib/error-codes";
import { apiError, generateRequestId } from "@/lib/http";
import {
  authorizeForUser,
  coverageFromSnapshot,
  evaluateSnapshot,
  getSnapshot,
  peekSnapshot,
} from "@/lib/identity-client";
import {
  type ActionCode,
  type ResourceScopeType,
  isKnownActionCode,
} from "@/lib/identity/action-codes";
import type { Principal, WorkloadPrincipal } from "@/lib/identity/resolver";
import {
  type ServicePrincipal,
  isServiceActionAllowed,
  isServicePrincipal,
} from "@/lib/identity/service-identity";

/** 授权检查请求：action_code + 目标资源。 */
export interface ActionScopeRequest {
  actionCode: ActionCode;
  /** 目标资源（type + id）。wildcard 绑定覆盖同 type 下所有 id；null = 基础 Harness RouteSet（无 Agent）。 */
  resource: { type: ResourceScopeType; id: string | null };
}

/** 当前主体对某个 action/resource type 的有效覆盖，用于批量查询与缓存摘要。 */
export interface ActionScopeCoverage {
  actionCode: ActionCode;
  resourceType: ResourceScopeType;
  wildcard: boolean;
  resourceIds: readonly string[];
  authorizationDigest: string;
}

/**
 * 列表与单资源检查共用同一评测语义（快照本地匹配版）。
 * 快照不可用时返回空覆盖（fail-closed；入口不显示、列表为空）。
 */
export async function resolveActionScopeCoverage(
  tenantId: string,
  userIdentityId: string,
  request: { actionCode: ActionCode; resourceType: ResourceScopeType },
): Promise<ActionScopeCoverage> {
  try {
    const snapshot = await getSnapshot(tenantId, userIdentityId);
    const coverage = coverageFromSnapshot(snapshot, request);
    return {
      actionCode: request.actionCode,
      resourceType: request.resourceType,
      wildcard: coverage.wildcard,
      resourceIds: coverage.resourceIds,
      authorizationDigest: coverage.authorizationDigest,
    };
  } catch (error) {
    console.error(
      "[identity-client] 权限快照不可用，覆盖查询 fail-closed 返回空覆盖：",
      error instanceof Error ? error.message : error,
    );
    return {
      actionCode: request.actionCode,
      resourceType: request.resourceType,
      wildcard: false,
      resourceIds: [],
      authorizationDigest: "unavailable",
    };
  }
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
 * @param options.realtime 强制走 auth-center 实时授权（变更/敏感操作、执行链）。
 *   缺省时：快照命中（进程缓存且未过期）走本地清单匹配；未命中走实时授权。
 */
export async function checkActionScope(
  tenantId: string,
  userIdentityId: string,
  request: ActionScopeRequest,
  options: { realtime?: boolean } = {},
): Promise<{ allowed: boolean; reason?: AuthorizationDenyReason }> {
  // 未知 action 一律拒绝（fail-closed）。
  if (!isKnownActionCode(request.actionCode)) {
    return { allowed: false, reason: "unknown_action" };
  }

  if (!options.realtime) {
    const snapshot = peekSnapshot(tenantId, userIdentityId);
    if (snapshot) {
      const decision = evaluateSnapshot(snapshot, request);
      if (decision.allowed) return { allowed: true };
      return {
        allowed: false,
        reason: snapshot.grants.some((g) => g.actionCode === request.actionCode)
          ? "action_scope_denied"
          : "empty_allowlist",
      };
    }
  }

  try {
    const result = await authorizeForUser(userIdentityId, [request]);
    const decision = result.decisions[0];
    if (!decision) return { allowed: false, reason: "action_scope_denied" };
    return decision.allowed ? { allowed: true } : { allowed: false, reason: "action_scope_denied" };
  } catch (error) {
    console.error(
      "[identity-client] 实时授权不可用，fail-closed 拒绝：",
      error instanceof Error ? error.message : error,
    );
    return { allowed: false, reason: "action_scope_denied" };
  }
}

/** Turn 选择 Agent 的正式服务端授权入口（实时）。 */
export function requireAgentInvokeScope(
  principal: Principal | WorkloadPrincipal | ServicePrincipal,
  agentId: string,
  requestId?: string,
) {
  return requireActionScope(
    principal,
    { actionCode: "agent.invoke", resource: { type: "agent", id: agentId } },
    requestId,
  );
}

/**
 * 检查 Service Identity 是否拥有 action scope。
 *
 * Service Identity 不走 principal 授权（无 principal_binding）。
 * 授权由 CICD_SERVICE_ALLOWED_ACTIONS 白名单决定（本地 workload-token 模块）。
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
 * 员工/管理员主体恒走**实时授权**（这是执法点，不做快照缓存）——变更与
 * 敏感操作 100% 实时、auth-center 不可达时 fail-closed。
 *
 * @param principal Principal、ServicePrincipal 或 WorkloadPrincipal
 * @param request action_code + resource
 * @param requestId 请求 id（来自 getRequestId），缺省自动生成
 */
export async function requireActionScope(
  principal: Principal | WorkloadPrincipal | ServicePrincipal,
  request: ActionScopeRequest,
  requestId: string = generateRequestId(),
): Promise<{ ok: true } | { ok: false; response: Response }> {
  let result: { allowed: boolean; reason?: AuthorizationDenyReason };

  if ("userIdentityId" in principal) {
    // Principal（employee/admin）→ auth-center 实时授权。
    result = await checkActionScope(principal.tenantId, principal.userIdentityId, request, {
      realtime: true,
    });
  } else if (isServicePrincipal(principal)) {
    // CI/CD Service Identity → 本地白名单。
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
