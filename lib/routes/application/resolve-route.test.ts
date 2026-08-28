import { createHash, randomUUID } from "node:crypto";
import {
  createAgent,
  getAgentById,
  updateAgentLifecycle,
} from "@/lib/agents/persistence/agent-queries";
import { createDraftRevisionWithContractSnapshot } from "@/lib/agents/test-support/create-draft-revision-with-contract";
import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/deployment-route";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { computeSelectorDigest, normalizeEligibility } from "@/lib/routes/domain/route-selector";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { PUBLICATION_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-03T01:00:00.000Z");
const resolveRoute = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });

interface AuthorityFixture {
  tenantId: string;
  agentId: string;
  agentRevisionId: string;
  routeSetId: string;
  runtimePublicationId: string;
  runtimeAttestationId: string;
  runtimeRevisionId: string;
  runtimeArtifactId: string;
  routeId: string;
  routeRevisionId: string;
}

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  await resetDatabase(db);
});

async function seedAgentAuthority() {
  const tenant = await ensureDefaultTenant();
  const createdAgent = await createAgent({
    tenantId: tenant.id,
    agentKey: `resolver-${randomUUID()}`,
    displayName: "Resolver Agent",
    ownerUserId: randomUUID(),
  });
  await updateAgentLifecycle(tenant.id, createdAgent.id, "enabled", createdAgent.versionNo);
  const agent = await getAgentById(tenant.id, createdAgent.id);
  if (!agent) throw new Error("Agent 启用后无法回读");
  const revision = await createDraftRevisionWithContractSnapshot({
    tenantId: tenant.id,
    agentId: agent.id,
    modelPolicyJson: { default: "resolver-model" },
    permissionRequirementsJson: {},
    delegationPolicyJson: {},
    agentInterfaceRequirementsJson: { required: ["event_stream"] },
    createdBy: "resolver-test",
  });
  const publication = await publishTrustedAgentRevisionForTest({
    tenantId: tenant.id,
    revisionId: revision.id,
    agentExpectedVersionNo: agent.versionNo,
    actorId: "resolver-test",
  });
  const agentPublicationId = publication.publicationRecordId;
  const routeSetId = randomUUID();
  await db.insert(deploymentRouteSetTable).values({
    id: routeSetId,
    tenantId: tenant.id,
    agentId: agent.id,
    routeScopeKey: "prod",
    routeScopeJson: { environment: "prod" },
    versionNo: 1,
  });
  return {
    tenantId: tenant.id,
    agentId: agent.id,
    agentRevisionId: revision.id,
    agentPublicationId,
    routeSetId,
  };
}

