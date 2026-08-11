import type { ExecutionBindingDTO } from "@/lib/control-plane-client/contracts/execution";

export interface SerializableExecutionBinding {
 invocationId: string;
 tenantId: string;
 agentRevisionId: string;
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
 agentArtifactId: string;
 runtimeArtifactId: string;
 agentArtifactDigest: string;
 runtimeArtifactDigest: string;
 runtimeConfigDigest: string;
 capabilityManifestDigest: string;
 agentAttestationIds: string[];
 runtimeAttestationIds: string[];
 agentPublicationRecordId: string;
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
 agent_revision_id: binding.agentRevisionId,
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
 agent_artifact_id: binding.agentArtifactId,
 runtime_artifact_id: binding.runtimeArtifactId,
 agent_artifact_digest: binding.agentArtifactDigest,
 runtime_artifact_digest: binding.runtimeArtifactDigest,
 runtime_config_digest: binding.runtimeConfigDigest,
 capability_manifest_digest: binding.capabilityManifestDigest,
 agent_attestation_ids: binding.agentAttestationIds,
 runtime_attestation_ids: binding.runtimeAttestationIds,
 agent_publication_record_id: binding.agentPublicationRecordId,
 runtime_publication_record_id: binding.runtimePublicationRecordId,
 conformance_run_id: binding.conformanceRunId,
 resolution_input_digest: binding.resolutionInputDigest,
 projection_version_no: binding.projectionVersionNo,
 environment_definition_revision_id: binding.environmentDefinitionRevisionId,
 config_hash: binding.configHash,
 bound_at: binding.boundAt.toISOString(),
 };
}
