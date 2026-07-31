/**
 * V11 Cloud/Remote Runtime 身份链验证（S12-W05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §5
 *         （Desktop、Cloud 和外部 Runtime 的身份链、租户绑定和重放保护分别验证）。
 *
 * 职责：
 * - 定义 RuntimeIdentityChain 结构：runtime_revision → environment → lease → invocation 的链式校验。
 * - verifyRuntimeIdentityChain：校验 Workload Token claims 与 EnvironmentLease 一致。
 * - assertRuntimeLeaseActive：校验 Lease 处于 active 状态且未过期。
 * - assertRuntimeLeaseBoundToInvocation：校验 Lease 绑定到当前 Invocation。
 * - assertRuntimeLeaseBoundToRuntimeRevision：校验 Lease 的 EnvironmentDefinition 支持 Runtime 修订。
 *
 * 身份链不变量：
 * - Workload Token 的 tenantId 必须等于 Lease 的 tenantId（跨租户拒绝）。
 * - Workload Token 的 invocationId 必须等于 Lease 的 invocationId（跨 Invocation 拒绝）。
 * - Workload Token 的 runtimeRevisionId 必须等于 EnvironmentLease.capabilitiesJson 中声明的 runtime_revision_id。
 * - Lease 必须处于 active 状态（allocated/releasing/expired/lost/released 拒绝）。
 * - Lease 未过期（lastHeartbeatAt + heartbeat_timeout > now 或 expiresAt > now）。
 *
 * 与现有模块的关系：
 * - workload-token.ts：解析 Token claims（type/runtime/invocation/runtime_revision）。
 * - environment-queries.ts：查询 EnvironmentLease。
 * - runtime/route-helpers.ts：resolveRuntimePrincipal 调用本模块校验 Lease 绑定。
 */
import type { WorkloadTokenClaims } from "@/lib/v11/identity/workload-token";
import type { V11EnvironmentLease } from "@/lib/v11/schema/environment";

// ─── 错误类型 ──────────────────────────────────────────────

/** Runtime 身份链验证错误（route 层应映射为 401 AUTHENTICATION_REQUIRED）。 */
export class RuntimeIdentityChainError extends Error {
  constructor(
    public readonly code:
      | "lease_not_active"
      | "lease_expired"
      | "lease_tenant_mismatch"
      | "lease_invocation_mismatch"
      | "lease_runtime_revision_mismatch"
      | "lease_capabilities_missing"
      | "lease_heartbeat_stale",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeIdentityChainError";
  }
}

// ─── 类型定义 ──────────────────────────────────────────────

/** Lease 心跳超时（ms）：超过此时间未心跳则视为 stale。 */
export const LEASE_HEARTBEAT_TIMEOUT_MS = 60 * 1000; // 60s

/** Lease active 状态。 */
const ACTIVE_LEASE_STATE = "active";

// ─── 校验函数 ──────────────────────────────────────────────

/**
 * 校验 Lease 处于 active 状态且未过期。
 *
 * @throws RuntimeIdentityChainError lease_not_active / lease_expired / lease_heartbeat_stale
 */
export function assertRuntimeLeaseActive(lease: V11EnvironmentLease, now: Date = new Date()): void {
  if (lease.leaseState !== ACTIVE_LEASE_STATE) {
    throw new RuntimeIdentityChainError(
      "lease_not_active",
      `Lease 状态非 active（当前=${lease.leaseState}）`,
    );
  }

  // 过期校验：expiresAt 已设置且已过
  if (lease.expiresAt && lease.expiresAt.getTime() < now.getTime()) {
    throw new RuntimeIdentityChainError(
      "lease_expired",
      `Lease 已过期（expiresAt=${lease.expiresAt.toISOString()}）`,
    );
  }

  // 心跳校验：lastHeartbeatAt 已设置且超时
  if (lease.lastHeartbeatAt) {
    const age = now.getTime() - lease.lastHeartbeatAt.getTime();
    if (age > LEASE_HEARTBEAT_TIMEOUT_MS) {
      throw new RuntimeIdentityChainError(
        "lease_heartbeat_stale",
        `Lease 心跳超时（age=${age}ms, timeout=${LEASE_HEARTBEAT_TIMEOUT_MS}ms）`,
      );
    }
  }
}

