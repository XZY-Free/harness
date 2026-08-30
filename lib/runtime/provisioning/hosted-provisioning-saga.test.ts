import { describe, expect, it, vi } from "vitest";

import type { HostedGateways } from "@/lib/runtime/infrastructure/hosted-gateways";
import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "@/lib/runtime/persistence/hosted-provisioning-request-store";
import {
  PROVISIONING_STEPS,
  createHostedProvisioningSaga,
} from "@/lib/runtime/provisioning/hosted-provisioning-saga";

/**
 * 专题01 冻结（runtime-only）目标 Gateway 形状。
 *
 * 本测试断言的是「即将实现」的 runtime-only 契约，而非当前旧的 Agent 网关。
 * 生产 Saga 当前仍为 Agent 形态，因此本套测试必须 RED。
 *
 * 目标 HostedGateways：
 * - runtimePrepare.prepareRuntimeRevision({tenantId, requesterId})
 * - runtimeArtifactVerify / runtimeConformance / runtimePublish（仅 runtime）
 * - runtimeRouteActivation.activateRuntimeRoute({tenantId, routeScopeKey, runtimeRevision})
 * - runtimeRouteReader.resolveEligibleRuntimeRoute({tenantId, routeScopeKey})
 * - 无 agentPublication / 旧 routeActivation / 旧 routeReader
 */
interface TargetHostedGateways {
  runtimePrepare: {
    prepareRuntimeRevision: ReturnType<typeof vi.fn>;
  };
  runtimeArtifactVerify: {
    verifyRuntimeArtifact: ReturnType<typeof vi.fn>;
  };
  runtimeConformance: {
    recordRuntimeConformance: ReturnType<typeof vi.fn>;
  };
  runtimePublish: {
    publishRuntimeRevision: ReturnType<typeof vi.fn>;
  };
  runtimeRouteActivation: {
    activateRuntimeRoute: ReturnType<typeof vi.fn>;
  };
  runtimeRouteReader: {
    resolveEligibleRuntimeRoute: ReturnType<typeof vi.fn>;
  };
}

/** runtime-only 目标解析出的路由（无 agentRevisionId）。 */
interface TargetEligibleRuntimeRoute {
  routeId: string;
  routeRevisionId: string;
  routeActivationId: string;
  runtimeRevisionId: string;
  projectionVersionNo: number;
}

function request(
  overrides: Partial<HostedProvisioningRequestRow> = {},
): HostedProvisioningRequestRow {
  const now = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "request-1",
    tenantId: "tenant-1",
    requesterId: "requester-1",
    routeScopeKey: "production",
    state: "running",
    currentStep: "validate_request",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-11T00:01:00.000Z"),
    lastError: null,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    stepRuntimeId: null,
    stepRuntimeRevisionId: null,
    stepRuntimeArtifactId: null,
    stepRuntimeAttestationIds: null,
    stepRuntimePublicationRecordId: null,
    stepConformanceRunId: null,
    stepRouteSetId: null,
    stepRouteSetVersionNo: null,
    stepRouteId: null,
    stepRouteRevisionId: null,
    stepRouteActivationId: null,
    stepProjectionVersionNo: null,
    workflowVersion: "3.0",
    lastCompletedStep: null,
    ...overrides,
  };
}

function harness() {
  const updateState = vi.fn(async () => request());
  const store = {
    updateState,
  } as unknown as HostedProvisioningRequestStore;
  // 目标 runtime-only Gateway 形状。生产 HostedGateways 仍为旧 Agent 形态，
  // 因此这里用 as unknown as 表达「即将实现」的目标契约（测试侧）。
  const gateways = {
    runtimePrepare: { prepareRuntimeRevision: vi.fn() },
    runtimeArtifactVerify: { verifyRuntimeArtifact: vi.fn() },
    runtimeConformance: { recordRuntimeConformance: vi.fn() },
    runtimePublish: { publishRuntimeRevision: vi.fn() },
    runtimeRouteActivation: { activateRuntimeRoute: vi.fn() },
    runtimeRouteReader: { resolveEligibleRuntimeRoute: vi.fn() },
  } as TargetHostedGateways as unknown as HostedGateways;
  const saga = createHostedProvisioningSaga({
    gateways,
    store,
    maxAttempts: 3,
    workerId: "worker-1",
  });
  return { gateways, saga, updateState };
}

function runtimeRoute(
  overrides: Partial<TargetEligibleRuntimeRoute> = {},
): TargetEligibleRuntimeRoute {
  return {
    routeId: "route-1",
    routeRevisionId: "route-revision-1",
    routeActivationId: "route-activation-1",
    runtimeRevisionId: "runtime-revision-1",
    projectionVersionNo: 1,
    ...overrides,
  };
}

