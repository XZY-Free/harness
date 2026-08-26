import { describe, expect, it } from "vitest";
import { projectHostedProvisioningRequest } from "./hosted-provisioning-admin-projection";

describe("hosted provisioning admin projection", () => {
  it("投影真实状态、重试信息与全部 Checkpoint", () => {
    expect(
      projectHostedProvisioningRequest({
        id: "request-1",
        tenantId: "tenant-1",
        agentId: "agent-1",
        agentRevisionId: "agent-revision-1",
        routeScopeKey: "prod",
        desiredRuntimeKey: "builtin-hosted",
        state: "running",
        currentStep: "verify_runtime_artifact",
        attemptCount: 2,
        nextAttemptAt: null,
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date("2026-08-11T00:05:00.000Z"),
        lastError: null,
        lastAttemptAt: new Date("2026-08-11T00:00:00.000Z"),
        createdAt: new Date("2026-08-10T23:59:00.000Z"),
        updatedAt: new Date("2026-08-11T00:00:00.000Z"),
        stepAgentRevisionId: "agent-revision-1",
        stepAgentPublicationRecordId: "publication-agent-1",
        stepRuntimeId: "runtime-1",
        stepRuntimeRevisionId: "runtime-revision-1",
        stepRuntimeArtifactId: "artifact-runtime-1",
        stepRuntimeAttestationIds: ["attestation-runtime-1"],
        stepRuntimePublicationRecordId: null,
        stepConformanceRunId: null,
        stepRouteSetId: null,
        stepRouteSetVersionNo: null,
        stepRouteId: null,
        stepRouteRevisionId: null,
        stepRouteActivationId: null,
        stepProjectionVersionNo: null,
        workflowVersion: "3.0",
        lastCompletedStep: "prepare_runtime_revision",
      }),
    ).toMatchObject({
      desired_runtime_key: "builtin-hosted",
      current_step: "verify_runtime_artifact",
      runtime_revision_id_checkpoint: "runtime-revision-1",
      workflow_version: "3.0",
    });
  });
});
