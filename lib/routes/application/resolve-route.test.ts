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
import {
  type ResolveRouteCommand,
  createResolveRoute,
} from "@/lib/routes/application/resolve-route";
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

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  await resetDatabase(db);
});

// ─── Agent Authority（独立：不创建任何 Runtime 事实）─────────────

interface AgentAuthorityFixture {
  tenantId: string;
  agentId: string;
  agentRevisionId: string;
  agentPublicationId: string;
  routeSetId: string;
}

async function seedAgentAuthority(): Promise<AgentAuthorityFixture> {
  const tenant = await ensureDefaultTenant();
  const createdAgent = await createAgent({
    tenantId: tenant.id,
    agentKey: `resolver-agent-${randomUUID()}`,
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
  const routeSetId = randomUUID();
  await db.insert(deploymentRouteSetTable).values({
    id: routeSetId,
    tenantId: tenant.id,
    targetKind: "agent",
    targetIdentity: agent.id,
    agentId: agent.id,
    routeScopeKey: "prod",
    routeScopeJson: { environment: "prod" },
    versionNo: 1,
  });
  return {
    tenantId: tenant.id,
    agentId: agent.id,
    agentRevisionId: revision.id,
    agentPublicationId: publication.publicationRecordId,
    routeSetId,
  };
}

interface AgentRouteFixture extends AgentAuthorityFixture {
  routeId: string;
  routeRevisionId: string;
}

/**
 * Agent-only Route：不创建 RuntimeRevision/Runtime 事实（专题01 冻结架构，
 * Agent Route activation 不得创建 RuntimeRevision）。
 */
async function addAgentRoute(
  base: AgentAuthorityFixture,
  suffix: string,
  options: {
    trafficWeight?: number;
    priorityNo?: number;
    routeGroupId?: string;
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
    activationState?: "active" | "disabled";
    eligibilityConditions?: unknown;
    agentRouteFacts?: {
      agentEndpointRef: string;
      agentIdentityMode: "none" | "bearer";
      agentCredentialRefId: string | null;
      agentNetworkZone: string;
    };
  } = {},
): Promise<AgentRouteFixture> {
  const routeId = randomUUID();
  const routeRevisionId = randomUUID();
  const routeActivationId = randomUUID();
  const trafficWeight = options.trafficWeight ?? 10_000;
  const facts = options.agentRouteFacts ?? {
    agentEndpointRef: `https://agent-${suffix}.example.com/capability`,
    agentIdentityMode: "none" as const,
    agentCredentialRefId: null,
    agentNetworkZone: "cn-north",
  };
  await db.insert(deploymentRouteTable).values({
    id: routeId,
    routeSetId: base.routeSetId,
    routeKey: `agent-route-${routeId}`,
    agentRevisionId: base.agentRevisionId,
    runtimeRevisionId: null,
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
    routeKey: `agent-route-${routeId}`,
    revisionNo: 1,
    agentRevisionId: base.agentRevisionId,
    runtimeRevisionId: null,
    agentEndpointRef: facts.agentEndpointRef,
    agentIdentityMode: facts.agentIdentityMode,
    agentCredentialRefId: facts.agentCredentialRefId,
    agentNetworkZone: facts.agentNetworkZone,
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
    contentDigest: digest(`agent-route-revision:${routeId}`),
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
    reason: "resolver agent route fixture",
    requestId: `resolver:${routeId}`,
    idempotencyKey: `activate:${routeId}`,
    activatedAt: NOW,
  });
  await db
    .update(deploymentRouteTable)
    .set({ activeRouteRevisionId: routeRevisionId })
    .where(eq(deploymentRouteTable.id, routeId));
  await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
    tenantId: base.tenantId,
    routeId,
  });
  return { ...base, routeId, routeRevisionId };
}

function agentCommand(fixture: AgentAuthorityFixture, threadId: string): ResolveRouteCommand {
  return {
    tenantId: fixture.tenantId,
    target: { kind: "agent", agentId: fixture.agentId },
    routeScopeKey: "prod",
    businessKey: { threadId },
    attributes: {},
    now: NOW,
  };
}

// ─── Runtime Authority（独立：不创建任何 Agent 事实）─────────────