describe("HostedProvisioningSaga runtime-only 目标契约", () => {
  // 1. 精确步骤列表/顺序，显式排除 ensure_agent_publication
  it("PROVISIONING_STEPS 精确匹配 runtime-only 目标序列且无 ensure_agent_publication", () => {
    expect(PROVISIONING_STEPS).toEqual([
      "validate_request",
      "prepare_runtime_revision",
      "verify_runtime_artifact",
      "record_runtime_conformance",
      "publish_runtime_revision",
      "activate_route",
      "await_projection",
      "verify_route",
    ]);
    expect(PROVISIONING_STEPS).not.toContain("ensure_agent_publication");
  });

  // 2a. validate_request 对合法 runtime-only 请求推进，不调用任何 Gateway
  it("validate_request 对合法请求推进到 prepare_runtime_revision，且不调用任何 Gateway", async () => {
    const { gateways, saga, updateState } = harness();
    const result = await saga(request());

    expect(result.newState).toBe("pending");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        currentStep: "prepare_runtime_revision",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
    // 强否定：没有任何 Gateway 被调用（含旧 Agent 发布网关）
    expect(gateways.runtimePrepare.prepareRuntimeRevision).not.toHaveBeenCalled();
    expect(gateways.runtimeRouteActivation.activateRuntimeRoute).not.toHaveBeenCalled();
    expect(gateways.runtimeRouteReader.resolveEligibleRuntimeRoute).not.toHaveBeenCalled();
  });

  // 2b. validate_request 对空白 requesterId/routeScopeKey 永久失败且不调用 Gateway
  it("validate_request 对空白 requesterId/routeScopeKey 永久失败且不调用 Gateway", async () => {
    const { gateways, saga, updateState } = harness();
    const result = await saga(request({ requesterId: "", routeScopeKey: "" }));

    expect(result.newState).toBe("permanent_failed");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "permanent_failed",
        lastError: expect.stringContaining("requesterId"),
      }),
    );
    expect(gateways.runtimePrepare.prepareRuntimeRevision).not.toHaveBeenCalled();
    expect(gateways.runtimeRouteActivation.activateRuntimeRoute).not.toHaveBeenCalled();
    expect(gateways.runtimeRouteReader.resolveEligibleRuntimeRoute).not.toHaveBeenCalled();
  });

  // 3. prepare_runtime_revision 精确传参 {tenantId, requesterId}
  it("prepare_runtime_revision 精确传参 {tenantId, requesterId}", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.runtimePrepare.prepareRuntimeRevision).mockResolvedValue({
      runtimeId: "runtime-1",
      runtimeRevisionId: "runtime-revision-1",
    });

    await saga(request({ currentStep: "prepare_runtime_revision" }));

    expect(gateways.runtimePrepare.prepareRuntimeRevision).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      requesterId: "requester-1",
    });
    // 强否定：绝不携带 agentId / agentRevisionId
    const prepareCall = vi.mocked(gateways.runtimePrepare.prepareRuntimeRevision).mock.calls[0];
    if (!prepareCall) throw new Error("prepareRuntimeRevision 未被调用");
    const call = prepareCall[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("agentId");
    expect(call).not.toHaveProperty("agentRevisionId");
  });

  // 4a. activate_route 使用 runtime-only checkpoint 调用 activateRuntimeRoute，无 Agent 字段
  it("activate_route 使用 runtime-only checkpoint 调用 activateRuntimeRoute，无 Agent 字段", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.runtimeRouteActivation.activateRuntimeRoute).mockResolvedValue({
      routeSetId: "route-set-1",
      routeSetVersionNo: 2,
      routeId: "route-1",
      routeRevisionId: "route-revision-1",
      routeActivationId: "route-activation-1",
    });

    await saga(
      request({
        currentStep: "activate_route",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRuntimePublicationRecordId: "runtime-publication-1",
        stepRuntimeAttestationIds: ["runtime-attestation-1"],
        stepConformanceRunId: "conformance-1",
      }),
    );

    expect(gateways.runtimeRouteActivation.activateRuntimeRoute).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      routeScopeKey: "production",
      runtimeRevision: {
        revisionId: "runtime-revision-1",
        publicationRecordId: "runtime-publication-1",
        attestationId: "runtime-attestation-1",
        conformanceRunId: "conformance-1",
      },
    });
    // 强否定：不包含任何 Agent 字段
    const activationCall = vi.mocked(gateways.runtimeRouteActivation.activateRuntimeRoute).mock
      .calls[0];
    if (!activationCall) throw new Error("activateRuntimeRoute 未被调用");
    const call = activationCall[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("agentId");
    expect(call).not.toHaveProperty("agentRevision");
    expect(call).not.toHaveProperty("agentRevisionId");
  });

  // 4b. 缺失任一必需 runtime checkpoint 时阻断激活
  it.each([
    ["stepRuntimeRevisionId", { stepRuntimeRevisionId: null }],
    ["stepRuntimePublicationRecordId", { stepRuntimePublicationRecordId: null }],
    ["stepRuntimeAttestationIds", { stepRuntimeAttestationIds: null }],
    ["stepConformanceRunId", { stepConformanceRunId: null }],
  ])("activate_route 缺失 %s 时阻断激活且不调用 activateRuntimeRoute", async (_, partial) => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.runtimeRouteActivation.activateRuntimeRoute).mockResolvedValue({
      routeSetId: "route-set-1",
      routeSetVersionNo: 2,
      routeId: "route-1",
      routeRevisionId: "route-revision-1",
      routeActivationId: "route-activation-1",
    });

    const result = await saga(
      request({
        currentStep: "activate_route",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRuntimePublicationRecordId: "runtime-publication-1",
        stepRuntimeAttestationIds: ["runtime-attestation-1"],
        stepConformanceRunId: "conformance-1",
        ...partial,
      }),
    );

    expect(result.newState).toBe("permanent_failed");
    expect(gateways.runtimeRouteActivation.activateRuntimeRoute).not.toHaveBeenCalled();
  });

  // 5. await_projection 以 {tenantId, routeScopeKey} 解析 runtime-only 路由
  it("await_projection 以 {tenantId, routeScopeKey} 解析 runtime-only 路由并匹配精确 ID", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.runtimeRouteReader.resolveEligibleRuntimeRoute).mockResolvedValue(
      runtimeRoute(),
    );

    await saga(
      request({
        currentStep: "await_projection",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRouteRevisionId: "route-revision-1",
        stepRouteActivationId: "route-activation-1",
      }),
    );

    expect(gateways.runtimeRouteReader.resolveEligibleRuntimeRoute).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      routeScopeKey: "production",
    });
  });

  // 6. 漂移 ID 永久失败且不覆盖 checkpoint
  it.each([
    ["runtimeRevisionId", { runtimeRevisionId: "runtime-revision-other" }],
    ["routeRevisionId", { routeRevisionId: "route-revision-other" }],
    ["routeActivationId", { routeActivationId: "route-activation-other" }],
  ])("await_projection 检测到 %s 漂移时永久失败且不覆盖 checkpoint", async (_, drift) => {
    const { gateways, saga, updateState } = harness();
    vi.mocked(gateways.runtimeRouteReader.resolveEligibleRuntimeRoute).mockResolvedValue(
      runtimeRoute(drift),
    );

    const result = await saga(
      request({
        currentStep: "await_projection",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRouteRevisionId: "route-revision-1",
        stepRouteActivationId: "route-activation-1",
      }),
    );

    expect(result.newState).toBe("permanent_failed");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "permanent_failed",
        lastError: expect.stringContaining("HOSTED_ROUTE_ID_MISMATCH"),
      }),
    );
    // 强否定：不得覆盖既有 route checkpoint
    expect(updateState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        stepRouteRevisionId: "route-revision-1",
        stepRouteActivationId: "route-activation-1",
        state: "pending",
      }),
    );
  });

  // 7. checkpoint/idempotency 跳过对已完成 runtime 步骤仍然生效
  it("prepare_runtime_revision 已存在 checkpoint 时跳过 Gateway 直接推进", async () => {
    const { gateways, saga } = harness();

    const result = await saga(
      request({
        currentStep: "prepare_runtime_revision",
        stepRuntimeId: "runtime-1",
        stepRuntimeRevisionId: "runtime-revision-1",
      }),
    );

    expect(result.newState).toBe("pending");
    expect(gateways.runtimePrepare.prepareRuntimeRevision).not.toHaveBeenCalled();
  });

  // 8a. conformance 未通过 → retryable_failed 并清除 lease
  it("record_runtime_conformance 未通过时 retryable_failed 并清除 lease", async () => {
    const { gateways, saga, updateState } = harness();
    vi.mocked(gateways.runtimeConformance.recordRuntimeConformance).mockResolvedValue({
      conformanceRunId: "conformance-1",
      overallResult: "failed",
    });

    const result = await saga(
      request({
        currentStep: "record_runtime_conformance",
        stepRuntimeRevisionId: "runtime-revision-1",
      }),
    );

    expect(result.newState).toBe("retryable_failed");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "retryable_failed",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
  });

  // 8b. await_projection 未构建 → retryable_failed 并清除 lease
  it("await_projection 投影不可见时 retryable_failed 并清除 lease", async () => {
    const { gateways, saga, updateState } = harness();
    vi.mocked(gateways.runtimeRouteReader.resolveEligibleRuntimeRoute).mockResolvedValue(null);

    const result = await saga(
      request({
        currentStep: "await_projection",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRouteRevisionId: "route-revision-1",
        stepRouteActivationId: "route-activation-1",
      }),
    );

    expect(result.newState).toBe("retryable_failed");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "retryable_failed",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
  });
});
