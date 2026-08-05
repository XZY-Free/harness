/**
 * role_action_binding 仓储。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §8.2。
 *
 * 把 principal_binding 绑定到稳定 action_code + 类型化 resource_scope。
 * - 授权（grant）：写入新绑定，validUntil=null 表示长期有效。
 * - 撤销（revoke）：回填 validUntil=now，不物理删除（保留审计事实）。
 * - 查询：按主体绑定 / 按用户（经 principal_binding 展开）/ 按租户+action。
 *
 * 外部角色（group/role/department）的成员展开依赖组织系统 Adapter，
 * 当前阶段只解析 subjectType=user 的直接绑定；展开钩子预留 expandPrincipalBindingIdsForUser。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type ActionCode,
  type ResourceScopeType,
  assertActionResourceTypeMatch,
} from "@/lib/identity/action-codes";
import {
  type ResourceScope,
  ResourceScopeError,
  parseResourceScope,
  serializeResourceScope,
  validateResourceScope,
} from "@/lib/identity/resource-scope";
import { roleActionBinding } from "@/lib/persistence/schema/authorization";
import type { RoleActionBinding } from "@/lib/persistence/schema/authorization";
import { principalBinding } from "@/lib/persistence/schema/identity";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";

/**
 * 授权：为 principal_binding 绑定 action_code + resource_scope。
 *
 * 校验：
 * - resourceScope.type 必须匹配 ACTION_RESOURCE_TYPES[actionCode]。
 * - resourceScope 必须通过 validateResourceScope（空 allowlist 抛错）。
 *
 * @throws ResourceScopeError scope type 不匹配 / 空 allowlist
 */
export async function grantActionBinding(params: {
  tenantId: string;
  principalBindingId: string;
  actionCode: ActionCode;
  resourceScope: ResourceScope;
  validFrom?: Date;
  /** null（默认）= 长期有效。 */
  validUntil?: Date | null;
}): Promise<RoleActionBinding> {
  const {
    tenantId,
    principalBindingId,
    actionCode,
    resourceScope,
    validFrom = new Date(),
    validUntil = null,
  } = params;

  // 校验 action_code + resource_scope_type 匹配方案目录。
  assertActionResourceTypeMatch(actionCode, resourceScope.type);
  // 校验 scope 非空 allowlist（wildcard 或非空 ids）。
  validateResourceScope(resourceScope);

  const id = randomUUID();
  const scopeJson = serializeResourceScope(resourceScope);
  await db.insert(roleActionBinding).values({
    id,
    tenantId,
    principalBindingId,
    actionCode,
    resourceScopeJson: scopeJson,
    validFrom,
    validUntil,
  });

  const [row] = await db
    .select()
    .from(roleActionBinding)
    .where(eq(roleActionBinding.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`grantActionBinding: 行未找到（id=${id}）`);
  }
  return row;
}

/**
 * 撤销绑定：回填 validUntil = now（不物理删除）。
 * 已撤销（validUntil <= now）返回 false；不存在返回 false。
 */
export async function revokeActionBinding(tenantId: string, bindingId: string): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(roleActionBinding)
    .set({ validUntil: now })
    .where(
      and(
        eq(roleActionBinding.tenantId, tenantId),
        eq(roleActionBinding.id, bindingId),
        // 仅撤销当前有效的绑定（validUntil IS NULL 或 validUntil > now）
        or(isNull(roleActionBinding.validUntil), gte(roleActionBinding.validUntil, now)),
      ),
    );
  return result[0].affectedRows > 0;
}

/** 按 principal_binding 列出所有绑定（含已撤销）。 */
export async function listActionBindingsByPrincipal(
  tenantId: string,
  principalBindingId: string,
): Promise<RoleActionBinding[]> {
  return db
    .select()
    .from(roleActionBinding)
    .where(
      and(
        eq(roleActionBinding.tenantId, tenantId),
        eq(roleActionBinding.principalBindingId, principalBindingId),
      ),
    );
}

/**
 * 按用户列出所有 action 绑定（经 principal_binding 展开）。
 *
 * 当前阶段只展开 subjectType=user 的直接绑定；
 * group/role/department 成员展开依赖组织系统 Adapter，预留扩展钩子。
 */
export async function listActionBindingsByUser(
  tenantId: string,
  userIdentityId: string,
): Promise<RoleActionBinding[]> {
  const principalBindingIds = await expandPrincipalBindingIdsForUser(tenantId, userIdentityId);
  if (principalBindingIds.length === 0) return [];

  return db
    .select()
    .from(roleActionBinding)
    .where(
      and(
        eq(roleActionBinding.tenantId, tenantId),
        inArray(roleActionBinding.principalBindingId, principalBindingIds),
      ),
    );
}

/**
 * 按用户列出当前有效的 action 绑定（validUntil IS NULL 或 > now）。
 * 供授权守卫遍历检查。
 */
export async function listActiveActionBindingsForUser(
  tenantId: string,
  userIdentityId: string,
): Promise<RoleActionBinding[]> {
  const all = await listActionBindingsByUser(tenantId, userIdentityId);
  const now = new Date();
  return all.filter((b) => b.validUntil === null || b.validUntil > now);
}

/** 按 id 获取绑定。不存在返回 null。 */
export async function getActionBindingById(
  tenantId: string,
  bindingId: string,
): Promise<RoleActionBinding | null> {
  const [row] = await db
    .select()
    .from(roleActionBinding)
    .where(and(eq(roleActionBinding.tenantId, tenantId), eq(roleActionBinding.id, bindingId)))
    .limit(1);
  return row ?? null;
}

/**
 * 展开用户关联的所有 principal_binding id。
 *
 * 当前阶段：只返回 subjectType=user 且 userIdentityId 匹配的绑定。
 * 后续组织系统 Adapter 接入后，此处扩展 group/role/department 成员解析。
 */
async function expandPrincipalBindingIdsForUser(
  tenantId: string,
  userIdentityId: string,
): Promise<string[]> {
  const bindings = await db
    .select({ id: principalBinding.id })
    .from(principalBinding)
    .where(
      and(
        eq(principalBinding.tenantId, tenantId),
        eq(principalBinding.userIdentityId, userIdentityId),
      ),
    );
  return bindings.map((b) => b.id);
}

/**
 * 解析绑定的 resource_scope_json。
 * 容错：若 DB 中存了非法 scope（不应发生），返回 null 表示拒绝。
 */
export function parseBindingScope(binding: RoleActionBinding): ResourceScope | null {
  try {
    return parseResourceScope(binding.resourceScopeJson);
  } catch {
    return null;
  }
}

// Re-export 供外部统一从本模块引入类型。
export type { ActionCode, ResourceScopeType } from "@/lib/identity/action-codes";
export type { ResourceScope } from "@/lib/identity/resource-scope";
export { ResourceScopeError } from "@/lib/identity/resource-scope";
