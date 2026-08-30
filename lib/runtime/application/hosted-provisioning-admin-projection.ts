import type {
  HostedProvisioningRequestDTO,
  ProvisioningStep,
} from "@/lib/control-plane-client/contracts/provisioning";
import type { HostedProvisioningRequestRow } from "@/lib/runtime/persistence/hosted-provisioning-request-record";

const STEPS = new Set<ProvisioningStep>([
  "validate_request",
  "prepare_runtime_revision",
  "verify_runtime_artifact",
  "record_runtime_conformance",
  "publish_runtime_revision",
  "activate_route",
  "await_projection",
  "verify_route",
]);

function projectStep(value: string | null): ProvisioningStep | null {
  if (value === null) return null;
  if (!STEPS.has(value as ProvisioningStep)) {
    throw new Error(`HostedProvisioningRequest step 非法: ${value}`);
  }
  return value as ProvisioningStep;
}

export function projectHostedProvisioningRequest(
  request: HostedProvisioningRequestRow,
): HostedProvisioningRequestDTO {
  return {
    id: request.id,
    tenant_id: request.tenantId,
    requester_id: request.requesterId,
    route_scope_key: request.routeScopeKey,
    state: request.state,
    current_step: projectStep(request.currentStep),
    last_completed_step: projectStep(request.lastCompletedStep),
    attempt_count: request.attemptCount,
    next_attempt_at: request.nextAttemptAt?.toISOString() ?? null,
    last_attempt_at: request.lastAttemptAt?.toISOString() ?? null,
    lease_expires_at: request.leaseExpiresAt?.toISOString() ?? null,
    last_error: request.lastError,
    runtime_id: request.stepRuntimeId,
    runtime_revision_id_checkpoint: request.stepRuntimeRevisionId,
    runtime_artifact_id: request.stepRuntimeArtifactId,
    runtime_attestation_ids: request.stepRuntimeAttestationIds,
    conformance_run_id: request.stepConformanceRunId,
    runtime_publication_record_id: request.stepRuntimePublicationRecordId,
    route_set_id: request.stepRouteSetId,
    route_set_version_no: request.stepRouteSetVersionNo,
    route_id: request.stepRouteId,
    route_revision_id: request.stepRouteRevisionId,
    route_activation_id: request.stepRouteActivationId,
    projection_version_no: request.stepProjectionVersionNo,
    workflow_version: request.workflowVersion,
    created_at: request.createdAt.toISOString(),
    updated_at: request.updatedAt.toISOString(),
  };
}
