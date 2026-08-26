import { serializeExecutionBinding } from "@/lib/executions/application/serialize-execution-binding";
import type { ExecutionBinding } from "@/lib/executions/domain/execution-binding";
import { describe, expect, it } from "vitest";

const binding: ExecutionBinding = {
  invocationId: "invocation-1",
  tenantId: "tenant-1",
  agentRevisionId: "agent-revision-1",
  runtimeRevisionId: "runtime-revision-1",
  deploymentRouteId: "route-1",
  modelProvider: "provider",
  modelId: "model",
  modelRevisionRef: null,
  initialEnvironmentLeaseId: null,
  workspaceBindingId: null,
  policyRevisionId: "policy-revision-1",
  policyRulesDigest: `sha256:${"8".repeat(64)}`,
  governanceConfigRevisionId: "governance-revision-1",
  governanceConfigDigest: `sha256:${"9".repeat(64)}`,
  contextCheckpointId: null,
  environmentDefinitionRevisionId: null,
  routeRevisionId: "route-revision-1",
  routeActivationId: "route-activation-1",
  routeContentDigest: `sha256:${"1".repeat(64)}`,
  agentArtifactId: "agent-artifact-1",
  runtimeArtifactId: "runtime-artifact-1",
  agentArtifactDigest: `sha256:${"2".repeat(64)}`,
  runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
  runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
  runtimeTargetDigest: `sha256:${"5".repeat(64)}`,
  runtimeEvidenceKind: "hosted_artifact" as const,
  agentContractSnapshotId: "agent-descriptor-snapshot-1",
  agentContractDigest: `sha256:${"7".repeat(64)}`,
  agentContextDigest: `sha256:${"8".repeat(64)}`,
  capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
  agentAttestationIds: ["agent-attestation-1"],
  runtimeAttestationIds: ["runtime-attestation-1"],
  agentPublicationRecordId: "agent-publication-1",
  runtimePublicationRecordId: "runtime-publication-1",
  conformanceRunId: "conformance-run-1",
  resolutionInputDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  projectionVersionNo: 1,
  configHash: `sha256:${"6".repeat(64)}`,
  boundAt: new Date("2026-08-03T01:02:03.000Z"),
};

describe("serializeExecutionBinding", () => {
  it("Admin 投影返回完整不可变控制面证据", () => {
    expect(serializeExecutionBinding(binding)).toMatchObject({
      invocation_id: "invocation-1",
      route_revision_id: "route-revision-1",
      route_activation_id: "route-activation-1",
      route_content_digest: binding.routeContentDigest,
      agent_artifact_id: "agent-artifact-1",
      runtime_artifact_id: "runtime-artifact-1",
      agent_artifact_digest: binding.agentArtifactDigest,
      runtime_artifact_digest: binding.runtimeArtifactDigest,
      runtime_config_digest: binding.runtimeConfigDigest,
      capability_manifest_digest: binding.capabilityManifestDigest,
      agent_attestation_ids: ["agent-attestation-1"],
      runtime_attestation_ids: ["runtime-attestation-1"],
      agent_publication_record_id: "agent-publication-1",
      runtime_publication_record_id: "runtime-publication-1",
      conformance_run_id: "conformance-run-1",
      environment_definition_revision_id: null,
      bound_at: "2026-08-03T01:02:03.000Z",
    });
  });
});
