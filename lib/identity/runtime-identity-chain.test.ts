import {
  LEASE_HEARTBEAT_TIMEOUT_MS,
  type RuntimeIdentityChainError,
  assertRuntimeLeaseActive,
  assertRuntimeLeaseBoundToInvocation,
  assertRuntimeLeaseBoundToRuntimeRevision,
  assertRuntimeLeaseBoundToTenant,
  requiresIdentityChainVerification,
  verifyRuntimeIdentityChain,
} from "@/lib/identity/runtime-identity-chain";
import { DEFAULT_TENANT_ID } from "@/lib/identity/tenant-queries";
/**
 * S12-W05：Cloud/Remote Runtime 身份链验证单元测试。
 *
 * 覆盖：
 * - assertRuntimeLeaseActive：状态 + 过期 + 心跳校验。
 * - assertRuntimeLeaseBoundToInvocation：Invocation 绑定。
 * - assertRuntimeLeaseBoundToTenant：租户绑定。
 * - assertRuntimeLeaseBoundToRuntimeRevision：runtime_revision_id 绑定。
 * - verifyRuntimeIdentityChain：完整链式校验。
 * - requiresIdentityChainVerification：Token 类型判断。
 */
import type { WorkloadTokenClaims } from "@/lib/identity/workload-token";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import { describe, expect, it } from "vitest";

// ─── 辅助构造 ───────────────────────────────────────────────

function buildLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "lease-1",
    tenantId: DEFAULT_TENANT_ID,
    environmentDefinitionId: "ed-1",
    invocationId: "inv-1",
    attemptId: "att-1",
    deviceId: null,
    workerRef: null,
    leaseState: "active",
    capabilitiesJson: { runtime_revision_id: "rr-1", hot_migration: true },
    allocatedAt: new Date(),
    lastHeartbeatAt: new Date(),
    releasedAt: null,
    expiresAt: new Date(Date.now() + 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRuntimeClaims(overrides: Partial<WorkloadTokenClaims> = {}): WorkloadTokenClaims {
  return {
    type: "runtime",
    tenantId: DEFAULT_TENANT_ID,
    jti: "jti-1",
    invocationId: "inv-1",
    runtimeRevisionId: "rr-1",
    audience: "runtime",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    ...overrides,
  };
}

// ─── assertRuntimeLeaseActive ───────────────────────────────

describe("assertRuntimeLeaseActive", () => {
  it("active + 未过期 + 心跳新鲜 → 通过", () => {
    const lease = buildLease();
    expect(() => assertRuntimeLeaseActive(lease)).not.toThrow();
  });

  it("非 active 状态 → lease_not_active", () => {
    const lease = buildLease({ leaseState: "allocated" });
    expect(() => assertRuntimeLeaseActive(lease)).toThrow();
    try {
      assertRuntimeLeaseActive(lease);
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_not_active");
    }
  });

  it("released 状态 → lease_not_active", () => {
    const lease = buildLease({ leaseState: "released" });
    expect(() => assertRuntimeLeaseActive(lease)).toThrow();
  });

  it("expired 状态 → lease_not_active", () => {
    const lease = buildLease({ leaseState: "expired" });
    expect(() => assertRuntimeLeaseActive(lease)).toThrow();
  });

  it("已过期（expiresAt < now）→ lease_expired", () => {
    const lease = buildLease({ expiresAt: new Date(Date.now() - 1000) });
    expect(() => assertRuntimeLeaseActive(lease)).toThrow();
    try {
      assertRuntimeLeaseActive(lease);
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_expired");
    }
  });

  it("心跳超时（lastHeartbeatAt 距 now 超过 LEASE_HEARTBEAT_TIMEOUT_MS）→ lease_heartbeat_stale", () => {
    const staleTime = new Date(Date.now() - LEASE_HEARTBEAT_TIMEOUT_MS - 1000);
    const lease = buildLease({ lastHeartbeatAt: staleTime });
    expect(() => assertRuntimeLeaseActive(lease)).toThrow();
    try {
      assertRuntimeLeaseActive(lease);
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_heartbeat_stale");
    }
  });

  it("心跳未超时（lastHeartbeatAt 距 now < LEASE_HEARTBEAT_TIMEOUT_MS）→ 通过", () => {
    const freshTime = new Date(Date.now() - 10000);
    const lease = buildLease({ lastHeartbeatAt: freshTime });
    expect(() => assertRuntimeLeaseActive(lease)).not.toThrow();
  });

  it("lastHeartbeatAt 为 null → 跳过心跳校验", () => {
    const lease = buildLease({ lastHeartbeatAt: null });
    expect(() => assertRuntimeLeaseActive(lease)).not.toThrow();
  });

  it("expiresAt 为 null → 跳过过期校验", () => {
    const lease = buildLease({ expiresAt: null });
    expect(() => assertRuntimeLeaseActive(lease)).not.toThrow();
  });
});

// ─── assertRuntimeLeaseBoundToInvocation ────────────────────

describe("assertRuntimeLeaseBoundToInvocation", () => {
  it("匹配 → 通过", () => {
    const lease = buildLease({ invocationId: "inv-1" });
    expect(() => assertRuntimeLeaseBoundToInvocation(lease, "inv-1")).not.toThrow();
  });

  it("不匹配 → lease_invocation_mismatch", () => {
    const lease = buildLease({ invocationId: "inv-1" });
    expect(() => assertRuntimeLeaseBoundToInvocation(lease, "inv-other")).toThrow();
    try {
      assertRuntimeLeaseBoundToInvocation(lease, "inv-other");
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_invocation_mismatch");
    }
  });
});

// ─── assertRuntimeLeaseBoundToTenant ────────────────────────

describe("assertRuntimeLeaseBoundToTenant", () => {
  it("匹配 → 通过", () => {
    const lease = buildLease({ tenantId: "tnt-1" });
    expect(() => assertRuntimeLeaseBoundToTenant(lease, "tnt-1")).not.toThrow();
  });

  it("不匹配 → lease_tenant_mismatch（跨租户拒绝）", () => {
    const lease = buildLease({ tenantId: "tnt-1" });
    expect(() => assertRuntimeLeaseBoundToTenant(lease, "tnt-other")).toThrow();
    try {
      assertRuntimeLeaseBoundToTenant(lease, "tnt-other");
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_tenant_mismatch");
    }
  });
});

// ─── assertRuntimeLeaseBoundToRuntimeRevision ───────────────

describe("assertRuntimeLeaseBoundToRuntimeRevision", () => {
  it("匹配 → 通过", () => {
    const lease = buildLease({ capabilitiesJson: { runtime_revision_id: "rr-1" } });
    expect(() => assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-1")).not.toThrow();
  });

  it("不匹配 → lease_runtime_revision_mismatch", () => {
    const lease = buildLease({ capabilitiesJson: { runtime_revision_id: "rr-1" } });
    expect(() => assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-other")).toThrow();
    try {
      assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-other");
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_runtime_revision_mismatch");
    }
  });

  it("capabilitiesJson 缺失 → lease_capabilities_missing", () => {
    const lease = buildLease({ capabilitiesJson: null });
    expect(() => assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-1")).toThrow();
    try {
      assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-1");
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_capabilities_missing");
    }
  });

  it("capabilitiesJson 缺失 runtime_revision_id 字段 → lease_capabilities_missing", () => {
    const lease = buildLease({ capabilitiesJson: { hot_migration: true } });
    expect(() => assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-1")).toThrow();
    try {
      assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-1");
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_capabilities_missing");
    }
  });

  it("runtime_revision_id 非字符串 → lease_capabilities_missing", () => {
    const lease = buildLease({ capabilitiesJson: { runtime_revision_id: 123 } });
    expect(() => assertRuntimeLeaseBoundToRuntimeRevision(lease, "rr-1")).toThrow();
  });
});

// ─── verifyRuntimeIdentityChain ─────────────────────────────

describe("verifyRuntimeIdentityChain", () => {
  it("完整匹配 → 通过", () => {
    const claims = buildRuntimeClaims();
    const lease = buildLease();
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).not.toThrow();
  });

  it("tenantId 不匹配 → lease_tenant_mismatch", () => {
    const claims = buildRuntimeClaims({ tenantId: "tnt-other" });
    const lease = buildLease({ tenantId: "tnt-1" });
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).toThrow();
    try {
      verifyRuntimeIdentityChain({ claims, lease });
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_tenant_mismatch");
    }
  });

  it("invocationId 不匹配 → lease_invocation_mismatch", () => {
    const claims = buildRuntimeClaims({ invocationId: "inv-other" });
    const lease = buildLease({ invocationId: "inv-1" });
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).toThrow();
    try {
      verifyRuntimeIdentityChain({ claims, lease });
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_invocation_mismatch");
    }
  });

  it("runtimeRevisionId 不匹配 → lease_runtime_revision_mismatch", () => {
    const claims = buildRuntimeClaims({ runtimeRevisionId: "rr-other" });
    const lease = buildLease({ capabilitiesJson: { runtime_revision_id: "rr-1" } });
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).toThrow();
    try {
      verifyRuntimeIdentityChain({ claims, lease });
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_runtime_revision_mismatch");
    }
  });

  it("Lease 非 active → lease_not_active", () => {
    const claims = buildRuntimeClaims();
    const lease = buildLease({ leaseState: "released" });
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).toThrow();
    try {
      verifyRuntimeIdentityChain({ claims, lease });
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_not_active");
    }
  });

  it("Lease 已过期 → lease_expired", () => {
    const claims = buildRuntimeClaims();
    const lease = buildLease({ expiresAt: new Date(Date.now() - 1000) });
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).toThrow();
    try {
      verifyRuntimeIdentityChain({ claims, lease });
    } catch (e) {
      expect((e as RuntimeIdentityChainError).code).toBe("lease_expired");
    }
  });

  it("gateway Token 也需身份链校验（runtimeRevisionId 校验跳过）", () => {
    const claims = buildRuntimeClaims({
      type: "gateway",
      audience: "gateway",
      runtimeRevisionId: undefined,
    });
    const lease = buildLease({ capabilitiesJson: { runtime_revision_id: "rr-1" } });
    // gateway Token 不校验 runtimeRevisionId
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).not.toThrow();
  });

  it("runtime Token 缺 runtimeRevisionId → 跳过 runtimeRevisionId 校验", () => {
    const claims = buildRuntimeClaims({ runtimeRevisionId: undefined });
    const lease = buildLease({ capabilitiesJson: { runtime_revision_id: "rr-1" } });
    // claims.runtimeRevisionId 为空时不校验（边界场景）
    expect(() => verifyRuntimeIdentityChain({ claims, lease })).not.toThrow();
  });
});

// ─── requiresIdentityChainVerification ──────────────────────

describe("requiresIdentityChainVerification", () => {
  it("runtime Token → true", () => {
    const claims = buildRuntimeClaims({ type: "runtime" });
    expect(requiresIdentityChainVerification(claims)).toBe(true);
  });

  it("gateway Token → true", () => {
    const claims = buildRuntimeClaims({ type: "gateway", audience: "gateway" });
    expect(requiresIdentityChainVerification(claims)).toBe(true);
  });

  it("service Token → false（CI/CD 不绑定 Invocation）", () => {
    const claims = buildRuntimeClaims({
      type: "service",
      audience: "admin",
      serviceId: "cicd",
      invocationId: undefined,
      runtimeRevisionId: undefined,
    });
    expect(requiresIdentityChainVerification(claims)).toBe(false);
  });
});
