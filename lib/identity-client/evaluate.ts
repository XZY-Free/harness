/**
 * 权限快照本地匹配（消费方侧清单匹配）。
 *
 * 与 auth-center `lib/identity/permission-context.ts` 的评测语义保持一致，
 * 但输入是**预展开快照**（grant 已展开、来源已标注、企业决策已按 agent 目录求值），
 * 因此这里只做清单匹配，不做角色模板推导。
 *
 * 变更/敏感操作不依赖本模块（走实时 authorize）；本模块用于：
 * - checkActionScope 的机会式缓存命中（快照新鲜时）；
 * - resolveActionScopeCoverage（导航/入口可见性投影）。
 */
import type { PermissionSnapshot, SnapshotGrant } from "./snapshot";

export interface SnapshotCheckRequest {
  readonly actionCode: string;
  readonly resource: { readonly type: string; readonly id: string | null };
}

export interface SnapshotDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly sources: readonly string[];
}

function isGrantActive(grant: SnapshotGrant, now: number): boolean {
  if (grant.validFrom && Date.parse(grant.validFrom) > now) return false;
  if (grant.validUntil && Date.parse(grant.validUntil) <= now) return false;
  return true;
}

function scopeCovers(
  binding: { type: string; ids?: readonly string[]; wildcard?: boolean },
  requested: { type: string; id: string | null },
): boolean {
  if (binding.type !== requested.type) return false;
  if (binding.wildcard) return true;
  return requested.id !== null && Array.isArray(binding.ids) && binding.ids.includes(requested.id);
}

function grantCovers(
  grant: SnapshotGrant,
  request: SnapshotCheckRequest,
  tenantId: string,
): boolean {
  return (
    grant.actionCode === request.actionCode &&
    (scopeCovers(grant.resourceScope, request.resource) ||
      (request.actionCode === "agent.invoke" &&
        request.resource.type === "agent" &&
        grant.resourceScope.type === "tenant" &&
        (grant.resourceScope.wildcard === true ||
          grant.resourceScope.ids?.includes(tenantId) === true)))
  );
}

function evaluatePlatform(
  snapshot: PermissionSnapshot,
  request: SnapshotCheckRequest,
  now: number,
): SnapshotDecision {
  const deny = (reason: string): SnapshotDecision => ({ allowed: false, reason, sources: [] });
  if (!snapshot.active) return deny("身份或租户已停用");
  if (request.resource.type === "tenant" && request.resource.id !== snapshot.tenantId)
    return deny("跨租户访问");
  if (request.resource.type === "self" && request.resource.id !== snapshot.userId)
    return deny("不是自己的资源");
  const grants = snapshot.grants.filter(
    (grant) => isGrantActive(grant, now) && grantCovers(grant, request, snapshot.tenantId),
  );
  const sources = () => [...new Set(grants.map((g) => g.source))];
  if (request.resource.type === "agent" && request.resource.id) {
    const agent = snapshot.agents.find((a) => a.id === request.resource.id && !a.deleted);
    const policy = snapshot.policies.find(
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
      const defaultPolicy = snapshot.policies.find(
        (p) => p.resourceType === "tenant" && p.resourceId === snapshot.tenantId,
      );
      const mode = policy.mode === "inherit" ? (defaultPolicy?.mode ?? "all") : policy.mode;
      if (mode === "roles")
        return grants.length
          ? {
              allowed: true,
              reason: "角色的智能体使用范围允许",
              sources: sources(),
            }
          : deny("没有该智能体的角色授权");
      if (mode === "all")
        return { allowed: true, reason: "面向全体员工发布", sources: ["资产使用范围"] };
      if (mode !== "restricted" || !Array.isArray(policy.principals)) return deny("使用范围无效");
      const matches = policy.principals.some(
        (id) => typeof id === "string" && snapshot.principalIds.includes(id),
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
        agent.ownerUserId === snapshot.userId ||
        collaborators.some(
          (c) =>
            c &&
            typeof c === "object" &&
            typeof (c as { principalId?: unknown }).principalId === "string" &&
            snapshot.principalIds.includes((c as { principalId: string }).principalId) &&
            Array.isArray((c as { actions?: unknown }).actions) &&
            ((c as { actions: unknown[] }).actions as unknown[]).includes(request.actionCode),
        );
      if (allowed) return { allowed: true, reason: "资产负责人或协作权限", sources: ["资产协作"] };
    }
  }
  return grants.length
    ? { allowed: true, reason: "角色或专项授权允许", sources: sources() }
    : deny("没有该动作的授权");
}

/** 快照评测（平台边界 + 企业收紧），与 auth-center evaluatePermission 语义一致。 */
export function evaluateSnapshot(
  snapshot: PermissionSnapshot,
  request: SnapshotCheckRequest,
): SnapshotDecision {
  const now = Date.now();
  const platform = evaluatePlatform(snapshot, request, now);
  const enterprise = snapshot.enterprise;
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

export interface SnapshotCoverage {
  readonly actionCode: string;
  readonly resourceType: string;
  readonly wildcard: boolean;
  readonly resourceIds: readonly string[];
  readonly authorizationDigest: string;
}

/** 从快照投影"某动作某资源类型"的有效覆盖（导航/入口可见性用）。 */
export function coverageFromSnapshot(
  snapshot: PermissionSnapshot,
  request: { actionCode: string; resourceType: string },
): SnapshotCoverage {
  const resourceIds = new Set<string>();
  let wildcard = false;
  const now = Date.now();
  if (snapshot.active) {
    for (const grant of snapshot.grants) {
      if (!isGrantActive(grant, now)) continue;
      if (grant.actionCode !== request.actionCode) continue;
      if (grant.resourceScope.type === request.resourceType) {
        wildcard ||= grant.resourceScope.wildcard === true;
        for (const id of grant.resourceScope.ids ?? []) resourceIds.add(id);
      }
      if (
        request.actionCode === "agent.invoke" &&
        request.resourceType === "agent" &&
        grant.resourceScope.type === "tenant"
      )
        wildcard ||=
          grant.resourceScope.wildcard === true ||
          grant.resourceScope.ids?.includes(snapshot.tenantId) === true;
    }
    if (request.resourceType === "agent" && request.actionCode === "agent.invoke") {
      // 有明确策略的资源总是按策略检查，旧 wildcard 不得覆盖限制。
      for (const agent of snapshot.agents) {
        const decision = evaluateSnapshot(snapshot, {
          actionCode: request.actionCode,
          resource: { type: "agent", id: agent.id },
        });
        if (decision.allowed) resourceIds.add(agent.id);
        else resourceIds.delete(agent.id);
      }
      wildcard = false;
    }
  }
  return {
    actionCode: request.actionCode,
    resourceType: request.resourceType,
    wildcard,
    resourceIds: [...resourceIds].sort(),
    authorizationDigest: snapshot.digest,
  };
}
