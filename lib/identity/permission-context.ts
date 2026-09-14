import { createHash } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { agentTable } from "@/lib/persistence/schema/agents";
import {
  permissionGroupMember,
  permissionRole,
  permissionRoleAssignment,
  resourceAccessPolicy,
} from "@/lib/persistence/schema/authorization";
import { principalBinding, tenant, userIdentity } from "@/lib/persistence/schema/identity";
import { and, eq } from "drizzle-orm";
import type { ActionScopeRequest } from "./authorization";
import { evaluateEnterpriseAuthorization } from "./enterprise-authorization";
import { getEnterpriseUserProfileFacts } from "./enterprise-user-profile-queries";
import { getIdentityExtensions } from "./identity-extension-bootstrap";
import {
  type PermissionGrant,
  isPermissionGrantActive,
  parsePermissionGrants,
} from "./permission-directory";
import { scopeCovers } from "./resource-scope";
import { ROLE_TEMPLATES } from "./role-templates";

export async function loadPermissionContext(
  tenantId: string,
  userId: string,
  database: DbOrTx = db,
  requests: readonly ActionScopeRequest[] | "agent_catalog" = [],
) {
  const [identities, tenants, principals, memberships, assignments, roles, policies, agents] =
    await Promise.all([
      database
        .select()
        .from(userIdentity)
        .where(and(eq(userIdentity.tenantId, tenantId), eq(userIdentity.id, userId))),
      database.select().from(tenant).where(eq(tenant.id, tenantId)),
      database.select().from(principalBinding).where(eq(principalBinding.tenantId, tenantId)),
      database
        .select()
        .from(permissionGroupMember)
        .where(
          and(
            eq(permissionGroupMember.tenantId, tenantId),
            eq(permissionGroupMember.userId, userId),
          ),
        ),
      database
        .select()
        .from(permissionRoleAssignment)
        .where(eq(permissionRoleAssignment.tenantId, tenantId)),
      database.select().from(permissionRole).where(eq(permissionRole.tenantId, tenantId)),
      database
        .select()
        .from(resourceAccessPolicy)
        .where(eq(resourceAccessPolicy.tenantId, tenantId)),
      database.select().from(agentTable).where(eq(agentTable.tenantId, tenantId)),
    ]);
  const now = new Date();
  const identity = identities[0];
  const active = identity?.status === "active" && tenants[0]?.status === "active";
  const principalIds = new Set(
    principals
      .filter((p) => p.subjectType === "user" && p.userIdentityId === userId)
      .map((p) => p.id),
  );
  for (const member of memberships) {
    if (
      (!member.validUntil || member.validUntil > now) &&
      principals.some((p) => p.id === member.groupId && p.subjectType !== "user")
    )
      principalIds.add(member.groupId);
  }
  const grants: Array<PermissionGrant & { source: string }> = [];
  if (active) {
    for (const grant of ROLE_TEMPLATES.find((r) => r.key === "member")?.grants ?? [])
      grants.push({ ...grant, source: "普通员工（默认）" });
    for (const assignment of assignments.filter((a) => principalIds.has(a.principalId))) {
      const builtin = ROLE_TEMPLATES.find((r) => r.key === assignment.roleKey);
      const custom = roles.find((r) => r.id === assignment.roleKey);
      try {
        for (const grant of builtin?.grants ?? parsePermissionGrants(custom?.permissions)) {
          if (!isPermissionGrantActive(grant, now)) continue;
          grants.push({
            ...grant,
            source: `${builtin?.name ?? custom?.name} · ${assignment.source}`,
          });
        }
      } catch {
        /* 无效角色无法授予权限。 */
      }
    }
  }
  const extension = await getIdentityExtensions();
  const targets =
    requests === "agent_catalog"
      ? agents.map((a) => ({
          actionCode: "agent.invoke" as const,
          resource: { type: "agent" as const, id: a.id },
        }))
      : requests;
  const enterprise = await evaluateEnterpriseAuthorization(
    extension.authorizationProvider,
    tenantId,
    userId,
    targets,
    extension.authorizationProvider && targets.length
      ? await getEnterpriseUserProfileFacts(tenantId, userId)
      : null,
  );
  const facts = {
    enterprise,
    tenantId,
    userId,
    active,
    principalIds: [...principalIds].sort(),
    grants,
    policies,
    agents: agents.map((a) => ({
      id: a.id,
      owner: a.ownerUserId,
      state: a.lifecycleState,
      revision: a.currentRevisionId,
      deleted: a.deletedAt,
    })),
  };
  return {
    tenantId,
    userId,
    active,
    principalIds,
    grants,
    policies,
    agents,
    enterprise,
    digest: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  };
}
export type PermissionContext = Awaited<ReturnType<typeof loadPermissionContext>>;
export function grantCovers(grant: PermissionGrant, request: ActionScopeRequest, tenantId: string) {
  return (
    grant.actionCode === request.actionCode &&
    (scopeCovers(grant.resourceScope, request.resource) ||
      (request.actionCode === "agent.invoke" &&
        request.resource.type === "agent" &&
        grant.resourceScope.type === "tenant" &&
        (grant.resourceScope.wildcard || grant.resourceScope.ids?.includes(tenantId))))
  );
}
function evaluatePlatformPermission(
  context: PermissionContext,
  request: ActionScopeRequest,
): { allowed: boolean; reason: string; sources: string[] } {
  const deny = (reason: string) => ({ allowed: false, reason, sources: [] });
  if (!context.active) return deny("身份或租户已停用");
  if (request.resource.type === "tenant" && request.resource.id !== context.tenantId)
    return deny("跨租户访问");
  if (request.resource.type === "self" && request.resource.id !== context.userId)
    return deny("不是自己的资源");
  const grants = context.grants.filter((g) => grantCovers(g, request, context.tenantId));
  if (request.resource.type === "agent" && request.resource.id) {
    const agent = context.agents.find((a) => a.id === request.resource.id && !a.deletedAt);
    const policy = context.policies.find(
      (p) => p.resourceType === "agent" && p.resourceId === request.resource.id,
    );
    if (
      request.actionCode === "agent.invoke" &&
      (!agent || agent.lifecycleState !== "enabled" || !agent.currentRevisionId)
    )
      return deny("智能体不存在或不属于当前租户");
    if (request.actionCode === "agent.invoke" && policy) {
      if (!agent || agent.lifecycleState !== "enabled" || !agent.currentRevisionId)
        return deny("智能体未启用或未发布");
      const defaultPolicy = context.policies.find(
        (p) => p.resourceType === "tenant" && p.resourceId === context.tenantId,
      );
      const mode = policy.mode === "inherit" ? (defaultPolicy?.mode ?? "all") : policy.mode;
      if (mode === "roles")
        return grants.length
          ? {
              allowed: true,
              reason: "角色的智能体使用范围允许",
              sources: [...new Set(grants.map((g) => g.source))],
            }
          : deny("没有该智能体的角色授权");
      if (mode === "all")
        return { allowed: true, reason: "面向全体员工发布", sources: ["资产使用范围"] };
      if (mode !== "restricted" || !Array.isArray(policy.principals)) return deny("使用范围无效");
      const matches = policy.principals.some(
        (id) => typeof id === "string" && context.principalIds.has(id),
      );
      return matches
        ? { allowed: true, reason: "命中指定使用范围", sources: ["资产使用范围"] }
        : deny("未命中资产使用范围");
    }
    if (
      agent &&
      [
        "agent.revision.create",
        "agent.publish",
        "agent.retract",
        "route.update",
        "agent.read",
      ].includes(request.actionCode)
    ) {
      const collaborators =
        policy && Array.isArray(policy.collaborators) ? policy.collaborators : [];
      const allowed =
        agent.ownerUserId === context.userId ||
        collaborators.some(
          (c) =>
            c &&
            typeof c === "object" &&
            context.principalIds.has(c.principalId) &&
            Array.isArray(c.actions) &&
            c.actions.includes(request.actionCode),
        );
      if (allowed) return { allowed: true, reason: "资产负责人或协作权限", sources: ["资产协作"] };
    }
  }
  return grants.length
    ? {
        allowed: true,
        reason: "角色或专项授权允许",
        sources: [...new Set(grants.map((g) => g.source))],
      }
    : deny("没有该动作的授权");
}

/** 企业仅收紧已声明的业务域；平台身份、租户和资源边界始终先执行。 */
export function evaluatePermission(
  context: PermissionContext,
  request: ActionScopeRequest,
): { allowed: boolean; reason: string; sources: string[] } {
  const platform = evaluatePlatformPermission(context, request);
  const enterprise = context.enterprise;
  const id = request.resource.id;
  if (
    !platform.allowed ||
    !enterprise ||
    request.actionCode !== "agent.invoke" ||
    !id ||
    (enterprise.agentIds !== "all" && !enterprise.agentIds.includes(id))
  )
    return platform;
  const decision = enterprise.decisions[id];
  if (!decision?.allowed)
    return {
      allowed: false,
      reason: decision?.reason ?? "企业授权尚未确认",
      sources: ["企业授权"],
    };
  return { ...platform, sources: [...platform.sources, "企业授权"] };
}