interface RuntimeAuthorityFixture {
  tenantId: string;
  runtimePublicationId: string;
  runtimeAttestationId: string;
  runtimeRevisionId: string;
  runtimeArtifactId: string;
  routeSetId: string;
}

async function seedRuntimeAuthority(): Promise<RuntimeAuthorityFixture> {
  const tenant = await ensureDefaultTenant();
  const tenantId = tenant.id;
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const artifactId = randomUUID();
  const runtimeAttestationId = randomUUID();
  const runtimeArtifactDigest = digest("runtime-base");
  const runtimeConfigDigest = digest("runtime-base-config");
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId,
    runtimeKey: `runtime-${randomUUID()}`,
    displayName: "Base Runtime",
    runtimeKind: "external",
    ownerUserId: randomUUID(),
    lifecycleState: "enabled",
    currentRevisionId: runtimeRevisionId,
    versionNo: 2,
  });
  await db.insert(artifact).values({
    id: artifactId,
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
    artifactId,
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
    artifactId,
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
  const routeSetId = randomUUID();
  await db.insert(deploymentRouteSetTable).values({
    id: routeSetId,
    tenantId,
    targetKind: "runtime",
    targetIdentity: "runtime",
    agentId: null,
    routeScopeKey: "prod",
    routeScopeJson: { environment: "prod" },
    versionNo: 1,
  });
  return {
    tenantId,
    runtimePublicationId,
    runtimeAttestationId,
    runtimeRevisionId,
    runtimeArtifactId: artifactId,
    routeSetId,
  };
}

interface RuntimeRouteFixture extends RuntimeAuthorityFixture {
  routeId: string;
  routeRevisionId: string;
  conformanceRunId: string;
}

/**
 * Runtime-only Route：不创建 Agent/AgentRevision 事实（专题01 冻结架构，
 * Runtime Route activation 不得创建 Agent）。
 */
async function addRuntimeRoute(
  base: RuntimeAuthorityFixture,
  suffix: string,
  options: {
    trafficWeight?: number;
    priorityNo?: number;
    routeGroupId?: string;
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
    activationState?: "active" | "disabled";
    eligibilityConditions?: unknown;
    conformanceConfigDigest?: string;
  } = {},
): Promise<RuntimeRouteFixture> {
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
  const trafficWeight = options.trafficWeight ?? 10_000;
  await db.insert(deploymentRouteTable).values({
    id: routeId,
    routeSetId: base.routeSetId,
    routeKey: `rt-route-${routeId}`,
    agentRevisionId: null,
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
    routeKey: `rt-route-${routeId}`,
    revisionNo: 1,
    agentRevisionId: null,
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
    contentDigest: digest(`rt-route-revision:${routeId}`),
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
    reason: "resolver runtime route fixture",
    requestId: `resolver:${routeId}`,
    idempotencyKey: `activate:${routeId}`,
    activatedAt: NOW,
  });
  await db
    .update(deploymentRouteTable)
    .set({ activeRouteRevisionId: routeRevisionId })
    .where(eq(deploymentRouteTable.id, routeId));
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
    conformanceRunId,
  };
}

function runtimeCommand(fixture: RuntimeAuthorityFixture, threadId: string): ResolveRouteCommand {
  return {
    tenantId: fixture.tenantId,
    target: { kind: "runtime" },
    routeScopeKey: "prod",
    businessKey: { threadId },
    attributes: {},
    now: NOW,
  };
}

