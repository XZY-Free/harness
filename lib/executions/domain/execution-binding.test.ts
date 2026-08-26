import {
  ExecutionBindingEvidenceError,
  computeExecutionBindingConfigHash,
} from "@/lib/executions/domain/execution-binding";
import { describe, expect, it } from "vitest";

const EVIDENCE = {
  agentRevisionId: "agent-revision-1",
  routeRevisionId: "route-revision-1",
  routeActivationId: "route-activation-1",
  routeContentDigest: `sha256:${"1".repeat(64)}`,
  runtimeArtifactId: "runtime-artifact-1",
  runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
  runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
  runtimeTargetDigest: `sha256:${"5".repeat(64)}`,
  runtimeEvidenceKind: "hosted_artifact" as const,
  agentContractSnapshotId: "agent-descriptor-snapshot-1",
  agentContractDigest: `sha256:${"7".repeat(64)}`,
  agentContextDigest: `sha256:${"8".repeat(64)}`,
  capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
  runtimeAttestationIds: ["runtime-attestation-b", "runtime-attestation-a"],
  agentPublicationRecordId: "agent-publication-1",
  runtimePublicationRecordId: "runtime-publication-1",
  conformanceRunId: "conformance-run-1",
  resolutionInputDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
};

function bindingInput() {
  return {
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
    controlPlaneEvidence: EVIDENCE,
    projectionVersionNo: 1,
  };
}

describe("ExecutionBinding domain", () => {
  it("configHash 冻结全部控制面证据且 Attestation 顺序不影响结果", () => {
    const first = computeExecutionBindingConfigHash(bindingInput());
    const second = computeExecutionBindingConfigHash({
      ...bindingInput(),
      controlPlaneEvidence: {
        ...EVIDENCE,
        runtimeAttestationIds: [...EVIDENCE.runtimeAttestationIds].reverse(),
      },
    });
    const changed = computeExecutionBindingConfigHash({
      ...bindingInput(),
      controlPlaneEvidence: { ...EVIDENCE, conformanceRunId: "conformance-run-2" },
    });

    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("缺少 Artifact、Publication、Attestation 或 Conformance 证据时拒绝", () => {
    expect(() =>
      computeExecutionBindingConfigHash({
        ...bindingInput(),
        controlPlaneEvidence: { ...EVIDENCE, runtimeAttestationIds: [] },
      }),
    ).toThrow(ExecutionBindingEvidenceError);
  });

  it("projectionVersionNo 必须是非负整数", () => {
    expect(() =>
      computeExecutionBindingConfigHash({
        ...bindingInput(),
        projectionVersionNo: 1.5,
      }),
    ).toThrow(ExecutionBindingEvidenceError);
  });
});
