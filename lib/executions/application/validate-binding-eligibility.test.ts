/**
 * validateBindingEligibility 纯逻辑单元测试。
 *
 * DB 依赖通过 E2E 测试覆盖，此处仅测试领域逻辑：
 * - EligibilitySnapshotStaleError 构造与属性
 * - BindingEligibilityInput frozenEvidence 结构
 */

import { describe, expect, it } from "vitest";
import {
  EligibilitySnapshotStaleError,
  type BindingEligibilityInput,
  type BindingEligibilityResult,
} from "./validate-binding-eligibility";

describe("EligibilitySnapshotStaleError", () => {
  it("§07.6: 构造正确 name + message", () => {
    const err = new EligibilitySnapshotStaleError("route-abc", "agentPublicationRecordId mismatch");
    expect(err.name).toBe("EligibilitySnapshotStaleError");
    expect(err.routeId).toBe("route-abc");
    expect(err.detail).toBe("agentPublicationRecordId mismatch");
    expect(err.message).toContain("route-abc");
    expect(err.message).toContain("agentPublicationRecordId mismatch");
  });

  it("§07.6: 是 Error 子类", () => {
    const err = new EligibilitySnapshotStaleError("r1", "stale");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EligibilitySnapshotStaleError);
  });
});

describe("BindingEligibilityInput frozenEvidence", () => {
  it("§07.5: frozenEvidence 可包含完整证据 ID", () => {
    const input: BindingEligibilityInput = {
      tenantId: "t1",
      routeId: "r1",
      routeRevisionId: "rr1",
      routeActivationId: "ra1",
      agentRevisionId: "ar1",
      runtimeRevisionId: "rvr1",
      policyRevisionId: "pr1",
      projectionVersionNo: 3,
      frozenEvidence: {
        agentPublicationRecordId: "apr1",
        runtimePublicationRecordId: "rpr1",
        agentAttestationIds: ["aat1", "aat2"],
        runtimeAttestationIds: ["rat1"],
        conformanceRunId: "cr1",
      },
    };
    expect(input.frozenEvidence?.agentPublicationRecordId).toBe("apr1");
    expect(input.frozenEvidence?.runtimePublicationRecordId).toBe("rpr1");
    expect(input.frozenEvidence?.agentAttestationIds).toEqual(["aat1", "aat2"]);
    expect(input.frozenEvidence?.runtimeAttestationIds).toEqual(["rat1"]);
    expect(input.frozenEvidence?.conformanceRunId).toBe("cr1");
  });

  it("§07.5: frozenEvidence 可为 null（兼容旧路径）", () => {
    const input: BindingEligibilityInput = {
      tenantId: "t1",
      routeId: "r1",
      routeRevisionId: "rr1",
      routeActivationId: "ra1",
      agentRevisionId: "ar1",
      runtimeRevisionId: "rvr1",
      policyRevisionId: null,
      projectionVersionNo: 1,
      frozenEvidence: null,
    };
    expect(input.frozenEvidence).toBeNull();
  });

  it("§07.5: frozenEvidence 可省略（向后兼容）", () => {
    const input: BindingEligibilityInput = {
      tenantId: "t1",
      routeId: "r1",
      routeRevisionId: "rr1",
      routeActivationId: "ra1",
      agentRevisionId: "ar1",
      runtimeRevisionId: "rvr1",
      policyRevisionId: null,
      projectionVersionNo: 1,
    };
    expect(input.frozenEvidence).toBeUndefined();
  });
});

describe("BindingEligibilityResult", () => {
  it("eligibility_snapshot_stale reason 用于 Dispatcher 重试判断", () => {
    const result: BindingEligibilityResult = {
      valid: false,
      reason: "eligibility_snapshot_stale",
      projectionVersionMatch: false,
    };
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("eligibility_snapshot_stale");
    // Dispatcher 可据此判断是否执行 re-resolve + re-bind（最多一次）
    expect(result.projectionVersionMatch).toBe(false);
  });
});
