import { readFileSync } from "node:fs";
import {
  EXECUTION_BINDING_AUTHORITY_LOCK_ORDER,
  toExecutionBinding,
  validateFrozenArtifactAuthority,
  validateFrozenAttestationAuthority,
  validateFrozenConformanceAuthority,
  validateFrozenPolicyAuthority,
  validateFrozenProjectionAuthority,
  validateFrozenPublicationAuthority,
  validateFrozenPublicationEvidenceDigest,
} from "@/lib/executions/persistence/mysql-execution-binding-store";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import {
  ALL_CONFORMANCE_CASES,
  CONFORMANCE_SUITE_REVISION,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import { describe, expect, it } from "vitest";

type BindingRow = Parameters<typeof toExecutionBinding>[0];

const bindingRow: BindingRow = {
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
  routeRevisionId: "route-revision-1",
  routeActivationId: "route-activation-1",
  routeContentDigest: `sha256:${"1".repeat(64)}`,
  agentArtifactId: "agent-artifact-1",
  runtimeArtifactId: "runtime-artifact-1",
  agentArtifactDigest: `sha256:${"2".repeat(64)}`,
  runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
  runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
  capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
  agentAttestationIds: ["agent-attestation-1"],
  runtimeAttestationIds: ["runtime-attestation-1"],
  agentPublicationRecordId: "agent-publication-1",
  runtimePublicationRecordId: "runtime-publication-1",
  conformanceRunId: "conformance-run-1",
  resolutionInputDigest: `sha256:${"6".repeat(64)}`,
  projectionVersionNo: 0,
  environmentDefinitionRevisionId: null,
  configHash: `sha256:${"7".repeat(64)}`,
  boundAt: new Date("2026-08-11T00:00:00.000Z"),
};

/**
 * 返回 <table> 在源码中第一个 FOR UPDATE 锁（.for("update") 归属的 .from(<table>)）的位置；
 * 无则返回 -1。锁序只约束加锁顺序，非加锁的 key 探测读不计入。
 */
function firstForUpdateLockIndex(source: string, table: string): number {
  let searchFrom = 0;
  for (;;) {
    const forUpdate = source.indexOf('.for("update")', searchFrom);
    if (forUpdate === -1) return -1;
    const from = source.lastIndexOf(`.from(${table})`, forUpdate);
    if (
      from !== -1 &&
      // 该 .from(<table>) 必须是此锁最近的 .from(...)，中间不得再有其它 .from(
      source.slice(from + `.from(${table})`.length, forUpdate).indexOf(".from(") === -1
    ) {
      return from;
    }
    searchFrom = forUpdate + 1;
  }
}

describe("toExecutionBinding", () => {
  it("projectionVersionNo=0 是合法的冻结版本", () => {
    expect(toExecutionBinding(bindingRow).projectionVersionNo).toBe(0);
  });

  it("回读缺失 resolutionInputDigest 时 fail-closed", () => {
    expect(() => toExecutionBinding({ ...bindingRow, resolutionInputDigest: "" })).toThrow(
      /证据字段不完整/,
    );
  });

  it("回读 projectionVersionNo 不是非负整数时 fail-closed", () => {
    expect(() => toExecutionBinding({ ...bindingRow, projectionVersionNo: 1.5 })).toThrow(
      /证据字段不完整/,
    );
    expect(() => toExecutionBinding({ ...bindingRow, projectionVersionNo: -1 })).toThrow(
      /证据字段不完整/,
    );
  });
});

describe("ExecutionBinding authority final validation", () => {
  it("公开固定的串行锁序并禁止旧 Route authority", () => {
    expect(EXECUTION_BINDING_AUTHORITY_LOCK_ORDER).toEqual([
      "Invocation",
      "DeploymentRoute+DeploymentRouteSet",
      "RouteActivation",
      "RouteRevision",
      "Agent",
      "AgentRevision",
      "Runtime",
      "RuntimeRevision",
      "AgentPublicationRecord",
      "AgentWithdrawalRecord",
      "RuntimePublicationRecord",
      "RuntimeWithdrawalRecord",
      "AgentArtifact",
      "AgentArtifactAttestation",
      "AgentAttestationRevocation",
      "RuntimeArtifact",
      "RuntimeArtifactAttestation",
      "RuntimeAttestationRevocation",
      "RuntimeConformanceRun",
      "RuntimeConformanceCaseResult",
      "PolicySet",
      "PolicyRevision",
      "RouteEligibilityProjection",
    ]);

    const source = readFileSync(
      new URL("./mysql-execution-binding-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("activeRouteRevisionId");
    expect(source).not.toContain("Promise.all(");
  });

  it("只接受租户、主体、修订、证明全集和 ConformanceRun 精确一致的冻结 Publication", () => {
    const base = {
      publication: {
        id: "publication-1",
        tenantId: "tenant-1",
        subjectType: "runtime_revision" as const,
        subjectRevisionId: "runtime-revision-1",
        attestationIds: ["attestation-b", "attestation-a"],
        conformanceRunId: "conformance-run-1",
      },
      withdrawal: null,
      expected: {
        publicationRecordId: "publication-1",
        tenantId: "tenant-1",
        subjectType: "runtime_revision" as const,
        subjectRevisionId: "runtime-revision-1",
        attestationIds: ["attestation-a", "attestation-b"],
        conformanceRunId: "conformance-run-1",
      },
    };

    expect(() => validateFrozenPublicationAuthority(base)).not.toThrow();
    expect(() =>
      validateFrozenPublicationAuthority({
        ...base,
        publication: { ...base.publication, tenantId: "other-tenant" },
      }),
    ).toThrow(/Publication/);
    expect(() =>
      validateFrozenPublicationAuthority({
        ...base,
        publication: { ...base.publication, attestationIds: ["attestation-a"] },
      }),
    ).toThrow(/Attestation/);
    expect(() =>
      validateFrozenPublicationAuthority({
        ...base,
        publication: { ...base.publication, conformanceRunId: "other-run" },
      }),
    ).toThrow(/ConformanceRun/);
    expect(() =>
      validateFrozenPublicationAuthority({
        ...base,
        withdrawal: { id: "withdrawal-1" },
      }),
    ).toThrow(/撤回/);
  });

  it("拒绝空、重复或非精确全集的 Attestation IDs", () => {
    const input = {
      publication: {
        id: "publication-1",
        tenantId: "tenant-1",
        subjectType: "agent_revision" as const,
        subjectRevisionId: "agent-revision-1",
        attestationIds: ["attestation-1"],
        conformanceRunId: null,
      },
      withdrawal: null,
      expected: {
        publicationRecordId: "publication-1",
        tenantId: "tenant-1",
        subjectType: "agent_revision" as const,
        subjectRevisionId: "agent-revision-1",
        attestationIds: ["attestation-1"],
        conformanceRunId: null,
      },
    };

    expect(() =>
      validateFrozenPublicationAuthority({
        ...input,
        expected: { ...input.expected, attestationIds: [] },
      }),
    ).toThrow(/Attestation/);
    expect(() =>
      validateFrozenPublicationAuthority({
        ...input,
        publication: { ...input.publication, attestationIds: ["attestation-1", "attestation-1"] },
      }),
    ).toThrow(/Attestation/);
  });

  it("冻结 Attestation 必须精确绑定租户、类型、Revision、Digest 且有效未撤销", () => {
    const base = {
      attestation: {
        id: "attestation-1",
        tenantId: "tenant-1",
        artifactType: "runtime_revision",
        artifactRevisionId: "runtime-revision-1",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        verificationState: "verified" as const,
        revokedAt: null,
      },
      revocation: null,
      expected: {
        attestationId: "attestation-1",
        tenantId: "tenant-1",
        artifactType: "runtime_revision" as const,
        artifactRevisionId: "runtime-revision-1",
        artifactDigest: `sha256:${"a".repeat(64)}`,
      },
    };

    expect(() => validateFrozenAttestationAuthority(base)).not.toThrow();
    for (const attestation of [
      { ...base.attestation, tenantId: "other-tenant" },
      { ...base.attestation, artifactType: "agent_revision" },
      { ...base.attestation, artifactRevisionId: "other-revision" },
      { ...base.attestation, artifactDigest: `sha256:${"b".repeat(64)}` },
      { ...base.attestation, verificationState: "failed" as const },
    ]) {
      expect(() => validateFrozenAttestationAuthority({ ...base, attestation })).toThrow(
        /Attestation/,
      );
    }
    expect(() =>
      validateFrozenAttestationAuthority({
        ...base,
        revocation: { id: "revocation-1" },
      }),
    ).toThrow(/撤销/);
  });

  it("按冻结 ID 排序逐条锁 Attestation 及其 Revocation", () => {
    const source = readFileSync(
      new URL("./mysql-execution-binding-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "for (const attestationId of [...evidence.agentAttestationIds].sort())",
    );
    expect(source).toContain(
      "for (const attestationId of [...evidence.runtimeAttestationIds].sort())",
    );
    expect(source).toContain("eq(attestationRevocationRecord.attestationId, attestationId)");
  });

  it("先锁 Artifact 并精确校验 Attestation 指向的制品", () => {
    const artifact = {
      id: "artifact-1",
      tenantId: "tenant-1",
      kind: "runtime_revision",
      digest: `sha256:${"a".repeat(64)}`,
    };
    const expected = {
      artifactId: "artifact-1",
      tenantId: "tenant-1",
      artifactKind: "runtime_revision" as const,
      artifactDigest: `sha256:${"a".repeat(64)}`,
    };
    expect(() =>
      validateFrozenArtifactAuthority({ artifact, attestationArtifactId: "artifact-1", expected }),
    ).not.toThrow();
    expect(() =>
      validateFrozenArtifactAuthority({ artifact, attestationArtifactId: null, expected }),
    ).toThrow(/Artifact/);
    expect(() =>
      validateFrozenArtifactAuthority({
        artifact: { ...artifact, digest: `sha256:${"b".repeat(64)}` },
        attestationArtifactId: "artifact-1",
        expected,
      }),
    ).toThrow(/Artifact/);

    const source = readFileSync(
      new URL("./mysql-execution-binding-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('"AgentArtifact"');
    expect(source).toContain('"RuntimeArtifact"');
    // 锁序契约：AgentArtifact 必须先于 AgentArtifactAttestation 加 FOR UPDATE 锁。
    // 仅比较文本出现的先后会误判（代码在加锁前会先做一次非加锁的 Attestation key 探测）。
    expect(firstForUpdateLockIndex(source, "artifact")).toBeLessThan(
      firstForUpdateLockIndex(source, "artifactAttestation"),
    );
    expect(source).toContain("artifactId: evidence.agentArtifactId");
    expect(source).toContain("artifactId: evidence.runtimeArtifactId");
    expect(source).not.toContain("artifactId: attestationKey.artifactId");
  });

  it("Publication evidenceSetDigest 必须由完整锁后证据重算一致", () => {
    const agent = {
      evidenceSetDigest: computePublicationEvidenceSetDigest({
        attestationIds: ["attestation-1"],
        conformanceRunId: null,
        approvals: [],
      }),
      attestationIds: ["attestation-1"],
      conformanceRunId: null,
      approvals: [],
    };
    expect(() => validateFrozenPublicationEvidenceDigest({ publication: agent })).not.toThrow();

    const runtime = {
      evidenceSetDigest: computePublicationEvidenceSetDigest({
        attestationIds: ["attestation-2"],
        conformanceRunId: "run-1",
        approvals: [],
        additionalEvidence: { evidenceManifestDigest: "sha256:manifest" },
      }),
      attestationIds: ["attestation-2"],
      conformanceRunId: "run-1",
      approvals: [],
    };
    expect(() =>
      validateFrozenPublicationEvidenceDigest({
        publication: runtime,
        additionalEvidence: { evidenceManifestDigest: "sha256:manifest" },
      }),
    ).not.toThrow();
    expect(() =>
      validateFrozenPublicationEvidenceDigest({
        publication: { ...runtime, evidenceSetDigest: `sha256:${"0".repeat(64)}` },
        additionalEvidence: { evidenceManifestDigest: "sha256:manifest" },
      }),
    ).toThrow(/Evidence Set Digest/);
  });

  it("冻结 ConformanceRun 必须完成且满足正式合同 Case 精确全集", () => {
    const caseResults = ALL_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true }));
    const base = {
      run: {
        id: "conformance-run-1",
        tenantId: "tenant-1",
        runtimeRevisionId: "runtime-revision-1",
        runtimeArtifactDigest: `sha256:${"a".repeat(64)}`,
        runtimeConfigDigest: `sha256:${"b".repeat(64)}`,
        protocolContractRevision: "agent-runtime-protocol@1",
        suiteRevision: CONFORMANCE_SUITE_REVISION,
        overallResult: "passed" as const,
        conformanceFormat: "standard_dsse" as const,
        startedAt: new Date("2026-08-11T00:00:00.000Z"),
        completedAt: new Date("2026-08-11T00:01:00.000Z"),
        verifiedAt: new Date("2026-08-11T00:01:01.000Z"),
        evidenceManifestDigest: `sha256:${"c".repeat(64)}`,
      },
      caseResults,
      expected: {
        conformanceRunId: "conformance-run-1",
        tenantId: "tenant-1",
        runtimeRevisionId: "runtime-revision-1",
        runtimeArtifactDigest: `sha256:${"a".repeat(64)}`,
        runtimeConfigDigest: `sha256:${"b".repeat(64)}`,
        protocolContractRevision: "agent-runtime-protocol@1",
      },
    };

    expect(() => validateFrozenConformanceAuthority(base)).not.toThrow();
    expect(() =>
      validateFrozenConformanceAuthority({
        ...base,
        run: { ...base.run, id: "other-run" },
      }),
    ).toThrow(/ConformanceRun/);
    expect(() =>
      validateFrozenConformanceAuthority({
        ...base,
        run: { ...base.run, completedAt: null },
      }),
    ).toThrow(/完成/);
    expect(() =>
      validateFrozenConformanceAuthority({
        ...base,
        caseResults: caseResults.slice(1),
      }),
    ).toThrow(/Conformance/);
    expect(() =>
      validateFrozenConformanceAuthority({
        ...base,
        caseResults: [...caseResults.slice(0, -1), { caseId: "unknown-case", passed: true }],
      }),
    ).toThrow(/Case/);
    expect(() =>
      validateFrozenConformanceAuthority({
        ...base,
        caseResults: caseResults.map((result, index) =>
          index === 0 ? { ...result, passed: false } : result,
        ),
      }),
    ).toThrow(/Conformance/);
  });

  it("冻结 Policy 必须属于当前租户且保持 published", () => {
    const base = {
      policy: {
        id: "policy-revision-1",
        policySetId: "policy-set-1",
        tenantId: "tenant-1",
        revisionState: "published",
      },
      expected: {
        policyRevisionId: "policy-revision-1",
        policySetId: "policy-set-1",
        tenantId: "tenant-1",
      },
    };
    expect(() => validateFrozenPolicyAuthority(base)).not.toThrow();
    expect(() =>
      validateFrozenPolicyAuthority({
        ...base,
        policy: { ...base.policy, tenantId: "other-tenant" },
      }),
    ).toThrow(/stale/);
    expect(() =>
      validateFrozenPolicyAuthority({
        ...base,
        policy: { ...base.policy, revisionState: "withdrawn" },
      }),
    ).toThrow(/stale/);
  });

  it("最终 Projection 必须与所有冻结 authority 字段精确一致", () => {
    const expected = {
      routeId: "route-1",
      tenantId: "tenant-1",
      projectionVersionNo: 7,
      routeRevisionId: "route-revision-1",
      routeActivationId: "activation-1",
      agentRevisionId: "agent-revision-1",
      runtimeRevisionId: "runtime-revision-1",
      policyRevisionId: "policy-revision-1",
      routeContentDigest: `sha256:${"1".repeat(64)}`,
      agentArtifactId: "agent-artifact-1",
      runtimeArtifactId: "runtime-artifact-1",
      agentArtifactDigest: `sha256:${"2".repeat(64)}`,
      runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
      runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
      capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
      agentPublicationRecordId: "agent-publication-1",
      runtimePublicationRecordId: "runtime-publication-1",
      agentAttestationIds: ["agent-attestation-1"],
      runtimeAttestationIds: ["runtime-attestation-1"],
      conformanceRunId: "conformance-run-1",
    };
    const projection = {
      ...expected,
      eligibilityState: "eligible" as const,
      activationState: "active" as const,
      capabilityCompatibilityDigest: expected.capabilityManifestDigest,
    };

    expect(() => validateFrozenProjectionAuthority({ projection, expected })).not.toThrow();
    for (const changed of [
      { projectionVersionNo: 8 },
      { routeActivationId: "new-activation" },
      { eligibilityState: "ineligible" as const },
      { activationState: "disabled" as const },
      { runtimeArtifactDigest: `sha256:${"9".repeat(64)}` },
      { capabilityCompatibilityDigest: `sha256:${"9".repeat(64)}` },
      { agentAttestationIds: ["agent-attestation-1", "agent-attestation-2"] },
      { runtimeAttestationIds: [] },
    ]) {
      expect(() =>
        validateFrozenProjectionAuthority({ projection: { ...projection, ...changed }, expected }),
      ).toThrow(/stale/);
    }
  });

  it("Policy 后最终锁 Projection", () => {
    const source = readFileSync(
      new URL("./mysql-execution-binding-store.ts", import.meta.url),
      "utf8",
    );
    const policyLock = source.indexOf("await lockAndVerifyPolicy(tx, input)");
    const projectionLock = source.indexOf("await lockAndVerifyProjection(tx, input)");
    expect(policyLock).toBeGreaterThan(0);
    expect(projectionLock).toBeGreaterThan(policyLock);
    expect(source).not.toContain(".innerJoin(policySetTable");
    const policyKeyRead = source.indexOf("const [policyKey]", policyLock);
    const policySetLock = source.indexOf("const [policySet]", policyKeyRead);
    const policyRevisionLock = source.indexOf("const [policyRevision]", policySetLock);
    expect(policyKeyRead).toBeGreaterThan(policyLock);
    expect(policySetLock).toBeGreaterThan(policyKeyRead);
    expect(policyRevisionLock).toBeGreaterThan(policySetLock);
  });
});
