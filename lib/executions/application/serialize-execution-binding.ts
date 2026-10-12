import type { ExecutionBindingDTO } from "@/lib/control-plane-client/contracts/execution";

export interface SerializableExecutionBinding {
  invocationId: string;
  tenantId: string;
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
  workspaceBindingId: string;
  policyRevisionId: string;
  policyRulesDigest: string;
  governanceConfigRevisionId: string;
  governanceConfigDigest: string;
  routeRevisionId: string;
  routeActivationId: string;
  routeContentDigest: string;
  /** null = external_endpoint Runtime。 */
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
  environmentMode: "MANAGED" | "NO_PLATFORM_ENVIRONMENT";
  principalType: "user" | "service";
  principalId: string;
  principalSource: "authenticated_user" | "trusted_service";
  principalFrozenAt: Date;
  capabilityCatalogDigest: string;
  capabilityCatalogVersion: string;
  capabilityCatalogSourceRefs: string[];
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
    workspace_binding_id: binding.workspaceBindingId,
    policy_revision_id: binding.policyRevisionId,
    policy_rules_digest: binding.policyRulesDigest,
    governance_config_revision_id: binding.governanceConfigRevisionId,
    governance_config_digest: binding.governanceConfigDigest,
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
    environment_mode: binding.environmentMode,
    principal_type: binding.principalType,
    principal_id: binding.principalId,
    principal_source: binding.principalSource,
    principal_frozen_at: binding.principalFrozenAt.toISOString(),
    capability_catalog_digest: binding.capabilityCatalogDigest,
    capability_catalog_version: binding.capabilityCatalogVersion,
    capability_catalog_source_refs: [...binding.capabilityCatalogSourceRefs],
    config_hash: binding.configHash,
    bound_at: binding.boundAt.toISOString(),
  };
}