async function addRuntimeRoute(
  base: Awaited<ReturnType<typeof seedAgentAuthority>>,
  suffix: string,
  options: {
    trafficWeight?: number;
    priorityNo?: number;
    routeRevisionNo?: number;
    routeGroupId?: string;
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
    activationState?: "active" | "disabled";
    eligibilityConditions?: unknown;
    conformanceConfigDigest?: string;
  } = {},
): Promise<AuthorityFixture> {
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const artifactId = randomUUID();
  const runtimeAttestationId = randomUUID();
  const artifactDigest = digest(`runtime-artifact:${suffix}`);
  const configDigest = digest(`runtime-config:${suffix}`);
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: base.tenantId,
    runtimeKey: `runtime-${suffix}`,
    displayName: `Runtime ${suffix}`,
    runtimeKind: "external",
    ownerUserId: randomUUID(),
    lifecycleState: "enabled",
    currentRevisionId: runtimeRevisionId,
    versionNo: 2,
  });
  await db.insert(artifact).values({
    id: artifactId,
    tenantId: base.tenantId,
    kind: "runtime",
    digest: artifactDigest,
  });
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "agent-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    runtimeTargetDigest: artifactDigest,
    endpointRef: `connection://${runtimeId}`,
    runtimeArtifactRef: `oci://runtime-${suffix}`,
    artifactId,
    artifactDigest,
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "workload_token",
    networkZone: "internal",
    configHash: configDigest,
    revisionState: "published",
    createdBy: "resolver-test",
    publishedAt: NOW,
  });
  await db.insert(artifactAttestation).values({
    id: runtimeAttestationId,
    tenantId: base.tenantId,
    artifactId,
    artifactType: "runtime_revision",
    artifactRevisionId: runtimeRevisionId,
    artifactDigest,
    dsseEnvelopeRef: `attestation://dsse/${runtimeAttestationId}`,
    sbomRef: `sbom://${runtimeAttestationId}`,
    provenanceRef: `provenance://${runtimeAttestationId}`,
    builderIdentity: "resolver-test-builder",
    verificationState: "verified",
    verifiedAt: NOW,
  });
  const conformanceRunId = randomUUID();
  await db.insert(runtimeConformanceRun).values({
    id: conformanceRunId,
    tenantId: base.tenantId,
    runtimeRevisionId,
    runtimeTargetDigest: artifactDigest,
    runtimeConfigDigest: options.conformanceConfigDigest ?? configDigest,
    protocolContractRevision: "agent-runtime-protocol@1",
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: `sha256:${"f".repeat(64)}`,
    runnerIdentity: "resolver-test-runner",
    testEnvironmentRevision: "mysql8-test@1",
    startedAt: NOW,
    completedAt: new Date(NOW.getTime() + 1_000),
    overallResult: "passed",
    evidenceManifestDigest: digest(`conformance-evidence:${runtimeId}`),
    conformanceFormat: "standard_dsse",
    envelopeDigest: digest(`envelope:${runtimeId}`),
    envelopeJson: "{}",
    payloadDigest: digest(`payload:${runtimeId}`),
    signingKeyId: "resolver-test-key",
    verificationEngine: "dsse-ed25519",
    verificationEngineVersion: "1",
    predicateType: "https://snowharness.dev/attestation/runtime-conformance/v1",
    verifiedAt: NOW,
    idempotencyKey: `conformance:${runtimeRevisionId}`,
    requestId: `resolver:${runtimeRevisionId}`,
    recordedAt: NOW,
  });
  // 统一 Runtime Conformance 验证要求全部 Publication Case 通过（见
  // runtime-conformance-contract 的 PUBLICATION_CONFORMANCE_CASES）。播种 ConformanceRun
  // 后须同步播种完整 Case 结果，投影的 Conformance 资格才会放行。
  await db.insert(runtimeConformanceCaseResult).values(
    PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
      id: randomUUID(),
      runId: conformanceRunId,
      caseId,
      passed: true,
      reason: null,
      evidenceDigest: digest(`conformance-case:${caseId}`),
    })),
  );
  const runtimePublicationId = randomUUID();
  await db.insert(publicationRecord).values({
    id: runtimePublicationId,
    tenantId: base.tenantId,
    subjectType: "runtime_revision",
    subjectRevisionId: runtimeRevisionId,
    evidenceSetDigest: digest(`publication-evidence:${runtimeRevisionId}`),
    attestationIds: [runtimeAttestationId],
    conformanceRunId,
    approvals: [],
    publishedByType: "system",
    publishedBy: "resolver-test",
    publishedAt: NOW,
    idempotencyKey: `publish-runtime:${runtimeRevisionId}`,
  });

  const routeId = randomUUID();
  const routeRevisionId = randomUUID();
  const routeActivationId = randomUUID();
  const routeRevisionNo = options.routeRevisionNo ?? 1;
  const trafficWeight = options.trafficWeight ?? 10_000;
  await db.insert(deploymentRouteTable).values({
    id: routeId,
    routeSetId: base.routeSetId,
    routeKey: `test-route-${routeId}`,
    agentRevisionId: base.agentRevisionId,
    runtimeRevisionId,
    trafficWeight,
    priorityNo: options.priorityNo ?? 0,
    routeState: options.activationState === "disabled" ? "disabled" : "enabled",
    effectiveFrom: options.effectiveFrom ?? null,
    effectiveUntil: options.effectiveUntil ?? null,
    activeRouteRevisionId: null,
  });
  await db.insert(routeRevision).values({
    id: routeRevisionId,
    tenantId: base.tenantId,
    routeId,
    routeSetId: base.routeSetId,
    routeKey: `test-route-${routeId}`,
    revisionNo: routeRevisionNo,
    agentRevisionId: base.agentRevisionId,
    runtimeRevisionId,
    policyRevisionId: null,
    modelPolicyRevisionId: null,
    toolsetRevisionId: null,
    trafficAllocationJson: {
      weightBasisPoints: trafficWeight,
      groupId: options.routeGroupId ?? "primary",
    },
    routeGroupId: options.routeGroupId ?? "primary",
    selectorDigest: computeSelectorDigest(
      normalizeEligibility(options.eligibilityConditions ?? {}) ?? { all: {} },
    ),
    trafficWeight,
    priorityNo: options.priorityNo ?? 0,
    effectiveFrom: options.effectiveFrom ?? null,
    effectiveUntil: options.effectiveUntil ?? null,
    eligibilityConditionsJson: options.eligibilityConditions ?? {},
    contentDigest: digest(`route-revision:${routeId}`),
    createdByType: "system",
    createdBy: "resolver-test",
    validatedAt: NOW,
    createdAt: NOW,
  });
  await db.insert(routeActivation).values({
    id: routeActivationId,
    tenantId: base.tenantId,
    routeId,
    routeRevisionId,
    routeSetId: base.routeSetId,
    activationSequence: 1,
    activationState: options.activationState ?? "active",
    previousRouteRevisionId: null,
    routeSetVersionNo: 1,
    activatedByType: "system",
    activatedBy: "resolver-test",
    reason: "resolver test fixture",
    requestId: `resolver:${routeId}`,
    idempotencyKey: `activate:${routeId}`,
    activatedAt: NOW,
  });
  await db
    .update(deploymentRouteTable)
    .set({ activeRouteRevisionId: routeRevisionId })
    .where(eq(deploymentRouteTable.id, routeId));
  // : Resolver 只读 RouteEligibilityProjection（投影是运行时唯一解析数据源），
  // 播种权威表后须构建投影，解析器才能命中 eligible 候选。
  await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
    tenantId: base.tenantId,
    routeId,
  });
  return {
    ...base,
    runtimePublicationId,
    runtimeAttestationId,
    runtimeRevisionId,
    runtimeArtifactId: artifactId,
    routeId,
    routeRevisionId,
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function command(fixture: Awaited<ReturnType<typeof seedAgentAuthority>>, threadId: string) {
  return {
    tenantId: fixture.tenantId,
    // : ResolveRouteCommand 字段已从 agentId 改为 agentConstraint（§8.3）。
    agentConstraint: fixture.agentId,
    routeScopeKey: "prod",
    businessKey: { threadId },
    attributes: {},
    now: NOW,
  };
}

describe("RouteResolver MySQL authority", () => {
  it("从 Active RouteRevision 稳定选择同一权重组且不同业务键可命中两个候选", async () => {
    const base = await seedAgentAuthority();
    const first = await addRuntimeRoute(base, "1", { trafficWeight: 5_000 });
    const second = await addRuntimeRoute(base, "2", { trafficWeight: 5_000 });

    const seen = new Set<string>();
    for (let index = 0; index < 100 && seen.size < 2; index += 1) {
      const result = await resolveRoute(command(base, `thread-${index}`));
      if (result.status === "resolved") seen.add(result.resolution.routeRevisionId);
    }
    expect(seen).toEqual(new Set([first.routeRevisionId, second.routeRevisionId]));

    const repeated = await Promise.all([
      resolveRoute(command(base, "sticky-thread")),
      resolveRoute(command(base, "sticky-thread")),
    ]);
    expect(repeated[1]).toEqual(repeated[0]);
  });

  it("解析结果冻结发布、证明、制品和 Conformance 权威证据", async () => {
    const base = await seedAgentAuthority();
    const fixture = await addRuntimeRoute(base, "evidence");

    await expect(resolveRoute(command(base, "thread-evidence"))).resolves.toMatchObject({
      status: "resolved",
      resolution: {
        routeRevisionId: fixture.routeRevisionId,
        controlPlaneEvidence: {
          runtimeArtifactId: fixture.runtimeArtifactId,
          runtimeTargetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          runtimeConfigDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          capabilityManifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          runtimeAttestationIds: [fixture.runtimeAttestationId],
          agentPublicationRecordId: base.agentPublicationId,
          runtimePublicationRecordId: fixture.runtimePublicationId,
          conformanceRunId: expect.any(String),
        },
      },
    });
  });

  it("未来和已过期 RouteRevision 不参与解析", async () => {
    const base = await seedAgentAuthority();
    await addRuntimeRoute(base, "future", {
      effectiveFrom: new Date(NOW.getTime() + 1),
    });

    await expect(resolveRoute(command(base, "thread-window"))).resolves.toEqual({
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 1,
    });
  });

  it("Runtime 发布撤回或 Attestation 撤销后立即 fail-closed", async () => {
    const base = await seedAgentAuthority();
    const fixture = await addRuntimeRoute(base, "revoked");

    const before = await resolveRoute(command(base, "thread-before-revoke"));
    expect(before.status).toBe("resolved");

    await db.insert(attestationRevocationRecord).values({
      id: randomUUID(),
      tenantId: base.tenantId,
      attestationId: fixture.runtimeAttestationId,
      revokedByType: "system",
      revokedBy: "resolver-test",
      reason: "test revocation",
      requestId: "resolver-revoke",
      revokedAt: NOW,
    });
    // : 撤销 Authority 记录后须重建投影（模拟 outbox relay 的
    // artifact.attestation.revoked → rebuildFromAuthority），解析器才会 fail-closed。
    await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId: base.tenantId,
      routeId: fixture.routeId,
    });
    await expect(resolveRoute(command(base, "thread-after-revoke"))).resolves.toMatchObject({
      status: "unresolved",
      reason: "no_eligible_route",
    });
  });

  it("PublicationRecord 已撤回时不依赖 published 投影继续放行", async () => {
    const base = await seedAgentAuthority();
    const fixture = await addRuntimeRoute(base, "withdrawn");
    await db.insert(withdrawalRecord).values({
      id: randomUUID(),
      tenantId: base.tenantId,
      publicationRecordId: fixture.runtimePublicationId,
      subjectType: "runtime_revision",
      subjectRevisionId: fixture.runtimeRevisionId,
      reasonCode: "security",
      reason: "resolver withdrawal test",
      withdrawnByType: "system",
      withdrawnBy: "resolver-test",
      withdrawnAt: NOW,
    });
    // : 撤回 Authority 记录后须重建投影（模拟 outbox relay 的
    // runtime.revision.withdrawn → rebuildFromAuthority），解析器才会 fail-closed。
    await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId: base.tenantId,
      routeId: fixture.routeId,
    });
    await expect(resolveRoute(command(base, "thread-withdrawn"))).resolves.toMatchObject({
      status: "unresolved",
      reason: "no_eligible_route",
    });
  });

  it("Conformance Run 与 Runtime config digest 不匹配时不参与解析", async () => {
    const base = await seedAgentAuthority();
    await addRuntimeRoute(base, "mismatch", {
      conformanceConfigDigest: `sha256:${"9".repeat(64)}`,
    });

    await expect(resolveRoute(command(base, "thread-mismatch"))).resolves.toMatchObject({
      status: "unresolved",
      reason: "no_eligible_route",
    });
  });

  it("解析结果冻结激活时的 RouteSet 版本而非后续投影版本", async () => {
    const base = await seedAgentAuthority();
    await addRuntimeRoute(base, "frozen-route-set-version");
    await db
      .update(deploymentRouteSetTable)
      .set({ versionNo: 2 })
      .where(eq(deploymentRouteSetTable.id, base.routeSetId));

    await expect(resolveRoute(command(base, "thread-frozen-version"))).resolves.toMatchObject({
      status: "resolved",
      resolution: { routeSetVersionNo: 1 },
    });
  });

  it("无 Agent 约束解析基础 Harness Route（agentRevisionId=null）", async () => {
    // : §8.3 — RouteSet.agentId=null + RouteRevision.agentRevisionId=null
    // 是"基础 Harness Route"的唯一合法表级表示（§8.4 禁空串/"default"）。
    const tenant = await ensureDefaultTenant();
    const tenantId = tenant.id;

    // Runtime + published Revision + Conformance + Publication（复用与 addRuntimeRoute 相同的权威事实）
    const runtimeId = randomUUID();
    const runtimeRevisionId = randomUUID();
    const runtimeArtifactId = randomUUID();
    const runtimeAttestationId = randomUUID();
    const runtimeArtifactDigest = digest("runtime-base");
    const runtimeConfigDigest = digest("runtime-base-config");
    await db.insert(runtimeTable).values({
      id: runtimeId,
      tenantId,
      runtimeKey: "runtime-base",
      displayName: "Base Runtime",
      runtimeKind: "external",
      ownerUserId: randomUUID(),
      lifecycleState: "enabled",
      currentRevisionId: runtimeRevisionId,
      versionNo: 2,
    });
    await db.insert(artifact).values({
      id: runtimeArtifactId,
      tenantId,
      kind: "runtime",
      digest: runtimeArtifactDigest,
    });
    await db.insert(runtimeRevisionTable).values({
      id: runtimeRevisionId,
      runtimeId,
      revisionNo: 1,
      protocolType: "harness_runtime_protocol",
      protocolContractRevision: "agent-runtime-protocol@1",
      runtimeEvidenceKind: "hosted_artifact",
      runtimeTargetDigest: runtimeArtifactDigest,
      endpointRef: `connection://${runtimeId}`,
      runtimeArtifactRef: "oci://runtime-base",
      artifactId: runtimeArtifactId,
      artifactDigest: runtimeArtifactDigest,
      runtimeCapabilitiesJson: ["event_stream"],
      identityMode: "workload_token",
      networkZone: "internal",
      configHash: runtimeConfigDigest,
      revisionState: "published",
      createdBy: "resolver-test",
      publishedAt: NOW,
    });
    await db.insert(artifactAttestation).values({
      id: runtimeAttestationId,
      tenantId,
      artifactId: runtimeArtifactId,
      artifactType: "runtime_revision",
      artifactRevisionId: runtimeRevisionId,
      artifactDigest: runtimeArtifactDigest,
      dsseEnvelopeRef: `attestation://dsse/${runtimeAttestationId}`,
      sbomRef: `sbom://${runtimeAttestationId}`,
      provenanceRef: `provenance://${runtimeAttestationId}`,
      builderIdentity: "resolver-test-builder",
      verificationState: "verified",
      verifiedAt: NOW,
    });
    const conformanceRunId = randomUUID();
    await db.insert(runtimeConformanceRun).values({
      id: conformanceRunId,
      tenantId,
      runtimeRevisionId,
      runtimeTargetDigest: runtimeArtifactDigest,
      runtimeConfigDigest: runtimeConfigDigest,
      protocolContractRevision: "agent-runtime-protocol@1",
      suiteRevision: "runtime-conformance@1",
      runnerArtifactDigest: `sha256:${"f".repeat(64)}`,
      runnerIdentity: "resolver-test-runner",
      testEnvironmentRevision: "mysql8-test@1",
      startedAt: NOW,
      completedAt: new Date(NOW.getTime() + 1_000),
      overallResult: "passed",
      evidenceManifestDigest: digest("conformance-base"),
      conformanceFormat: "standard_dsse",
      envelopeDigest: digest("envelope-base"),
      envelopeJson: "{}",
      payloadDigest: digest("payload-base"),
      signingKeyId: "resolver-test-key",
      verificationEngine: "dsse-ed25519",
      verificationEngineVersion: "1",
      predicateType: "https://snowharness.dev/attestation/runtime-conformance/v1",
      verifiedAt: NOW,
      idempotencyKey: `conformance:${runtimeRevisionId}`,
      requestId: `resolver:${runtimeRevisionId}`,
      recordedAt: NOW,
    });
    await db.insert(runtimeConformanceCaseResult).values(
      PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
        id: randomUUID(),
        runId: conformanceRunId,
        caseId,
        passed: true,
        reason: null,
        evidenceDigest: digest(`conformance-case:${caseId}`),
      })),
    );
    const runtimePublicationId = randomUUID();
    await db.insert(publicationRecord).values({
      id: runtimePublicationId,
      tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: runtimeRevisionId,
      evidenceSetDigest: `sha256:${"d".repeat(64)}`,
      attestationIds: [runtimeAttestationId],
      conformanceRunId,
      approvals: [],
      publishedByType: "system",
      publishedBy: "resolver-test",
      publishedAt: NOW,
      idempotencyKey: `publish-runtime:${runtimeRevisionId}`,
    });

    // 基础 Harness RouteSet（agentId=null）
    const baseRouteSetId = randomUUID();
    await db.insert(deploymentRouteSetTable).values({
      id: baseRouteSetId,
      tenantId,
      agentId: null,
      routeScopeKey: "prod",
      routeScopeJson: { environment: "prod" },
      versionNo: 1,
    });

    // RouteRevision（agentRevisionId=null）+ Activation + 投影
    const routeId = randomUUID();
    const routeRevisionId = randomUUID();
    await db.insert(deploymentRouteTable).values({
      id: routeId,
      routeSetId: baseRouteSetId,
      routeKey: "base-primary",
      agentRevisionId: null,
      runtimeRevisionId,
      routeState: "enabled",
      trafficWeight: 10_000,
      priorityNo: 0,
      effectiveFrom: null,
      effectiveUntil: null,
      activeRouteRevisionId: routeRevisionId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(routeRevision).values({
      id: routeRevisionId,
      tenantId,
      routeId,
      routeSetId: baseRouteSetId,
      routeKey: "base-primary",
      revisionNo: 1,
      agentRevisionId: null,
      runtimeRevisionId,
      policyRevisionId: null,
      modelPolicyRevisionId: null,
      toolsetRevisionId: null,
      trafficAllocationJson: {
        weightBasisPoints: 10_000,
        groupId: "primary",
      },
      routeGroupId: "primary",
      selectorDigest: computeSelectorDigest(normalizeEligibility({}) ?? { all: {} }),
      trafficWeight: 10_000,
      priorityNo: 0,
      effectiveFrom: null,
      effectiveUntil: null,
      eligibilityConditionsJson: {},
      contentDigest: digest(`route-revision:${routeId}`),
      createdByType: "system",
      createdBy: "resolver-test",
      validatedAt: NOW,
      createdAt: NOW,
    });
    await db.insert(routeActivation).values({
      id: randomUUID(),
      tenantId,
      routeId,
      routeRevisionId,
      routeSetId: baseRouteSetId,
      activationSequence: 1,
      activationState: "active",
      previousRouteRevisionId: null,
      routeSetVersionNo: 1,
      activatedByType: "system",
      activatedBy: "resolver-test",
      reason: "base harness route fixture",
      requestId: `resolver:${routeId}`,
      idempotencyKey: `activate:${routeId}`,
      activatedAt: NOW,
    });
    await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId,
      routeId,
    });

    // 无 Agent 约束解析 → 命中基础 Harness Route，agentRevisionId=null
    const result = await resolveRoute({
      tenantId,
      agentConstraint: null,
      routeScopeKey: "prod",
      businessKey: { threadId: "base-thread" },
      attributes: {},
      now: NOW,
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.resolution.agentRevisionId).toBeNull();
    expect(result.resolution.runtimeRevisionId).toBe(runtimeRevisionId);
  });
});