describe("RouteResolver MySQL authority — Agent target", () => {
  it("[RED] Agent Route activation 不创建 RuntimeRevision：agent A resolver 命中 agent-only 路由", async () => {
    const base = await seedAgentAuthority();
    const fixture = await addAgentRoute(base, "a", { trafficWeight: 10_000 });

    const result = await resolveRoute(agentCommand(base, "thread-agent"));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.resolution.routeRevisionId).toBe(fixture.routeRevisionId);
    expect(result.resolution.target.kind).toBe("agent");
    // Agent 解析只携带 Agent target 事实，不含 runtimeRevisionId。
    expect(result.resolution.target).not.toHaveProperty("runtimeRevisionId");
  });

  it("[RED] Agent Route 生产调用事实（endpoint/identity/credential/network）无损贯通", async () => {
    const base = await seedAgentAuthority();
    await addAgentRoute(base, "facts", {
      agentRouteFacts: {
        agentEndpointRef: "https://agent.example.com/a2a",
        agentIdentityMode: "bearer",
        agentCredentialRefId: "cred-1",
        agentNetworkZone: "private",
      },
    });

    const result = await resolveRoute(agentCommand(base, "thread-facts"));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.resolution.target).toMatchObject({
      kind: "agent",
      agentRevisionId: base.agentRevisionId,
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer",
      agentCredentialRefId: "cred-1",
      agentNetworkZone: "private",
    });
    // Agent 证据不含 Runtime 发布/conformance/artifact 事实。
    const evidence = result.resolution.controlPlaneEvidence;
    expect(evidence).not.toHaveProperty("runtimeArtifactId");
    expect(evidence).not.toHaveProperty("runtimePublicationRecordId");
    expect(evidence).not.toHaveProperty("conformanceRunId");
  });

  it("[RED] 未来和已过期 Agent RouteRevision 不参与解析", async () => {
    const base = await seedAgentAuthority();
    await addAgentRoute(base, "future", {
      effectiveFrom: new Date(NOW.getTime() + 1),
    });

    await expect(resolveRoute(agentCommand(base, "thread-window"))).resolves.toEqual({
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 1,
    });
  });

  it("[RED] 从多个 Agent 候选稳定选择同一权重组且不同业务键可命中两个候选", async () => {
    const base = await seedAgentAuthority();
    const first = await addAgentRoute(base, "1", { trafficWeight: 5_000 });
    const second = await addAgentRoute(base, "2", { trafficWeight: 5_000 });

    const seen = new Set<string>();
    for (let index = 0; index < 100 && seen.size < 2; index += 1) {
      const result = await resolveRoute(agentCommand(base, `thread-${index}`));
      if (result.status === "resolved") seen.add(result.resolution.routeRevisionId);
    }
    expect(seen).toEqual(new Set([first.routeRevisionId, second.routeRevisionId]));
  });
});

