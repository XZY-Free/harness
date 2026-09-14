import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { agentTable } from "@/lib/persistence/schema/agents";
import {
  permissionGroup,
  permissionGroupMember,
  permissionRole,
  permissionRoleAssignment,
  resourceAccessPolicy,
} from "@/lib/persistence/schema/authorization";
import { principalBinding, tenant, userIdentity } from "@/lib/persistence/schema/identity";
import { recordAdminAudit } from "@/lib/studio/admin-audit";
import { and, eq, inArray } from "drizzle-orm";
import { evaluatePermission, loadPermissionContext } from "./permission-context";
import { type PermissionGrant, parsePermissionGrants } from "./permission-directory";
import { ROLE_TEMPLATES } from "./role-templates";

export class PermissionManagementError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function fail(code: string, message: string, status = 400): never {
  throw new PermissionManagementError(code, message, status);
}
function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return fail("invalid_input", "名称或标识无效");
  return value.trim();
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((v) => typeof v !== "string" || !v || v.length > 128) ||
    new Set(value).size !== value.length
  )
    return fail("invalid_input", "成员或角色列表无效");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid_input", "请求格式无效");
  return value as Record<string, unknown>;
}
function checkVersion(expected: unknown, actual: number) {
  if (expected !== actual) fail("version_conflict", "内容已被其他管理员更新，请刷新后再试", 409);
}
function roleGrants(key: string, roles: Awaited<ReturnType<typeof listRoles>>): PermissionGrant[] {
  const role = roles.find((r) => r.key === key);
  if (!role) return fail("role_not_found", "角色不存在", 404);
  return role.grants;
}
export async function listRoles(tenantId: string, database: DbOrTx = db) {
  const custom = await database
    .select()
    .from(permissionRole)
    .where(eq(permissionRole.tenantId, tenantId));
  return [
    ...ROLE_TEMPLATES.map((r) => ({ ...r, grants: r.grants as PermissionGrant[], version: 1 })),
    ...custom.map((r) => ({
      key: r.id,
      name: r.name,
      isSystem: false,
      grants: parsePermissionGrants(r.permissions),
      version: r.version,
    })),
  ];
}
export async function listPermissionManagement(tenantId: string) {
  const [users, principals, groups, members, assignments, roles, agents, policies] =
    await Promise.all([
      db
        .select({
          id: userIdentity.id,
          displayName: userIdentity.displayName,
          email: userIdentity.email,
          status: userIdentity.status,
        })
        .from(userIdentity)
        .where(eq(userIdentity.tenantId, tenantId)),
      db.select().from(principalBinding).where(eq(principalBinding.tenantId, tenantId)),
      db.select().from(permissionGroup).where(eq(permissionGroup.tenantId, tenantId)),
      db.select().from(permissionGroupMember).where(eq(permissionGroupMember.tenantId, tenantId)),
      db
        .select()
        .from(permissionRoleAssignment)
        .where(eq(permissionRoleAssignment.tenantId, tenantId)),
      listRoles(tenantId),
      db
        .select({ id: agentTable.id, name: agentTable.displayName })
        .from(agentTable)
        .where(eq(agentTable.tenantId, tenantId)),
      db.select().from(resourceAccessPolicy).where(eq(resourceAccessPolicy.tenantId, tenantId)),
    ]);
  const now = new Date();
  return {
    users: users.map((u) => ({
      ...u,
      principalId:
        principals.find((p) => p.subjectType === "user" && p.userIdentityId === u.id)?.id ?? null,
    })),
    groups: groups.map((g) => ({
      ...g,
      name: principals.find((p) => p.id === g.principalId)?.displayName ?? "用户组",
      memberIds: members
        .filter((m) => m.groupId === g.principalId && (!m.validUntil || m.validUntil > now))
        .map((m) => m.userId),
    })),
    defaults: {
      mode:
        policies.find((p) => p.resourceType === "tenant" && p.resourceId === tenantId)?.mode ??
        "all",
      version:
        policies.find((p) => p.resourceType === "tenant" && p.resourceId === tenantId)?.version ??
        0,
      inheritedAssets: agents.filter((a) =>
        policies.some(
          (p) => p.resourceType === "agent" && p.resourceId === a.id && p.mode === "inherit",
        ),
      ),
    },
    tenantId,
    assignments,
    roles,
    agents,
  };
}
export type PermissionManagementView = Awaited<ReturnType<typeof listPermissionManagement>>;