/**
 * 校验 Lease 绑定到指定 Invocation。
 *
 * @throws RuntimeIdentityChainError lease_invocation_mismatch
 */
export function assertRuntimeLeaseBoundToInvocation(
  lease: V11EnvironmentLease,
  invocationId: string,
): void {
  if (lease.invocationId !== invocationId) {
    throw new RuntimeIdentityChainError(
      "lease_invocation_mismatch",
      `Lease invocationId=${lease.invocationId} 与请求=${invocationId} 不匹配`,
    );
  }
}

/**
 * 校验 Lease 的 tenantId 与 Token claims 的 tenantId 一致。
 *
 * @throws RuntimeIdentityChainError lease_tenant_mismatch
 */
export function assertRuntimeLeaseBoundToTenant(
  lease: V11EnvironmentLease,
  tenantId: string,
): void {
  if (lease.tenantId !== tenantId) {
    throw new RuntimeIdentityChainError(
      "lease_tenant_mismatch",
      "Lease tenantId 与 Token tenantId 不匹配（跨租户拒绝）",
    );
  }
}

/**
 * 校验 Lease 的 capabilitiesJson 中声明的 runtime_revision_id 与 Token 一致。
 *
 * capabilitiesJson 结构（由 Runtime 探测填入）：
 * { runtime_revision_id: string, hot_migration: boolean, ... }
 *
 * @throws RuntimeIdentityChainError lease_capabilities_missing / lease_runtime_revision_mismatch
 */
export function assertRuntimeLeaseBoundToRuntimeRevision(
  lease: V11EnvironmentLease,
  runtimeRevisionId: string,
): void {
  if (!lease.capabilitiesJson) {
    throw new RuntimeIdentityChainError(
      "lease_capabilities_missing",
      "Lease capabilitiesJson 缺失（Runtime 未探测能力）",
    );
  }

  const caps = lease.capabilitiesJson as Record<string, unknown>;
  const leaseRuntimeRevision = caps.runtime_revision_id;
  if (typeof leaseRuntimeRevision !== "string") {
    throw new RuntimeIdentityChainError(
      "lease_capabilities_missing",
      "Lease capabilitiesJson 缺失 runtime_revision_id 字段",
    );
  }

  if (leaseRuntimeRevision !== runtimeRevisionId) {
    throw new RuntimeIdentityChainError(
      "lease_runtime_revision_mismatch",
      `Lease runtime_revision_id=${leaseRuntimeRevision} 与 Token=${runtimeRevisionId} 不匹配`,
    );
  }
}

/**
 * 完整 Runtime 身份链校验（route handler 在 resolveRuntimePrincipal 后调用）。
 *
 * 流程：
 * 1. tenantId 一致性校验。
 * 2. invocationId 一致性校验。
 * 3. runtimeRevisionId 一致性校验（仅 runtime Token）。
 * 4. Lease 状态校验（active + 未过期 + 心跳未超时）。
 *
 * @throws RuntimeIdentityChainError 任一校验失败
 */
export function verifyRuntimeIdentityChain(params: {
  claims: WorkloadTokenClaims;
  lease: V11EnvironmentLease;
  now?: Date;
}): void {
  const { claims, lease } = params;
  const now = params.now ?? new Date();

  assertRuntimeLeaseBoundToTenant(lease, claims.tenantId);
  assertRuntimeLeaseBoundToInvocation(lease, claims.invocationId ?? "");

  // runtime Token 必须校验 runtimeRevisionId
  if (claims.type === "runtime" && claims.runtimeRevisionId) {
    assertRuntimeLeaseBoundToRuntimeRevision(lease, claims.runtimeRevisionId);
  }

  assertRuntimeLeaseActive(lease, now);
}

/**
 * 判断 Workload Token 是否需要身份链校验。
 *
 * - runtime/gateway Token：必须校验（绑定 Invocation）。
 * - service Token：跳过（CI/CD Service Identity 不绑定 Invocation）。
 */
export function requiresIdentityChainVerification(claims: WorkloadTokenClaims): boolean {
  return claims.type === "runtime" || claims.type === "gateway";
}