describe("RouteResolver MySQL authority — Runtime target", () => {
  it("Runtime Route activation 不创建 Agent：runtime resolver 命中 runtime-only 路由", async () => {
    const base = await seedRuntimeAuthority();
    const fixture = await addRuntimeRoute(base, "r", { trafficWeight: 10_000 });

    const result = await resolveRoute(runtimeCommand(base, "thread-rt"));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.resolution.routeRevisionId).toBe(fixture.routeRevisionId);
    expect(result.resolution.target.kind).toBe("runtime");
    // Runtime 解析只携带 runtimeRevisionId，不含 Agent 事实。
    expect(result.resolution.target).toEqual({
      kind: "runtime",
      runtimeRevisionId: fixture.runtimeRevisionId,
    });
  });

  it("Runtime 解析冻结发布、证明、制品和 Conformance 权威证据", async () => {
    const base = await seedRuntimeAuthority();
    const fixture = await addRuntimeRoute(base, "evidence", { trafficWeight: 10_000 });

    const result = await resolveRoute(runtimeCommand(base, "thread-evidence"));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.resolution.routeRevisionId).toBe(fixture.routeRevisionId);
    expect(result.resolution.controlPlaneEvidence).toMatchObject({
      runtimeArtifactId: fixture.runtimeArtifactId,
      runtimeTargetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      runtimeConfigDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      runtimeAttestationIds: [fixture.runtimeAttestationId],
      runtimePublicationRecordId: fixture.runtimePublicationId,
      conformanceRunId: expect.any(String),
    });
    // Runtime 证据不含 Agent 事实。
    expect(result.resolution.controlPlaneEvidence).not.toHaveProperty("agentPublicationRecordId");
  });

  it("未来和已过期 Runtime RouteRevision 不参与解析", async () => {
    const base = await seedRuntimeAuthority();
    await addRuntimeRoute(base, "future", {
      effectiveFrom: new Date(NOW.getTime() + 1),
    });

    await expect(resolveRoute(runtimeCommand(base, "thread-window"))).resolves.toEqual({
      status: "unresolved",
      reason: "no_eligible_route",
      evaluatedCandidateCount: 1,
    });
  });

  it("Runtime 发布撤回或 Attestation 撤销后立即 fail-closed", async () => {
    const base = await seedRuntimeAuthority();
    const fixture = await addRuntimeRoute(base, "revoked", { trafficWeight: 10_000 });

    const before = await resolveRoute(runtimeCommand(base, "thread-before-revoke"));
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
    await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId: base.tenantId,
      routeId: fixture.routeId,
    });
    await expect(resolveRoute(runtimeCommand(base, "thread-after-revoke"))).resolves.toMatchObject({
      status: "unresolved",
      reason: "no_eligible_route",
    });
  });

  it("PublicationRecord 已撤回时不依赖 published 投影继续放行", async () => {
    const base = await seedRuntimeAuthority();
    const fixture = await addRuntimeRoute(base, "withdrawn", { trafficWeight: 10_000 });
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
    await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId: base.tenantId,
      routeId: fixture.routeId,
    });
    await expect(resolveRoute(runtimeCommand(base, "thread-withdrawn"))).resolves.toMatchObject({
      status: "unresolved",
      reason: "no_eligible_route",
    });
  });

  it("Conformance Run 与 Runtime config digest 不匹配时不参与解析", async () => {
    const base = await seedRuntimeAuthority();
    await addRuntimeRoute(base, "mismatch", {
      conformanceConfigDigest: `sha256:${"9".repeat(64)}`,
    });

    await expect(resolveRoute(runtimeCommand(base, "thread-mismatch"))).resolves.toMatchObject({
      status: "unresolved",
      reason: "no_eligible_route",
    });
  });

  it("解析结果冻结激活时的 RouteSet 版本而非后续投影版本", async () => {
    const base = await seedRuntimeAuthority();
    await addRuntimeRoute(base, "frozen-route-set-version", { trafficWeight: 10_000 });
    await db
      .update(deploymentRouteSetTable)
      .set({ versionNo: 2 })
      .where(eq(deploymentRouteSetTable.id, base.routeSetId));

    await expect(
      resolveRoute(runtimeCommand(base, "thread-frozen-version")),
    ).resolves.toMatchObject({
      status: "resolved",
      resolution: { routeSetVersionNo: 1 },
    });
  });

  it("从多个 Runtime 候选稳定选择同一权重组且不同业务键可命中两个候选", async () => {
    const base = await seedRuntimeAuthority();
    const first = await addRuntimeRoute(base, "1", { trafficWeight: 5_000 });
    const second = await addRuntimeRoute(base, "2", { trafficWeight: 5_000 });

    const seen = new Set<string>();
    for (let index = 0; index < 100 && seen.size < 2; index += 1) {
      const result = await resolveRoute(runtimeCommand(base, `thread-${index}`));
      if (result.status === "resolved") seen.add(result.resolution.routeRevisionId);
    }
    expect(seen).toEqual(new Set([first.routeRevisionId, second.routeRevisionId]));
  });
});

describe("RouteResolver MySQL authority — cross-kind / tenant 隔离", () => {
  it("[RED] agent A resolver 不返回 runtime 投影；runtime resolver 不返回 agent 投影", async () => {
    const agent = await seedAgentAuthority();
    await addAgentRoute(agent, "a", { trafficWeight: 10_000 });
    const rt = await seedRuntimeAuthority();
    await addRuntimeRoute(rt, "r", { trafficWeight: 10_000 });

    // Agent A 解析命中自己的 agent-only 路由，绝不命中 runtime 路由。
    const agentResult = await resolveRoute(agentCommand(agent, "thread-cross"));
    expect(agentResult.status).toBe("resolved");
    if (agentResult.status === "resolved") expect(agentResult.resolution.target.kind).toBe("agent");

    // Runtime 解析命中 runtime-only 路由，绝不命中 agent 路由。
    const rtResult = await resolveRoute(runtimeCommand(rt, "thread-cross"));
    expect(rtResult.status).toBe("resolved");
    if (rtResult.status === "resolved") expect(rtResult.resolution.target.kind).toBe("runtime");
  });
});