/** 所有管理变更锁定同一租户，鉴权、并发控制、关系变更及审计在一个事务中完成。 */
export async function changePermissionManagement(
  tenantId: string,
  actorId: string,
  input: unknown,
) {
  const command = record(input);
  const operation = text(command.operation);
  return db.transaction(async (tx) => {
    await tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.id, tenantId)).for("update");
    const actor = await loadPermissionContext(tenantId, actorId, tx);
    const manages = evaluatePermission(actor, {
      actionCode: "user.manage",
      resource: { type: "tenant", id: tenantId },
    }).allowed;
    if (!manages && operation !== "save_access")
      fail("permission_denied", "没有成员与权限管理权限", 403);
    const roles = await listRoles(tenantId, tx);
    let targetId = tenantId;
    let result: Record<string, unknown> = {};
    let before: unknown = null;
    const ensureGrantable = (grants: PermissionGrant[]) => {
      for (const grant of grants) {
        // 转授范围必须是操作者已有范围的子集，不能用一个样本资源验证 wildcard。
        const covered = actor.grants.some(
          (g) =>
            g.actionCode === grant.actionCode &&
            g.resourceScope.type === grant.resourceScope.type &&
            (!g.validFrom ||
              !grant.validFrom ||
              Date.parse(grant.validFrom) >= Date.parse(g.validFrom)) &&
            (!g.validUntil ||
              (grant.validUntil && Date.parse(grant.validUntil) <= Date.parse(g.validUntil))) &&
            (g.resourceScope.wildcard ||
              (!grant.resourceScope.wildcard &&
                grant.resourceScope.ids?.every((id) => g.resourceScope.ids?.includes(id)))),
        );
        if (!covered) fail("delegation_denied", "不能授予超出自身范围的权限", 403);
      }
    };
    if (operation === "save_defaults") {
      if (!["all", "restricted"].includes(String(command.mode)))
        fail("invalid_scope", "平台默认范围无效");
      const [existing] = await tx
        .select()
        .from(resourceAccessPolicy)
        .where(
          and(
            eq(resourceAccessPolicy.tenantId, tenantId),
            eq(resourceAccessPolicy.resourceType, "tenant"),
            eq(resourceAccessPolicy.resourceId, tenantId),
          ),
        );
      checkVersion(command.version, existing?.version ?? 0);
      before = existing ?? null;
      const values = {
        mode: String(command.mode),
        principals: [],
        collaborators: [],
        version: (existing?.version ?? 0) + 1,
      };
      if (existing)
        await tx
          .update(resourceAccessPolicy)
          .set(values)
          .where(eq(resourceAccessPolicy.id, existing.id));
      else
        await tx
          .insert(resourceAccessPolicy)
          .values({ tenantId, resourceType: "tenant", resourceId: tenantId, ...values });
      result = { version: values.version };
    } else if (operation === "save_role") {
      const name = text(command.name);
      let grants: PermissionGrant[];
      try {
        grants = parsePermissionGrants(command.grants);
      } catch {
        fail("invalid_input", "权限动作、资源范围或有效期无效");
      }
      ensureGrantable(grants);
      if (command.id) {
        targetId = text(command.id);
        const existing = roles.find((r) => r.key === targetId);
        if (!existing || existing.isSystem) fail("protected_role", "内置角色不可修改", 409);
        checkVersion(command.version, existing.version);
        before = existing;
        await tx
          .update(permissionRole)
          .set({ name, permissions: grants, version: existing.version + 1 })
          .where(and(eq(permissionRole.tenantId, tenantId), eq(permissionRole.id, targetId)));
      } else {
        targetId = randomUUID();
        await tx
          .insert(permissionRole)
          .values({ id: targetId, tenantId, name, permissions: grants });
      }
      const after = await loadPermissionContext(tenantId, actorId, tx);
      if (
        !evaluatePermission(after, {
          actionCode: "user.manage",
          resource: { type: "tenant", id: tenantId },
        }).allowed
      )
        fail("self_lockout", "不能移除自身最后的权限管理能力", 409);
      result = { id: targetId };
    } else if (operation === "delete_role") {
      targetId = text(command.id);
      const existing = roles.find((r) => r.key === targetId);
      if (!existing || existing.isSystem) fail("protected_role", "内置角色不可删除", 409);
      checkVersion(command.version, existing.version);
      ensureGrantable(existing.grants);
      const uses = await tx
        .select()
        .from(permissionRoleAssignment)
        .where(
          and(
            eq(permissionRoleAssignment.tenantId, tenantId),
            eq(permissionRoleAssignment.roleKey, targetId),
          ),
        );
      if (uses.length) fail("role_in_use", "请先移除角色分配", 409);
      await tx
        .delete(permissionRole)
        .where(and(eq(permissionRole.tenantId, tenantId), eq(permissionRole.id, targetId)));
      before = existing;
    } else if (operation === "set_roles") {
      targetId = text(command.principalId);
      const roleKeys = ids(command.roleKeys);
      if (roleKeys.includes("member")) fail("default_role", "普通员工是默认身份，无需分配");
      const [principal] = await tx
        .select()
        .from(principalBinding)
        .where(and(eq(principalBinding.tenantId, tenantId), eq(principalBinding.id, targetId)));
      if (!principal) fail("principal_not_found", "成员或组不存在", 404);
      if (principal.subjectType !== "user") {
        const [group] = await tx
          .select()
          .from(permissionGroup)
          .where(
            and(eq(permissionGroup.tenantId, tenantId), eq(permissionGroup.principalId, targetId)),
          );
        if (!group) fail("group_not_found", "用户组不存在", 404);
      }
      const current = await tx
        .select()
        .from(permissionRoleAssignment)
        .where(
          and(
            eq(permissionRoleAssignment.tenantId, tenantId),
            eq(permissionRoleAssignment.principalId, targetId),
            eq(permissionRoleAssignment.source, "local"),
          ),
        );
      for (const key of roleKeys) {
        const grants = roleGrants(key, roles);
        if (!current.some((a) => a.roleKey === key)) ensureGrantable(grants);
      }
      const expected = ids(command.expectedRoleKeys);
      if (JSON.stringify(expected.sort()) !== JSON.stringify(current.map((a) => a.roleKey).sort()))
        fail("version_conflict", "角色已被其他管理员修改，请刷新", 409);
      before = current.map((a) => a.roleKey);
      await tx
        .delete(permissionRoleAssignment)
        .where(
          and(
            eq(permissionRoleAssignment.tenantId, tenantId),
            eq(permissionRoleAssignment.principalId, targetId),
            eq(permissionRoleAssignment.source, "local"),
          ),
        );
      if (roleKeys.length)
        await tx.insert(permissionRoleAssignment).values(
          roleKeys.map((roleKey) => ({
            tenantId,
            principalId: targetId,
            roleKey,
            source: "local",
          })),
        );
      // 保存后再次求值自身；支持其他有效来源，避免把取消一项等同于失去权限。
      const after = await loadPermissionContext(tenantId, actorId, tx);
      if (
        !evaluatePermission(after, {
          actionCode: "user.manage",
          resource: { type: "tenant", id: tenantId },
        }).allowed
      )
        fail("self_lockout", "不能移除自身最后的权限管理能力", 409);
      result = { roleKeys };
    } else if (operation === "save_group" || operation === "delete_group") {
      targetId = command.id ? text(command.id) : randomUUID();
      const [existing] = await tx
        .select()
        .from(permissionGroup)
        .where(
          and(eq(permissionGroup.tenantId, tenantId), eq(permissionGroup.principalId, targetId)),
        );
      if (command.id && !existing) fail("group_not_found", "用户组不存在", 404);
      if (existing) {
        if (existing.source !== "local") fail("managed_group", "企业同步的用户组只读", 409);
        checkVersion(command.version, existing.version);
      }
      const groupRoles = await tx
        .select()
        .from(permissionRoleAssignment)
        .where(
          and(
            eq(permissionRoleAssignment.tenantId, tenantId),
            eq(permissionRoleAssignment.principalId, targetId),
          ),
        );
      for (const assignment of groupRoles) ensureGrantable(roleGrants(assignment.roleKey, roles));
      const memberIds = operation === "save_group" ? ids(command.memberIds) : [];
      if (memberIds.length) {
        const members = await tx
          .select({ id: userIdentity.id })
          .from(userIdentity)
          .where(and(eq(userIdentity.tenantId, tenantId), inArray(userIdentity.id, memberIds)));
        if (members.length !== memberIds.length) fail("invalid_members", "成员不属于当前租户");
      }
      before = existing ?? null;
      if (operation === "delete_group") {
        const references = await tx
          .select()
          .from(resourceAccessPolicy)
          .where(eq(resourceAccessPolicy.tenantId, tenantId));
        if (
          groupRoles.length ||
          references.some((p) => JSON.stringify([p.principals, p.collaborators]).includes(targetId))
        )
          fail("group_in_use", "用户组仍被角色或资产引用，请先移除引用", 409);
        await tx
          .delete(permissionGroupMember)
          .where(
            and(
              eq(permissionGroupMember.tenantId, tenantId),
              eq(permissionGroupMember.groupId, targetId),
            ),
          );
        await tx.delete(permissionGroup).where(eq(permissionGroup.principalId, targetId));
        await tx
          .delete(principalBinding)
          .where(and(eq(principalBinding.tenantId, tenantId), eq(principalBinding.id, targetId)));
      } else {
        const name = text(command.name);
        if (existing) {
          await tx
            .update(principalBinding)
            .set({ displayName: name })
            .where(and(eq(principalBinding.tenantId, tenantId), eq(principalBinding.id, targetId)));
          await tx
            .update(permissionGroup)
            .set({ version: existing.version + 1 })
            .where(eq(permissionGroup.principalId, targetId));
        } else {
          await tx.insert(principalBinding).values({
            id: targetId,
            tenantId,
            subjectType: "group",
            externalId: `local:${targetId}`,
            displayName: name,
          });
          await tx
            .insert(permissionGroup)
            .values({ principalId: targetId, tenantId, source: "local" });
        }
        await tx
          .delete(permissionGroupMember)
          .where(
            and(
              eq(permissionGroupMember.tenantId, tenantId),
              eq(permissionGroupMember.groupId, targetId),
            ),
          );
        if (memberIds.length)
          await tx
            .insert(permissionGroupMember)
            .values(memberIds.map((userId) => ({ tenantId, groupId: targetId, userId })));
        const after = await loadPermissionContext(tenantId, actorId, tx);
        if (
          !evaluatePermission(after, {
            actionCode: "user.manage",
            resource: { type: "tenant", id: tenantId },
          }).allowed
        )
          fail("self_lockout", "不能移除自身最后的权限管理能力", 409);
      }
      result = { id: targetId };
    } else if (operation === "save_access") {
      targetId = text(command.resourceId);
      const resourceType = text(command.resourceType);
      if (resourceType !== "agent") fail("unsupported_resource", "当前资源不支持此访问配置");
      const [agent] = await tx
        .select()
        .from(agentTable)
        .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, targetId)));
      if (!agent || agent.deletedAt) fail("resource_not_found", "智能体不存在", 404);
      if (!manages && agent.ownerUserId !== actorId)
        fail("permission_denied", "仅资产负责人或权限管理员可以调整使用范围", 403);
      if (!["inherit", "all", "restricted", "roles"].includes(String(command.mode)))
        fail("invalid_scope", "使用范围无效");
      const principalIds = ids(command.principals);
      const collaborators = Array.isArray(command.collaborators) ? command.collaborators : [];
      if (collaborators.length > 1000) fail("invalid_scope", "协作成员过多");
      const normalized = collaborators.map((v) => {
        const c = record(v);
        const actions = ids(c.actions);
        if (
          actions.some(
            (a) =>
              ![
                "agent.read",
                "agent.revision.create",
                "agent.publish",
                "agent.retract",
                "route.update",
              ].includes(a),
          )
        )
          fail("invalid_scope", "协作动作无效");
        return { principalId: text(c.principalId), actions };
      });
      const allIds = [...new Set([...principalIds, ...normalized.map((c) => c.principalId)])];
      if (allIds.length) {
        const found = await tx
          .select({ id: principalBinding.id })
          .from(principalBinding)
          .where(
            and(eq(principalBinding.tenantId, tenantId), inArray(principalBinding.id, allIds)),
          );
        if (found.length !== allIds.length) fail("invalid_scope", "使用范围含无效或其他租户的主体");
      }
      const [existing] = await tx
        .select()
        .from(resourceAccessPolicy)
        .where(
          and(
            eq(resourceAccessPolicy.tenantId, tenantId),
            eq(resourceAccessPolicy.resourceType, resourceType),
            eq(resourceAccessPolicy.resourceId, targetId),
          ),
        );
      checkVersion(command.version, existing?.version ?? 0);
      before = existing ?? null;
      const values = {
        mode: String(command.mode),
        principals: principalIds,
        collaborators: normalized,
        version: (existing?.version ?? 0) + 1,
      };
      if (existing)
        await tx
          .update(resourceAccessPolicy)
          .set(values)
          .where(eq(resourceAccessPolicy.id, existing.id));
      else
        await tx
          .insert(resourceAccessPolicy)
          .values({ tenantId, resourceType, resourceId: targetId, ...values });
      result = { version: values.version };
    } else fail("invalid_operation", "未知权限管理操作");
    await recordAdminAudit(
      {
        actorUserId: actorId,
        action: "permissions.updated",
        targetType: operation,
        targetId,
        outcome: "succeeded",
        metadata: { operation, before, after: command },
      },
      tx,
    );
    return result;
  });
}
