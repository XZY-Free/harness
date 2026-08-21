/**
 * Studio 访问适配层（关口02 02-2）。
 *
 * 把旧 lib/rbac.ts 的 PERMISSIONS / requirePermission / hasPermission 授权入口
 * 归并进正式 Authorization 单一模型：
 * - 身份解析 → lib/identity/resolver 的 resolvePrincipal（返回 Principal）。
 * - 动作授权 → lib/identity/authorization 的 requireActionScope（action code + resource scope）。
 *
 * Action Code = 动作，Resource Scope = 资源范围。旧 RBAC 把 scope 编进权限字符串
 * （thread.write.self / thread.read.all）的语义已解码：.self 用 (self) 资源，
 * 全量用 (tenant) 资源；细粒度资源级由既有 owner guard / resource scope 决定。
 *
 * 用法：
 *   const r = await requireStudioAction(request, "skill.write");
 *   if (!r.ok) return r.response;
 *   const p = r.principal; // p.userIdentityId / p.displayName ...
 *
 * 只解析当前主体（不校验动作）：
 *   const principal = await resolveStudioPrincipal(request);
 */
import { studioConfig } from "@/lib/config";
import { DEFAULT_USER_ID } from "@/lib/constants";
import { type ActionCode, type ResourceScopeType } from "@/lib/identity/action-codes";
import { checkActionScope, requireActionScope } from "@/lib/identity/authorization";
import {
  authErrorResponse,
  resolvePrincipal,
  type Principal,
} from "@/lib/identity/resolver";
import { generateRequestId } from "@/lib/http";

/** 只解析当前主体，不校验动作。认证失败抛 AuthenticationError（路由 catch 转 401/500）。 */
export async function resolveStudioPrincipal(headers: Headers): Promise<Principal> {
  return resolvePrincipal(headers);
}

/**
 * 解析目标资源。
 *
 * 旧 RBAC 把 scope 编进权限字符串（thread.write.self / thread.read.all）：
 * - `.all` → (tenant 资源)，覆盖租户内全部。
 * - `.self` → (self 资源)，覆盖主体自己的资源（id = principal.userIdentityId）。
 * resource 缺省为 (tenant, principal.tenantId)。非 tenant/self 类型必须显式提供 id。
 */
function resolveResourceTarget(
  resource: { type: ResourceScopeType; id?: string } | undefined,
  principal: Principal,
): { type: ResourceScopeType; id: string } {
  if (!resource) return { type: "tenant", id: principal.tenantId };
  if (resource.type === "self") return { type: "self", id: principal.userIdentityId };
  if (!resource.id) {
    if (resource.type === "tenant") return { type: "tenant", id: principal.tenantId };
    throw new Error(`resource scope ${resource.type} 必须提供 id`);
  }
  return { type: resource.type, id: resource.id };
}

/**
 * Studio 动作授权门：解析主体 → 校验 action scope。
 *
 * @param request 请求（读 headers 解析身份）
 * @param actionCode Studio 动作码（复用/新增的 canonical action code）
 * @param resource 目标资源；缺省为 (tenant, principal.tenantId)。`{ type: "self" }`
 *   解析为 (self, principal.userIdentityId)（旧 thread.write.self 语义）。
 * @returns ok=true 携带 principal；ok=false 携带 401/403 Response。
 */
export async function requireStudioAction(
  request: { headers: Headers },
  actionCode: ActionCode,
  resource?: { type: ResourceScopeType; id?: string },
): Promise<{ ok: true; principal: Principal } | { ok: false; response: Response }> {
  const requestId = generateRequestId();
  let principal: Principal;
  try {
    principal = await resolvePrincipal(request.headers);
  } catch (error) {
    const authResp = authErrorResponse(error, requestId);
    if (authResp) return { ok: false, response: authResp };
    throw error; // 非认证异常上抛，由路由 catch 统一转 500。
  }

  // dev/test 零回归旁路（与原 lib/rbac.ts 一致）：devOpen 下默认用户免查 DB。
  // 生产（trusted-headers）不触发，仍走真实 RoleActionBinding 校验。
  if (studioConfig.devOpen && principal.externalSubject === DEFAULT_USER_ID) {
    return { ok: true, principal };
  }

  const target = resolveResourceTarget(resource, principal);
  const result = await requireActionScope(principal, { actionCode, resource: target }, requestId);
  if (!result.ok) return { ok: false, response: result.response };
  return { ok: true, principal };
}

/**
 * Studio 动作布尔谓词（替代旧 hasPermission(user.id, "X")）。
 *
 * 用于路由内根据权限分支（如 admin vs member 差异）。devOpen 默认用户返回 true。
 * resource 缺省为 {type:"tenant", id: principal.tenantId}。
 */
export async function hasStudioAction(
  principal: Principal,
  actionCode: ActionCode,
  resource?: { type: ResourceScopeType; id?: string },
): Promise<boolean> {
  if (studioConfig.devOpen && principal.externalSubject === DEFAULT_USER_ID) {
    return true;
  }
  const target = resolveResourceTarget(resource, principal);
  const result = await checkActionScope(principal.tenantId, principal.userIdentityId, {
    actionCode,
    resource: target,
  });
  return result.allowed;
}
