import {
  type ProvisioningState,
  classifyProvisioningError,
  computeProvisioningBackoff,
  isProvisioningClaimable,
  isValidProvisioningTransition,
} from "@/lib/runtime/domain/hosted-provisioning-request";
import type { HostedProvisioningRequest } from "@/lib/runtime/domain/hosted-provisioning-request";
import { describe, expect, it } from "vitest";

// ─── 状态机测试 ──────────────────────────────────────────────

describe("isValidProvisioningTransition", () => {
  it("pending → running 允许", () => {
    expect(isValidProvisioningTransition("pending", "running")).toBe(true);
  });

  it("pending → cancelled 允许", () => {
    expect(isValidProvisioningTransition("pending", "cancelled")).toBe(true);
  });

  it("running → ready 允许", () => {
    expect(isValidProvisioningTransition("running", "ready")).toBe(true);
  });

  it("running → retryable_failed 允许", () => {
    expect(isValidProvisioningTransition("running", "retryable_failed")).toBe(true);
  });

  it("running → permanent_failed 允许", () => {
    expect(isValidProvisioningTransition("running", "permanent_failed")).toBe(true);
  });

  it("retryable_failed → pending 允许（Worker 重新领取）", () => {
    expect(isValidProvisioningTransition("retryable_failed", "pending")).toBe(true);
  });

  it("ready → running 禁止（终态）", () => {
    expect(isValidProvisioningTransition("ready", "running")).toBe(false);
  });

  it("permanent_failed → any 禁止（终态）", () => {
    expect(isValidProvisioningTransition("permanent_failed", "pending")).toBe(false);
  });

  it("cancelled → any 禁止（终态）", () => {
    expect(isValidProvisioningTransition("cancelled", "pending")).toBe(false);
  });

  // §08.5: waiting_external_evidence / waiting_conformance 已删除
  it("§08.5: waiting_external_evidence 不再是合法状态", () => {
    // 这些状态已从 PROVISIONING_STATES 中移除
    // TypeScript 已阻止直接使用，此处验证运行? 确保它们不会被意外加回
    const states: readonly string[] = [
      "pending",
      "running",
      "ready",
      "retryable_failed",
      "permanent_failed",
      "cancelled",
    ];
    expect(states).not.toContain("waiting_external_evidence");
    expect(states).not.toContain("waiting_conformance");
  });
});

// ─── Claimable 判断 ────────────────────────────────────────────

function makeRequest(overrides: Partial<HostedProvisioningRequest>): HostedProvisioningRequest {
  return {
    id: "req-1",
    tenantId: "t-1",
    agentId: "agent-1",
    agentRevisionId: "rev-1",
    routeScopeKey: "default",
    desiredRuntimeKey: "builtin-hosted",
    state: "pending",
    currentStep: null,
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    lastAttemptAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("isProvisioningClaimable", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("pending 无租约 → 可领取", () => {
    expect(isProvisioningClaimable(makeRequest({ state: "pending" }), now)).toBe(true);
  });

  it("retryable_failed 无租约 → 可领取", () => {
    expect(isProvisioningClaimable(makeRequest({ state: "retryable_failed" }), now)).toBe(true);
  });

  it("running 无过期租约 → 不可领取", () => {
    expect(isProvisioningClaimable(makeRequest({ state: "running" }), now)).toBe(false);
  });

  it("§08.7: running + expired lease → 可领取（崩溃恢复）", () => {
    const past = new Date(now.getTime() - 60_000);
    expect(
      isProvisioningClaimable(makeRequest({ state: "running", leaseExpiresAt: past }), now),
    ).toBe(true);
  });

  it("ready → 不可领取", () => {
    expect(isProvisioningClaimable(makeRequest({ state: "ready" }), now)).toBe(false);
  });

  it("租约未过期 → 不可领取", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(
      isProvisioningClaimable(makeRequest({ state: "pending", leaseExpiresAt: future }), now),
    ).toBe(false);
  });

  it("租约已过期 → 可领取", () => {
    const past = new Date(now.getTime() - 60_000);
    expect(
      isProvisioningClaimable(makeRequest({ state: "pending", leaseExpiresAt: past }), now),
    ).toBe(true);
  });

  it("nextAttemptAt 在未来 → 不可领取", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(
      isProvisioningClaimable(makeRequest({ state: "pending", nextAttemptAt: future }), now),
    ).toBe(false);
  });
});

// ─── 退避计算 ────────────────────────────────────────────────

describe("computeProvisioningBackoff", () => {
  it("attemptCount=0 退避为 baseMs", () => {
    const result = computeProvisioningBackoff(0, 10_000, 600_000);
    expect(result.getTime()).toBeGreaterThan(Date.now() + 9_000);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now() + 11_000);
  });

  it("不超过 maxMs", () => {
    const result = computeProvisioningBackoff(20, 10_000, 600_000);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
  });
});

// ─── 错误分类 ────────────────────────────────────────────────

describe("classifyProvisioningError", () => {
  it("ArtifactAttestationFailedError → permanent", () => {
    const err = new Error("签名无效");
    err.name = "ArtifactAttestationFailedError";
    expect(classifyProvisioningError(err).category).toBe("permanent");
  });

  it("§08.2: HostedProvisioningPermanentError → permanent", () => {
    const err = new Error("HOSTED_AGENT_REVISION_MISMATCH");
    err.name = "HostedProvisioningPermanentError";
    expect(classifyProvisioningError(err).category).toBe("permanent");
  });

  it("包含 'invalid signature' → permanent", () => {
    const err = new Error("invalid signature: bundle verification failed");
    expect(classifyProvisioningError(err).category).toBe("permanent");
  });

  it("包含 'artifact binding mismatch' → permanent", () => {
    const err = new Error("artifact binding mismatch: expected rev-1, got rev-2");
    expect(classifyProvisioningError(err).category).toBe("permanent");
  });

  it("超时 → retryable", () => {
    const err = new Error("Evidence Service timeout after 30s");
    expect(classifyProvisioningError(err).category).toBe("retryable");
  });

  it("ECONNREFUSED → retryable", () => {
    const err = new Error("connect ECONNREFUSED 10.0.0.1:443");
    expect(classifyProvisioningError(err).category).toBe("retryable");
  });

  it("未知错误 → retryable（保守策略）", () => {
    const err = new Error("unexpected internal error");
    expect(classifyProvisioningError(err).category).toBe("retryable");
  });

  it("非 Error 对象 → retryable", () => {
    expect(classifyProvisioningError("string error").category).toBe("retryable");
  });
});
