import type { ExecutionBindingDTO } from "@/lib/control-plane-client/contracts/execution";

export interface SerializableExecutionBinding {
  invocationId: string;
  tenantId: string;
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
  initialEnvironmentLeaseId: string | null;
  workspaceBindingId: string | null;
  policyRevisionId: string | null;
  contextCheckpointId: string | null;
  routeRevisionId: string;
  routeActivationId: string;
  routeContentDigest: string;
  /** null = external_endpoint Runtime（03 §3）。 */
  runtimeArtifactId: string | null;
  runtimeArtifactDigest: string | null;
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  capabilityManifestDigest: string;
  runtimeAttestationIds: string[];
  runtimePublicationRecordId: string;
  conformanceRunId: string;
  resolutionInputDigest: string;
  projectionVersionNo: number;
  environmentDefinitionRevisionId: string | null;
  configHash: string;
  boundAt: Date;
}

export function serializeExecutionBinding(
  binding: SerializableExecutionBinding,
): ExecutionBindingDTO {
  return {
    invocation_id: binding.invocationId,
    tenant_id: binding.tenantId,
    runtime_revision_id: binding.runtimeRevisionId,
    deployment_route_id: binding.deploymentRouteId,
    model_provider: binding.modelProvider,
    model_id: binding.modelId,
    model_revision_ref: binding.modelRevisionRef,
    initial_environment_lease_id: binding.initialEnvironmentLeaseId,
    workspace_binding_id: binding.workspaceBindingId,
    policy_revision_id: binding.policyRevisionId,
    context_checkpoint_id: binding.contextCheckpointId,
    route_revision_id: binding.routeRevisionId,
    route_activation_id: binding.routeActivationId,
    route_content_digest: binding.routeContentDigest,
    runtime_artifact_id: binding.runtimeArtifactId,
    runtime_artifact_digest: binding.runtimeArtifactDigest,
    runtime_evidence_kind: binding.runtimeEvidenceKind,
    runtime_target_digest: binding.runtimeTargetDigest,
    runtime_config_digest: binding.runtimeConfigDigest,
    capability_manifest_digest: binding.capabilityManifestDigest,
    runtime_attestation_ids: binding.runtimeAttestationIds,
    runtime_publication_record_id: binding.runtimePublicationRecordId,
    conformance_run_id: binding.conformanceRunId,
    resolution_input_digest: binding.resolutionInputDigest,
    projection_version_no: binding.projectionVersionNo,
    environment_definition_revision_id: binding.environmentDefinitionRevisionId,
    config_hash: binding.configHash,
    bound_at: binding.boundAt.toISOString(),
  };
}
