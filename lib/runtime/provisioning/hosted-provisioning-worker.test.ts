import { describe, expect, it, vi } from "vitest";

import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "@/lib/runtime/persistence/hosted-provisioning-request-store";
import {
  type HostedProvisioningWorkerDependencies,
  createHostedProvisioningWorker,
} from "@/lib/runtime/provisioning/hosted-provisioning-worker";

function claimedRequest(): HostedProvisioningRequestRow {
  const now = new Date("2026-08-11T00:00:00.000Z");
  return {
    id: "request-1",
    tenantId: "tenant-1",
    agentId: "agent-1",
    agentRevisionId: "agent-revision-1",
    routeScopeKey: "production",
    desiredRuntimeKey: "builtin-hosted",
    state: "running",
    currentStep: "validate_request",
    attemptCount: 1,
    nextAttemptAt: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-11T00:01:00.000Z"),
    lastError: null,
    lastAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    stepAgentRevisionId: null,
    stepAgentPublicationRecordId: null,
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
  };
}

describe("HostedProvisioningWorker lease ownership", () => {
  it("does not release a lease after Saga atomically commits pending and clears it", async () => {
    const releaseLease = vi.fn();
    const store = {
      claimRequests: vi.fn(async () => [claimedRequest()]),
      releaseLease,
    } as unknown as HostedProvisioningRequestStore;
    const saga = vi.fn(async () => ({
      step: "validate_request",
      completed: true,
      newState: "pending" as const,
    }));
    const dependencies: HostedProvisioningWorkerDependencies = { store, saga };
    const worker = createHostedProvisioningWorker({ workerId: "worker-1" }, dependencies);

    await worker.pollOnce();

    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("does not release a lease again after the exception path commits failure", async () => {
    const releaseLease = vi.fn();
    const updateState = vi.fn(async () => claimedRequest());
    const store = {
      claimRequests: vi.fn(async () => [claimedRequest()]),
      updateState,
      releaseLease,
    } as unknown as HostedProvisioningRequestStore;
    const saga = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const dependencies: HostedProvisioningWorkerDependencies = { store, saga };
    const worker = createHostedProvisioningWorker({ workerId: "worker-1" }, dependencies);

    await worker.pollOnce();

    expect(updateState).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        workerId: "worker-1",
        state: "retryable_failed",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
    expect(releaseLease).not.toHaveBeenCalled();
  });
});
