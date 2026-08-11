import { describe, expect, it, vi } from "vitest";

import type { HostedGateways } from "@/lib/runtime/infrastructure/hosted-gateways";
import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "@/lib/runtime/persistence/hosted-provisioning-request-store";
import { createHostedProvisioningSaga } from "@/lib/runtime/provisioning/hosted-provisioning-saga";

function request(
  overrides: Partial<HostedProvisioningRequestRow> = {},
): HostedProvisioningRequestRow {
  const now = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "request-1",
    tenantId: "tenant-1",
    agentId: "agent-1",
    agentRevisionId: "agent-revision-frozen",
    routeScopeKey: "production",
    desiredRuntimeKey: "builtin-hosted",
    state: "running",
    currentStep: "ensure_agent_publication",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-11T00:01:00.000Z"),
    lastError: null,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    stepAgentRevisionId: null,
    stepAgentPublicationRecordId: null,
    stepAgentAttestationId: null,
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
  const gateways = {
    routeReader: { resolveEligibleRoute: vi.fn() },
    agentPublication: { ensurePublishedAgentRevision: vi.fn() },
    runtimePrepare: { prepareRuntimeRevision: vi.fn() },
    runtimeArtifactVerify: { verifyRuntimeArtifact: vi.fn() },
    runtimeConformance: { recordRuntimeConformance: vi.fn() },
    runtimePublish: { publishRuntimeRevision: vi.fn() },
    routeActivation: { activateRoute: vi.fn() },
  } as unknown as HostedGateways;
  const saga = createHostedProvisioningSaga({
    gateways,
    store,
    maxAttempts: 3,
    workerId: "worker-1",
  });
  return { gateways, saga, updateState };
}

describe("HostedProvisioningSaga exact AgentRevision authority", () => {
  it("非终态步骤返回 pending，与已提交数据库状态一致", async () => {
    const { gateways, saga, updateState } = harness();
    vi.mocked(gateways.agentPublication.ensurePublishedAgentRevision).mockResolvedValue({
      revisionId: "agent-revision-frozen",
      publicationRecordId: "publication-1",
      attestationId: "attestation-1",
    });

    const result = await saga(request());

    expect(result.newState).toBe("pending");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
  });

  it("把请求冻结 revision 作为 expectedAgentRevisionId 传入发布网关", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.agentPublication.ensurePublishedAgentRevision).mockResolvedValue({
      revisionId: "agent-revision-frozen",
      publicationRecordId: "publication-1",
      attestationId: "attestation-1",
    });

    await saga(request());

    expect(gateways.agentPublication.ensurePublishedAgentRevision).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      agentId: "agent-1",
      expectedAgentRevisionId: "agent-revision-frozen",
    });
  });

  it("发布网关返回不同 revision 时持久化 permanent_failed 并阻断后续网关", async () => {
    const { gateways, saga, updateState } = harness();
    vi.mocked(gateways.agentPublication.ensurePublishedAgentRevision).mockResolvedValue({
      revisionId: "agent-revision-other",
      publicationRecordId: "publication-1",
      attestationId: "attestation-1",
    });

    const result = await saga(request());

    expect(result.newState).toBe("permanent_failed");
    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        workerId: "worker-1",
        state: "permanent_failed",
        lastError: expect.stringContaining("HOSTED_AGENT_REVISION_MISMATCH"),
      }),
    );
    expect(gateways.runtimePrepare.prepareRuntimeRevision).not.toHaveBeenCalled();
    expect(gateways.routeActivation.activateRoute).not.toHaveBeenCalled();
  });

  it("prepare_runtime_revision 始终携带请求冻结 revision", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.runtimePrepare.prepareRuntimeRevision).mockResolvedValue({
      runtimeId: "runtime-1",
      runtimeRevisionId: "runtime-revision-1",
    });

    await saga(request({ currentStep: "prepare_runtime_revision" }));

    expect(gateways.runtimePrepare.prepareRuntimeRevision).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      agentId: "agent-1",
      agentRevisionId: "agent-revision-frozen",
    });
  });

  it("activate_route 使用请求冻结 revision，拒绝被 checkpoint 漂移覆盖", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.routeActivation.activateRoute).mockResolvedValue({
      routeSetId: "route-set-1",
      routeSetVersionNo: 2,
      routeId: "route-1",
      routeRevisionId: "route-revision-1",
      routeActivationId: "route-activation-1",
    });

    const result = await saga(
      request({
        currentStep: "activate_route",
        stepAgentRevisionId: "agent-revision-other",
        stepAgentPublicationRecordId: "publication-1",
        stepAgentAttestationId: "attestation-1",
        stepRuntimeId: "runtime-1",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRuntimeAttestationIds: ["runtime-attestation-1"],
        stepRuntimePublicationRecordId: "runtime-publication-1",
        stepConformanceRunId: "conformance-1",
      }),
    );

    expect(result.newState).toBe("permanent_failed");
    expect(gateways.routeActivation.activateRoute).not.toHaveBeenCalled();
  });

  it("activate_route 把请求冻结 revision 精确传给 RouteActivation", async () => {
    const { gateways, saga } = harness();
    vi.mocked(gateways.routeActivation.activateRoute).mockResolvedValue({
      routeSetId: "route-set-1",
      routeSetVersionNo: 2,
      routeId: "route-1",
      routeRevisionId: "route-revision-1",
      routeActivationId: "route-activation-1",
    });

    await saga(
      request({
        currentStep: "activate_route",
        stepAgentRevisionId: "agent-revision-frozen",
        stepAgentPublicationRecordId: "publication-1",
        stepAgentAttestationId: "attestation-1",
        stepRuntimeId: "runtime-1",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRuntimeAttestationIds: ["runtime-attestation-1"],
        stepRuntimePublicationRecordId: "runtime-publication-1",
        stepConformanceRunId: "conformance-1",
      }),
    );

    expect(gateways.routeActivation.activateRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRevision: expect.objectContaining({ revisionId: "agent-revision-frozen" }),
      }),
    );
  });

  it("await_projection 首次读到漂移 revision 就永久失败，不覆盖 Route checkpoint", async () => {
    const { gateways, saga, updateState } = harness();
    vi.mocked(gateways.routeReader.resolveEligibleRoute).mockResolvedValue({
      routeId: "route-1",
      routeRevisionId: "route-revision-1",
      routeActivationId: "route-activation-1",
      agentRevisionId: "agent-revision-other",
      runtimeRevisionId: "runtime-revision-1",
      projectionVersionNo: 1,
    });

    const result = await saga(
      request({
        currentStep: "await_projection",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRouteRevisionId: "route-revision-1",
        stepRouteActivationId: "route-activation-1",
      }),
    );

    expect(result.newState).toBe("permanent_failed");
    expect(updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "permanent_failed",
        lastError: expect.stringContaining("agentRevisionId"),
      }),
    );
  });
});
