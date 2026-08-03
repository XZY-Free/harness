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
  policyRevisionId: null,
  contextCheckpointId: null,
  environmentDefinitionRevisionId: null,
  routeRevisionId: "route-revision-1",
  routeActivationId: "route-activation-1",
  routeContentDigest: `sha256:${"1".repeat(64)}`,
  agentArtifactDigest: `sha256:${"2".repeat(64)}`,
  runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
  runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
  capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
  agentAttestationIds: ["agent-attestation-1"],
  runtimeAttestationIds: ["runtime-attestation-1"],
  agentPublicationRecordId: "agent-publication-1",
  runtimePublicationRecordId: "runtime-publication-1",
  conformanceRunId: "conformance-run-1",
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

  it("历史 Binding 缺少新增证据时仍可读取", () => {
    expect(
      serializeExecutionBinding({
        ...binding,
        routeRevisionId: null,
        routeActivationId: null,
        routeContentDigest: null,
        agentArtifactDigest: null,
        runtimeArtifactDigest: null,
        runtimeConfigDigest: null,
        capabilityManifestDigest: null,
        agentAttestationIds: null,
        runtimeAttestationIds: null,
        agentPublicationRecordId: null,
        runtimePublicationRecordId: null,
        conformanceRunId: null,
      }),
    ).toMatchObject({
      invocation_id: "invocation-1",
      route_revision_id: null,
      conformance_run_id: null,
    });
  });
});
