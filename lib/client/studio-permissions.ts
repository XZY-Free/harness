import { coverageFromSnapshot, evaluateSnapshot } from "@/lib/identity-client/evaluate";
import type { PermissionSnapshot } from "@/lib/identity-client/snapshot";
/**
 * Studio 页面权限轻量断言（消费方快照本地匹配）。
 *
 * 与服务端评测同源：直接复用 identity-client 的**纯函数**
 * （evaluateSnapshot / coverageFromSnapshot）对权限快照做清单匹配，
 * 不发网络请求、不做角色模板推导。
 *
 * 安全边界：本模块仅用于 UI 入口显隐（"隐藏菜单不能代替授权校验"）；
 * 一切数据与写操作仍由服务端 API（requireStudioAction / requireActionScope）
 * 实时兜底（fail-closed）。
 */
import { ACTION_RESOURCE_TYPES, type ActionCode } from "@/lib/identity/action-codes";

/** 租户域动作检查（对应服务端 hasStudioAction 的缺省 resource = tenant）。 */
export function snapshotAllowsTenantAction(
  snapshot: PermissionSnapshot,
  action: ActionCode,
): boolean {
  return evaluateSnapshot(snapshot, {
    actionCode: action,
    resource: { type: "tenant", id: snapshot.tenantId },
  }).allowed;
}

/** 智能体域动作检查（对应 hasStudioAction(principal, action, { type: "agent", id })）。 */
export function snapshotAllowsAgentAction(
  snapshot: PermissionSnapshot,
  action: ActionCode,
  agentId: string,
): boolean {
  return evaluateSnapshot(snapshot, {
    actionCode: action,
    resource: { type: "agent", id: agentId },
  }).allowed;
}

/** 任意范围覆盖检查（对应服务端 hasStudioActionInAnyScope）。 */
export function snapshotAllowsAnyScope(snapshot: PermissionSnapshot, action: ActionCode): boolean {
  for (const resourceType of ACTION_RESOURCE_TYPES[action]) {
    const coverage = coverageFromSnapshot(snapshot, { actionCode: action, resourceType });
    if (coverage.wildcard || coverage.resourceIds.length > 0) return true;
  }
  return false;
}
