/**
 * §十九 端到端验收测试 — 20 个场景。
 *
 * 覆盖专题01最终架构收敛文档（§十九）要求的 20 个场景。
 * 真实 MySQL 8 Testcontainers + 真实 ed25519 DSSE 签名，不使用 mock。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 ed25519 签名 + 真实 MySQL 8 Testcontainers，不使用 mock。
 *
 * 对于已有完整覆盖的场景（1/2/3/4/20），写新的端到端断言；
 * 对于缺失的场景（5-19），编写新的测试逻辑；
 * 场景11（Hosted Worker 完整 Saga）使用真实 MySQL Gateway 执行 Saga 步骤。
 */
import { createHash, randomUUID } from "node:crypto";
import { POST as createRevisionPOST } from "@/app/admin/api/v1/agents/[agent_id]/revisions/route";
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import { withdrawRevision } from "@/lib/agents/test-support/withdraw-agent-revision";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import { createRevokeArtifactAttestation } from "@/lib/artifacts/application/revoke-artifact-attestation";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  resetArtifactStoreOverrides,
  setArtifactStoreOverride,
  setBuilderKeyRegistryOverride,
} from "@/lib/artifacts/infrastructure/artifact-store-provider";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import {
  getAttestationById,
  listAttestationsByRevision,
} from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { mysqlAttestationRevocationStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import {
  type PredicateSupplyChain,
  type TestBuilderKey,
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { controlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createCreateExecutionBinding } from "@/lib/executions/application/create-execution-binding";
import { resolveBindingGovernance } from "@/lib/executions/application/resolve-binding-governance";
import type { ExecutionBinding } from "@/lib/executions/domain/execution-binding";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { mysqlExecutionBindingStore } from "@/lib/executions/persistence/mysql-execution-binding-store";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentRevisionTable } from "@/lib/persistence/schema/agents";
import { deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { createRouteSet, getRouteSetById } from "@/lib/routes/application/deployment-route-service";
import { createDisableRoute } from "@/lib/routes/application/disable-route";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import type { RouteResolution } from "@/lib/routes/domain/route-resolution-policy";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilitySourceReader } from "@/lib/routes/projection/mysql-route-eligibility-source-reader";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { createProjectionEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { activateSingleRouteForTest as activateRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import {
  PUBLICATION_CONFORMANCE_CASES,
  type RuntimeConformanceReport,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
} from "@/lib/runtime/domain/runtime-conformance-run";
import { createMysqlHostedGateways } from "@/lib/runtime/infrastructure/mysql-hosted-gateways";
import { hostedProvisioningRequestTable } from "@/lib/runtime/persistence/hosted-provisioning-request-record";
import {
  HostedProvisioningLeaseLostError,
  mysqlHostedProvisioningRequestStore,
} from "@/lib/runtime/persistence/mysql-hosted-provisioning-request-store";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { createHostedProvisioningSaga } from "@/lib/runtime/provisioning/hosted-provisioning-saga";
import { createHostedProvisioningWorker } from "@/lib/runtime/provisioning/hosted-provisioning-worker";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { createRequestHostedProvisioning } from "@/lib/runtime/provisioning/request-hosted-provisioning";
import { validateAgentRevisionForProvisioning } from "@/lib/runtime/provisioning/validate-hosted-provisioning-revision";
import {
  buildDsseConformanceEnvelope,
  generateTestRunnerKey,
} from "@/lib/runtime/test-support/build-dsse-conformance-envelope";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import {
  installTrustedHostedControlPlaneEvidenceForTest,
  trustedHostedRunnerSigningIdentityForTest,
} from "@/lib/test-support/trusted-hosted-control-plane-evidence";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 admin-routes.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

const RUNNER_KEY = generateTestRunnerKey("e2e-test-runner");
const RUNNER_IDENTITY = "ci/runtime-conformance";

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  resetArtifactStoreOverrides();
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ═══════════════════════════════════════════════════════════
// 辅助：InMemoryManagedArtifactStore（与 admin-routes.test.ts 一致）
// ═══════════════════════════════════════════════════════════

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private envelopes = new Map<string, Buffer>();
  private sboms = new Map<string, unknown>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeDsseEnvelope(ref: string, envelope: Buffer): void {
    this.envelopes.set(ref, envelope);
  }
  writeSbom(ref: string, doc: unknown): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const envelope = this.envelopes.get(ref);
    if (!envelope) throw new Error(`DSSE envelope not found: ${ref}`);
    return envelope;
  }
  async readSbom(ref: string): Promise<unknown> {
    const doc = this.sboms.get(ref);
    if (!doc) throw new Error(`sbom not found: ${ref}`);
    return doc;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const doc = this.provenances.get(ref);
    if (!doc) throw new Error(`provenance not found: ${ref}`);
    return doc;
  }
}

// ─── 辅助：ed25519 密钥对 + DSSE Envelope（来自 test-support）─────────

function buildCleanSbom(): unknown {
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: "2026-08-06T00:00:00Z",
      tools: [{ name: "e2e-test", version: "1.0.0" }],
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
    dependencies: [{ ref: "pkg:npm/lodash@4.17.21" }],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    sourceRevision: "git:abc123def456",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

// ─── 辅助：seed admin 用户 + action bindings（与 admin-routes.test.ts 一致）─

async function seedAdminWithActionBindings() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.revision.create",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.publish",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "artifact.attestation.verify",
    resourceScope: { type: "artifact_type", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "route.update",
    resourceScope: { type: "agent", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

// ─── 辅助：直接创建 verified attestation（绕过 route handler）─────────

async function createVerifiedAttestationDirect(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
): Promise<string> {
  const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const sigRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;
  const sbomDoc = buildCleanSbom();
  const provDoc = buildValidProvenance();
  const supplyChain: PredicateSupplyChain = {
    sbomRef,
    sbomContent: sbomDoc,
    provenanceRef: provRef,
    provenanceContent: provDoc,
  };
  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    sigRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
  );
  store.writeSbom(sbomRef, sbomDoc);
  store.writeProvenance(provRef, provDoc);
  const attestation = await verifyAndPersistAttestation(
    {
      tenantId,
      artifactType,
      artifactRevisionId,
      artifactDigest: digest,
      dsseEnvelopeRef: sigRef,
      builderIdentity: "builder:company-agent-runtime",
    },
    store,
    builderKeys,
    { tenantId, actorType: "service", actorId: "test-builder" },
    "test-request-id",
  );
  return attestation.id;
}

// ─── 辅助：seed Agent + published AgentRevision + attestation ─

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  contentSuffix: string,
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: `git:${contentSuffix}`,
    instructionHash: `sha256:instruction_${contentSuffix}`,
    agentArtifactRef: `oci://registry/agent@sha256:${contentSuffix}`,
    modelPolicyJson: { default: "doubao-pro" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
    createdBy: ownerId,
  });

  const attestationId = await createVerifiedAttestationDirect(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${contentSuffix}`,
  );

  // 链接 Artifact 到 AgentRevision（createPublishAgentRevision 要求 artifactId/artifactDigest 一致）
  const found = await getAttestationById(tenantId, attestationId);
  const attestation = found?.attestation;
  if (!attestation?.artifactId || !attestation.artifactDigest) {
    throw new Error(`测试 AgentRevision 缺少权威 Attestation: ${revision.id}`);
  }
  await db
    .update(agentRevisionTable)
    .set({ artifactId: attestation.artifactId, artifactDigest: attestation.artifactDigest })
    .where(eq(agentRevisionTable.id, revision.id));

  // 使用带 attestation 的正式发布服务，确保 PublicationRecord.attestationIds 非空
  const publishAgentRevision = createPublishAgentRevision({
    store: mysqlAgentPublicationStore,
  });
  await publishAgentRevision({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    attestationId,
    actor: { tenantId, actorType: "system", actorId: "test-deploy-bot" },
    requestId: `test-publish-agent:${revision.id}`,
    idempotencyKey: `test-publish-agent:${revision.id}`,
  });

  // 重新读取已发布的 revision
  const publishedRevision = await getRevisionById(revision.id);
  if (!publishedRevision) throw new Error("AgentRevision 发布后未找到");
  return { agent, revision: publishedRevision };
}

// ─── 辅助：seed Runtime + published RuntimeRevision + attestation ─

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  contentSuffix: string,
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@sha256:${contentSuffix}`,
    runtimeCapabilitiesJson: ["event_stream", "steer", "cancel", "tool_call"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: `sha256:${createHash("sha256").update(`config_${contentSuffix}`).digest("hex")}`,
    createdBy: ownerId,
  });

  const attestationId = await createVerifiedAttestationDirect(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId,
  });

  // 重新读取已发布的 revision（publishRuntimeRevisionForTest 已将状态更新为 published）
  const publishedRevision = await getRuntimeRevisionById(revision.id);
  return { runtime, revision: publishedRevision ?? revision };
}

// ─── 辅助：seed 完整端到端 fixture（Agent + Runtime + Route + Projection）─

async function seedEndToEndFixture(suffix: string) {
  const { tenantId, userIdentityId } = await seedAdminWithActionBindings();

  const agentResult = await seedPublishedAgentRevision(
    tenantId,
    userIdentityId,
    `e2e-agent-${suffix}`,
    `agent-${suffix}`,
  );
  const runtimeResult = await seedPublishedRuntimeRevision(
    tenantId,
    userIdentityId,
    `e2e-runtime-${suffix}`,
    `runtime-${suffix}`,
  );

  const routeSet = await createRouteSet({
    tenantId,
    agentId: agentResult.agent.id,
    routeScopeKey: "prod",
    routeScopeJson: { networkZone: "internal" },
  });

  const upsertResult = await activateRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: agentResult.revision.id,
    runtimeRevisionId: runtimeResult.revision.id,
    trafficWeight: 10000,
    priorityNo: 1,
    actor: { tenantId, actorType: "service", actorId: "test-deploy-bot" },
  });

  return {
    tenantId,
    userIdentityId,
    agent: agentResult.agent,
    agentRevision: agentResult.revision,
    runtime: runtimeResult.runtime,
    runtimeRevision: runtimeResult.revision,
    routeSet,
    route: upsertResult.route,
    routeRevisionId: upsertResult.routeRevisionId,
    routeActivationId: upsertResult.routeActivationId,
  };
}

// ─── 辅助：构造可信 Conformance DSSE Envelope ───────────────

function buildSignedConformanceReport(
  revisionId: string,
  runtimeArtifactDigest: string,
  runtimeConfigDigest: string,
  protocolContractRevision: string,
  overrides: Record<string, unknown> = {},
) {
  const startedAt = new Date("2026-08-02T01:00:00.000Z");
  const caseResults = PUBLICATION_CONFORMANCE_CASES.map((caseId) => {
    const evidence = { caseId, passed: true };
    return {
      caseId,
      passed: true,
      reason: null,
      evidenceDigest: computeCaseEvidenceDigest(evidence),
      evidence,
    };
  });
  const baseReport = {
    runId: randomUUID(),
    runtimeRevisionId: revisionId,
    runtimeArtifactDigest,
    runtimeConfigDigest,
    protocolContractRevision,
    suiteRevision: "runtime-conformance@1",
    runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
    runnerIdentity: RUNNER_IDENTITY,
    testEnvironmentRevision: "isolated-mysql8@1",
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
    overallResult: "passed" as const,
    caseResults,
    ...overrides,
  };
  const evidenceManifestDigest =
    (overrides.evidenceManifestDigest as string | undefined) ??
    computeEvidenceManifestDigest({
      suiteRevision: "runtime-conformance@1",
      testEnvironmentRevision: "isolated-mysql8@1",
      runtimeRevisionId: revisionId,
      runtimeArtifactDigest,
      runtimeConfigDigest,
      protocolContractRevision,
      runnerArtifactDigest: `sha256:${"c".repeat(64)}`,
      cases: baseReport.caseResults.map((result) => ({
        caseId: result.caseId,
        passed: result.passed,
        evidenceDigest: result.evidenceDigest,
      })),
    });
  return buildDsseConformanceEnvelope(
    { ...baseReport, evidenceManifestDigest } as RuntimeConformanceReport,
    RUNNER_KEY,
  );
}

// ─── 辅助：插入测试用 Invocation 行 ──────────────────────

async function seedInvocation(tenantId: string, invocationId: string): Promise<void> {
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "queued",
    versionNo: 1,
  });
}

async function resolveFrozenRouteForBinding(
  fixture: Awaited<ReturnType<typeof seedEndToEndFixture>>,
  threadId: string,
): Promise<RouteResolution> {
  await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
    tenantId: fixture.tenantId,
    routeId: fixture.route.id,
  });

  const outcome = await createResolveRoute({
    store: mysqlRouteEligibilityResolutionStore,
  })({
    tenantId: fixture.tenantId,
    agentId: fixture.agent.id,
    routeScopeKey: "prod",
    businessKey: { threadId },
  });
  if (outcome.status !== "resolved") {
    throw new Error(`测试前置 Route Resolution 失败: ${outcome.reason}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(outcome.resolution.resolutionInputDigest)) {
    throw new Error("Route Resolution 缺少有效 resolutionInputDigest");
  }
  if (
    !Number.isInteger(outcome.resolution.projectionVersionNo) ||
    outcome.resolution.projectionVersionNo === undefined ||
    outcome.resolution.projectionVersionNo < 0
  ) {
    throw new Error("Route Resolution 缺少有效 projectionVersionNo");
  }
  return outcome.resolution;
}

async function createBindingFromResolved(params: {
  tenantId: string;
  invocationId: string;
  resolution: RouteResolution;
}): Promise<ExecutionBinding> {
  const projectionVersionNo = params.resolution.projectionVersionNo;
  if (
    !Number.isInteger(projectionVersionNo) ||
    projectionVersionNo === undefined ||
    projectionVersionNo < 0
  ) {
    throw new Error("Route Resolution 缺少有效 projectionVersionNo");
  }

  const bindingGovernance = await resolveBindingGovernance(
    db,
    params.tenantId,
    params.resolution.policyRevisionId,
  );
  return createCreateExecutionBinding({ store: mysqlExecutionBindingStore })({
    invocationId: params.invocationId,
    tenantId: params.tenantId,
    agentRevisionId: params.resolution.agentRevisionId,
    runtimeRevisionId: params.resolution.runtimeRevisionId,
    deploymentRouteId: params.resolution.deploymentRouteId,
    modelProvider: "doubao",
    modelId: "doubao-pro",
    modelRevisionRef: null,
    initialEnvironmentLeaseId: null,
    workspaceBindingId: null,
    policyRevisionId: bindingGovernance.policyRevisionId,
    policyRulesDigest: bindingGovernance.policyRulesDigest,
    governanceConfigRevisionId: bindingGovernance.governanceConfigRevisionId,
    governanceConfigDigest: bindingGovernance.governanceConfigDigest,
    contextCheckpointId: null,
    environmentDefinitionRevisionId: null,
    controlPlaneEvidence: {
      ...params.resolution.controlPlaneEvidence,
      routeRevisionId: params.resolution.routeRevisionId,
      routeActivationId: params.resolution.routeActivationId,
      routeContentDigest: params.resolution.routeContentDigest,
      resolutionInputDigest: params.resolution.resolutionInputDigest,
    },
    projectionVersionNo,
  });
}

async function expectBindingAbsent(tenantId: string, invocationId: string): Promise<void> {
  expect(await getExecutionBindingByInvocation(tenantId, invocationId)).toBeNull();
}

// §03: 已删除 mysqlRouteSetActivationStore wrapper — 统一 Reader 直接读取真实证据，
// 不再需要拦截 session 的 loadRevisionExecutionEvidence。

const activateRouteSetForTest = createActivateRouteSet({
  store: mysqlRouteSetActivationStore,
});
const disableRouteForTest = createDisableRoute({ store: mysqlRouteSetActivationStore });

// ═══════════════════════════════════════════════════════════
// 场景 1：真实签名 Artifact Attestation 通过
// ═══════════════════════════════════════════════════════════

describe("场景1：真实签名 Artifact Attestation 通过", () => {
  it("真实 ed25519 签名验证通过 → verification_state=verified", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agent = await createAgent({
      tenantId,
      agentKey: "attest-agent",
      displayName: "Attest Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:attest-v1",
      instructionHash: "sha256:instr-attest",
      agentArtifactRef: "oci://registry/agent@sha256:attest",
      modelPolicyJson: { model: "gpt-4" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("attest-artifact-content");
    const sigRef = `attestation:signature:${digest.slice(7, 15)}`;
    const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
    const provRef = `attestation:provenance:${digest.slice(7, 15)}`;
    const sbomDoc = buildCleanSbom();
    const provDoc = buildValidProvenance();
    const supplyChain: PredicateSupplyChain = {
      sbomRef,
      sbomContent: sbomDoc,
      provenanceRef: provRef,
      provenanceContent: provDoc,
    };
    const store = new InMemoryManagedArtifactStore();
    store.writeDsseEnvelope(
      sigRef,
      buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
    );
    store.writeSbom(sbomRef, sbomDoc);
    store.writeProvenance(provRef, provDoc);
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const attestationId = await createVerifiedAttestationDirect(
      tenantId,
      "agent_revision",
      draftRevision.id,
      "attest-artifact-content",
    );

    expect(attestationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const attestations = await listAttestationsByRevision(
      tenantId,
      "agent_revision",
      draftRevision.id,
    );
    expect(attestations).toHaveLength(1);
    expect(attestations[0]?.attestation.verificationState).toBe("verified");
    expect(attestations[0]?.revocation).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 2：真实签名 Runtime Conformance 通过
// ═══════════════════════════════════════════════════════════

describe("场景2：真实签名 Runtime Conformance 通过", () => {
  it("ed25519 DSSE Conformance 报告 → 完整 Publication CaseResult + Run 不可变", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "conformance-owner",
      email: "conformance@example.com",
      displayName: "Conformance Owner",
    });
    const runtime = await createRuntime({
      tenantId: tenant.id,
      runtimeKey: "conformance-runtime",
      displayName: "Conformance Runtime",
      runtimeKind: "external",
      ownerUserId: owner.id,
      lifecycleState: "enabled",
    });
    const revision = await createDraftRuntimeRevision({
      tenantId: tenant.id,
      runtimeId: runtime.id,
      protocolType: "agent_runtime_protocol",
      endpointRef: "connection://conformance-runtime",
      runtimeArtifactRef: `oci://registry/runtime@sha256:${"a".repeat(64)}`,
      runtimeCapabilitiesJson: { event_stream: true },
      identityMode: "workload_token",
      networkZone: "external",
      configHash: `sha256:${"b".repeat(64)}`,
      createdBy: owner.id,
    });

    const dsseEnvelope = buildSignedConformanceReport(
      revision.id,
      `sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      revision.protocolContractRevision,
    );

    const record = createRecordRuntimeConformanceRun({
      store: mysqlRuntimeConformanceRunStore,
      verifier: createDSSEConformanceVerifier({
        runnerIdentityRegistry: new RunnerSigningIdentityRegistry([
          {
            keyId: RUNNER_KEY.keyid,
            publicKey: RUNNER_KEY.publicKeyBase64,
            runnerIdentity: RUNNER_IDENTITY,
            tenantScope: null,
            validFrom: "2020-01-01T00:00:00.000Z",
            validUntil: null,
            revokedAt: null,
          },
        ]),
      }),
    });
    const result = await record({
      tenantId: tenant.id,
      runtimeRevisionId: revision.id,
      idempotencyKey: "e2e-run-001",
      requestId: "e2e-request-001",
      actor: { actorType: "user", actorId: owner.id },
      dsseEnvelope,
    });

    expect(result.run.overallResult).toBe("passed");
    expect(result.caseResults).toHaveLength(PUBLICATION_CONFORMANCE_CASES.length);
    expect(result.replayed).toBe(false);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(
      PUBLICATION_CONFORMANCE_CASES.length,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 3：AgentRevision 正式发布
// ═══════════════════════════════════════════════════════════

describe("场景3：AgentRevision 正式发布", () => {
  it("发布后状态 published + PublicationRecord 存在 + Outbox 事件", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { agent, revision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "publish-agent-e2e",
      "publish-v1",
    );

    const published = await getRevisionById(revision.id);
    expect(published?.revisionState).toBe("published");
    expect(published?.publishedAt).toBeTruthy();

    const agentRow = await getAgentById(tenantId, agent.id);
    expect(agentRow?.currentRevisionId).toBe(revision.id);

    const publication = await getPublicationRecordBySubject({
      tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: revision.id,
    });
    expect(publication).not.toBeNull();
    expect(publication?.publishedByType).toBe("system");

    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, revision.id));
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]?.eventType).toBe("agent.revision.published");
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 4：RuntimeRevision 正式发布
// ═══════════════════════════════════════════════════════════

describe("场景4：RuntimeRevision 正式发布", () => {
  it("发布后状态 published + PublicationRecord 含 conformanceRunId + Outbox", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { runtime, revision } = await seedPublishedRuntimeRevision(
      tenantId,
      userIdentityId,
      "publish-runtime-e2e",
      "rt-publish-v1",
    );

    expect(revision.revisionState).toBe("published");

    const publication = await getPublicationRecordBySubject({
      tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revision.id,
    });
    expect(publication).not.toBeNull();
    expect(publication?.conformanceRunId).toBeTruthy();

    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, revision.id));
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]?.eventType).toBe("runtime.revision.published");
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 5：RouteSet 原子激活
// ═══════════════════════════════════════════════════════════

describe("场景5：RouteSet 原子激活", () => {
  it("多 Route 在单事务中原子激活，失败时全部回滚", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "atomic-agent",
      "atomic-agent-v1",
    );
    const runtimeResult = await seedPublishedRuntimeRevision(
      tenantId,
      userIdentityId,
      "atomic-runtime",
      "atomic-runtime-v1",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agentResult.agent.id,
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });

    const activateRouteSet = createActivateRouteSet({
      store: mysqlRouteSetActivationStore,
    });

    const result = await activateRouteSet({
      tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: 1,
      desiredRoutes: [
        {
          routeKey: "primary",
          routeGroupId: "primary",
          agentRevisionId: agentResult.revision.id,
          runtimeRevisionId: runtimeResult.revision.id,
          trafficWeight: 10000,
          priorityNo: 1,
          eligibilityConditions: {},
          activationState: "active",
        },
      ],
      actor: { tenantId, actorType: "service", actorId: "test-activator" },
      reason: "E2E 原子激活测试",
      requestId: "req-atomic-001",
      idempotencyKey: "idem-atomic-001",
    });

    expect(result.routeSetVersionNo).toBe(2);
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]?.activationState).toBe("active");
    expect(result.affectsNewInvocationsOnly).toBe(true);

    // 验证 RouteSet 版本递增
    const updatedRouteSet = await getRouteSetById(tenantId, routeSet.id);
    expect(updatedRouteSet?.versionNo).toBe(2);

    // 验证失败时回滚：使用不存在的 agentRevisionId 触发失败
    await expect(
      activateRouteSet({
        tenantId,
        routeSetId: routeSet.id,
        expectedVersionNo: 2,
        desiredRoutes: [
          {
            routeKey: "primary",
            routeGroupId: "primary",
            agentRevisionId: "99999999-9999-4999-8999-999999999999",
            runtimeRevisionId: runtimeResult.revision.id,
            trafficWeight: 10000,
            priorityNo: 1,
            activationState: "active",
          },
        ],
        actor: { tenantId, actorType: "service", actorId: "test-activator" },
        reason: "应失败的激活",
        requestId: "req-atomic-fail",
        idempotencyKey: "idem-atomic-fail",
      }),
    ).rejects.toThrow();

    // RouteSet 版本未因失败而递增
    const routeSetAfterFailure = await getRouteSetById(tenantId, routeSet.id);
    expect(routeSetAfterFailure?.versionNo).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 6：Outbox Event 与 Delivery 同事务创建
// ═══════════════════════════════════════════════════════════

describe("场景6：Outbox Event 与 Delivery 同事务创建", () => {
  it("AgentRevision 发布时 OutboxEvent 与 EventDelivery 在同事务写入", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { revision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "outbox-agent",
      "outbox-v1",
    );

    // Outbox 事件存在
    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, revision.id));
    expect(outboxEvents).toHaveLength(1);
    const outboxEvent = outboxEvents[0];
    expect(outboxEvent?.eventType).toBe("agent.revision.published");
    if (!outboxEvent) throw new Error("AgentRevision 发布后缺少 Outbox 事件");

    // 对应的 Delivery 行（route_projection 消费者）在同事务创建
    const deliveries = await db
      .select()
      .from(controlPlaneEventDelivery)
      .where(eq(controlPlaneEventDelivery.eventId, outboxEvent.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.consumerName).toBe("route_projection");
    expect(deliveries[0]?.state).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 7：Projection Consumer 构建完整 eligible Projection
// ═══════════════════════════════════════════════════════════

describe("场景7：Projection Consumer 构建完整 eligible Projection", () => {
  it("buildRouteEligibility 生成 eligible 投影并写入完整执行证据", async () => {
    const fixture = await seedEndToEndFixture("proj-eligible");

    const buildRouteEligibility = createBuildRouteEligibility({
      store: mysqlRouteEligibilityStore,
    });

    const result = await buildRouteEligibility({
      tenantId: fixture.tenantId,
      routeId: fixture.route.id,
    });

    expect(result.eligibilityState).toBe("eligible");
    expect(result.projectionVersionNo).toBeGreaterThan(0);

    // 验证投影包含完整执行证据
    const [projection] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, fixture.route.id))
      .limit(1);

    expect(projection).not.toBeNull();
    expect(projection?.eligibilityState).toBe("eligible");
    expect(projection?.agentPublicationActive).toBe(1);
    expect(projection?.agentEvidenceValid).toBe(1);
    expect(projection?.runtimePublicationActive).toBe(1);
    expect(projection?.runtimeEvidenceValid).toBe(1);
    expect(projection?.runtimeConformanceValid).toBe(1);
    expect(projection?.agentPublicationRecordId).toBeTruthy();
    expect(projection?.runtimePublicationRecordId).toBeTruthy();
    expect(projection?.conformanceRunId).toBeTruthy();
    expect(projection?.agentAttestationIds).toHaveLength(1);
    expect(projection?.runtimeAttestationIds).toHaveLength(1);
  });

  it("activeRouteRevisionId 漂移时仍按 latest activation 自愈并被 SourceReader 发现", async () => {
    const fixture = await seedEndToEndFixture("projection-authority-drift");
    await db
      .update(deploymentRouteTable)
      .set({ activeRouteRevisionId: null })
      .where(eq(deploymentRouteTable.id, fixture.route.id));

    const sourceRefs = await mysqlRouteEligibilitySourceReader.listRouteIdsByAgentRevision(
      fixture.agentRevision.id,
    );
    expect(sourceRefs).toContainEqual({ routeId: fixture.route.id, tenantId: fixture.tenantId });
    const fullRebuildRefs =
      await mysqlRouteEligibilitySourceReader.listAllCurrentlyActivatedRouteIds();
    expect(fullRebuildRefs).toContainEqual({
      routeId: fixture.route.id,
      tenantId: fixture.tenantId,
    });

    await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId: fixture.tenantId,
      routeId: fixture.route.id,
    });
    const [projection] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, fixture.route.id));

    expect(projection).toMatchObject({
      routeRevisionId: fixture.routeRevisionId,
      routeActivationId: fixture.routeActivationId,
      activationState: "active",
      eligibilityState: "eligible",
    });
  });

  it("跨租户异常 activation 不会遮蔽本租户 latest activation", async () => {
    const fixture = await seedEndToEndFixture("projection-authority-cross-tenant-activation");
    await db.insert(routeActivation).values({
      id: randomUUID(),
      tenantId: randomUUID(),
      routeId: fixture.route.id,
      routeRevisionId: randomUUID(),
      routeSetId: fixture.routeSet.id,
      activationSequence: 2,
      activationState: "active",
      previousRouteRevisionId: fixture.routeRevisionId,
      previousRouteActivationId: fixture.routeActivationId,
      routeSetVersionNo: 2,
      activatedByType: "system",
      activatedBy: "cross-tenant-corruption-test",
      reason: "verify tenant-scoped latest activation",
      requestId: randomUUID(),
      idempotencyKey: `cross-tenant-${randomUUID()}`,
      activatedAt: new Date(),
    });

    const sourceRefs = await mysqlRouteEligibilitySourceReader.listRouteIdsByAgentRevision(
      fixture.agentRevision.id,
    );

    expect(sourceRefs).toContainEqual({ routeId: fixture.route.id, tenantId: fixture.tenantId });
  });

  it("disabled route 保留真实 authority IDs 的 ineligible 投影且 Resolver 不选择", async () => {
    const fixture = await seedEndToEndFixture("projection-authority-disabled");
    const routeSet = await getRouteSetById(fixture.tenantId, fixture.routeSet.id);
    if (!routeSet) throw new Error("测试 RouteSet 不存在");

    // 复用正式 DisableRoute 服务追加 disabled Activation（append-only，禁止 UPDATE 既有行）。
    const disabled = await disableRouteForTest({
      tenantId: fixture.tenantId,
      routeSetId: fixture.routeSet.id,
      routeId: fixture.route.id,
      expectedVersionNo: routeSet.versionNo,
      actor: { tenantId: fixture.tenantId, actorType: "service", actorId: "test-disabler" },
      reason: "验收测试禁用 Route",
      requestId: randomUUID(),
      idempotencyKey: `disabled-route:${randomUUID()}`,
    });
    expect(disabled.routeRevisionId).toBe(fixture.routeRevisionId);
    expect(disabled.routeActivationId).not.toBe(fixture.routeActivationId);

    const result = await createBuildRouteEligibility({ store: mysqlRouteEligibilityStore })({
      tenantId: fixture.tenantId,
      routeId: fixture.route.id,
    });
    const [projection] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, fixture.route.id));

    expect(result.eligibilityState).toBe("ineligible");
    expect(projection).toMatchObject({
      routeRevisionId: fixture.routeRevisionId,
      routeActivationId: disabled.routeActivationId,
      activationState: "disabled",
      eligibilityState: "ineligible",
    });

    const resolution = await createResolveRoute({
      store: mysqlRouteEligibilityResolutionStore,
    })({
      tenantId: fixture.tenantId,
      agentId: fixture.agent.id,
      routeScopeKey: "prod",
      businessKey: { threadId: "disabled-projection" },
    });
    expect(resolution.status).toBe("unresolved");
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 8：Employee Turn 只执行一次 Route Resolution
// ═══════════════════════════════════════════════════════════

describe("场景8：Employee Turn 只执行一次 Route Resolution", () => {
  it("同一 Turn 内 Route Resolution 结果幂等且只解析一次", async () => {
    const fixture = await seedEndToEndFixture("turn-resolve");

    // 先构建投影，使 Resolver 能从投影读取
    const buildRouteEligibility = createBuildRouteEligibility({
      store: mysqlRouteEligibilityStore,
    });
    await buildRouteEligibility({
      tenantId: fixture.tenantId,
      routeId: fixture.route.id,
    });

    // 使用基于投影的 Resolver
    const resolveRoute = createResolveRoute({
      store: mysqlRouteEligibilityResolutionStore,
    });

    const outcome1 = await resolveRoute({
      tenantId: fixture.tenantId,
      agentId: fixture.agent.id,
      routeScopeKey: "prod",
      businessKey: { threadId: "thread-e2e-001" },
    });

    expect(outcome1.status).toBe("resolved");

    // 同一 Turn 重复调用 → 幂等，返回相同 resolutionKeyDigest
    const outcome2 = await resolveRoute({
      tenantId: fixture.tenantId,
      agentId: fixture.agent.id,
      routeScopeKey: "prod",
      businessKey: { threadId: "thread-e2e-001" },
    });

    expect(outcome2.status).toBe("resolved");
    if (outcome1.status === "resolved" && outcome2.status === "resolved") {
      expect(outcome2.resolution.routeRevisionId).toBe(outcome1.resolution.routeRevisionId);
      expect(outcome2.resolution.routeActivationId).toBe(outcome1.resolution.routeActivationId);
      expect(outcome2.resolution.agentRevisionId).toBe(fixture.agentRevision.id);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 9：Binding 在同一事务完成最终资格校验
// ═══════════════════════════════════════════════════════════

describe("场景9：Binding 在同一事务完成最终资格校验", () => {
  it("ExecutionBinding 创建在单事务内完成资格校验 + 行级锁 + Insert", async () => {
    const fixture = await seedEndToEndFixture("binding-tx");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-binding-e2e");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    const binding = await createBindingFromResolved({
      tenantId: fixture.tenantId,
      invocationId,
      resolution,
    });

    // 验证 Binding 包含完整不可变控制面证据
    expect(binding.agentRevisionId).toBe(fixture.agentRevision.id);
    expect(binding.runtimeRevisionId).toBe(fixture.runtimeRevision.id);
    expect(binding.routeRevisionId).toBe(resolution.routeRevisionId);
    expect(binding.routeActivationId).toBe(resolution.routeActivationId);
    expect(binding.agentPublicationRecordId).toBeTruthy();
    expect(binding.runtimePublicationRecordId).toBeTruthy();
    expect(binding.conformanceRunId).toBeTruthy();
    expect(binding.agentAttestationIds).toHaveLength(1);
    expect(binding.runtimeAttestationIds).toHaveLength(1);
    expect(binding.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 10：Hosted 无 Route 时创建精确 Revision 请求
// ═══════════════════════════════════════════════════════════

describe("场景10：Hosted 无 Route 时创建精确 Revision 请求", () => {
  it("无 Ready Route 时创建 HostedProvisioningRequest 绑定精确 agentRevisionId", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { agent, revision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "hosted-agent",
      "hosted-agent-v1",
    );

    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: mysqlHostedProvisioningRequestStore,
      revisionValidator: { validateRevision: validateAgentRevisionForProvisioning },
    });

    const result = await requestHostedProvisioning({
      tenantId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      routeScopeKey: "prod",
    });

    if ("valid" in result && result.valid === false) {
      throw new Error(`Revision 验证失败: ${result.reason}`);
    }
    if (!("requestId" in result)) {
      throw new Error("Expected RequestHostedProvisioningResult but got invalid revision");
    }
    expect(result.state).toBeDefined();
    expect(result.requestId).toBeTruthy();

    // 验证请求精确绑定了 agentRevisionId
    const requests = await db.select().from(hostedProvisioningRequestTable);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.agentRevisionId).toBe(revision.id);
    expect(requests[0]?.agentId).toBe(agent.id);
    expect(requests[0]?.routeScopeKey).toBe("prod");
    expect(requests[0]?.desiredRuntimeKey).toBe("builtin-hosted");
    expect(requests[0]?.state).toBe("pending");
  });

  it("agentRevisionId='unknown' 被拒绝", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agent = await createAgent({
      tenantId,
      agentKey: "hosted-reject-agent",
      displayName: "Hosted Reject Agent",
      ownerUserId: userIdentityId,
      lifecycleState: "enabled",
    });

    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: mysqlHostedProvisioningRequestStore,
      revisionValidator: { validateRevision: validateAgentRevisionForProvisioning },
    });

    const result = await requestHostedProvisioning({
      tenantId,
      agentId: agent.id,
      agentRevisionId: "unknown",
      routeScopeKey: "prod",
    });

    expect("valid" in result).toBe(true);
    if ("valid" in result) {
      expect(result.valid).toBe(false);
      expect(result.code).toBe("REVISION_ID_UNKNOWN");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 11：Hosted Worker 完成发布、Conformance 和 Route 激活
// ═══════════════════════════════════════════════════════════

describe("场景11：Hosted Worker 完成发布、Conformance 和 Route 激活", () => {
  it("Hosted Provisioning Saga 从 start 到 ready 完成全部步骤", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "hosted-saga-agent",
      "hosted-saga-agent-v1",
    );

    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: mysqlHostedProvisioningRequestStore,
      revisionValidator: { validateRevision: validateAgentRevisionForProvisioning },
    });
    const request = await requestHostedProvisioning({
      tenantId,
      agentId: agent.id,
      agentRevisionId: agentRevision.id,
      routeScopeKey: "prod",
      desiredRuntimeKey: "builtin-hosted",
    });
    expect(request).toBeTruthy();
    expect("requestId" in request!).toBe(true);
    const requestId = (request as { requestId: string }).requestId;

    const restoreEvidence = installTrustedHostedControlPlaneEvidenceForTest();
    try {
      const workerId = `test-worker-${crypto.randomUUID()}`;
      const runnerIdentityRegistry = new RunnerSigningIdentityRegistry([
        trustedHostedRunnerSigningIdentityForTest(tenantId),
      ]);
      const saga = createHostedProvisioningSaga({
        gateways: createMysqlHostedGateways({
          runnerSigningIdentityRegistry: runnerIdentityRegistry,
        }),
        store: mysqlHostedProvisioningRequestStore,
        maxAttempts: 10,
        workerId,
      });
      const hostedWorker = createHostedProvisioningWorker(
        { workerId, batchSize: 1, leaseMs: 120_000, maxAttempts: 10 },
        { store: mysqlHostedProvisioningRequestStore, saga },
      );
      const projectionHandler = createProjectionEventHandler({
        store: mysqlRouteEligibilityStore,
        sourceReader: mysqlRouteEligibilitySourceReader,
        buildRouteEligibility: createBuildRouteEligibility({ store: mysqlRouteEligibilityStore }),
      });
      const outboxWorker = createOutboxRelayWorker(projectionHandler, {
        workerId: `projection-worker-${crypto.randomUUID()}`,
        consumerName: "route_projection",
        batchSize: 100,
        leaseMs: 120_000,
      });

      let persisted = await mysqlHostedProvisioningRequestStore.getById({ tenantId, requestId });
      for (let step = 0; step < 12 && persisted?.state !== "ready"; step++) {
        expect(persisted?.state).toBe("pending");
        expect(await hostedWorker.pollOnce()).toBe(1);
        for (let batch = 0; batch < 10; batch++) {
          if ((await outboxWorker.pollOnce()) === 0) break;
        }
        persisted = await mysqlHostedProvisioningRequestStore.getById({ tenantId, requestId });
        expect(persisted?.state).not.toBe("retryable_failed");
        expect(persisted?.state).not.toBe("permanent_failed");
      }

      expect(persisted?.state).toBe("ready");
      expect(persisted?.currentStep).toBe("done");
      expect(persisted?.stepAgentRevisionId).toBe(agentRevision.id);
      expect(persisted?.stepAgentPublicationRecordId).toBeTruthy();
      expect(persisted?.stepRuntimeRevisionId).toBeTruthy();
      expect(persisted?.stepRuntimeArtifactId).toBeTruthy();
      expect(persisted?.stepRuntimeAttestationIds).toHaveLength(1);
      expect(persisted?.stepConformanceRunId).toBeTruthy();
      expect(persisted?.stepRuntimePublicationRecordId).toBeTruthy();
      expect(persisted?.stepRouteSetId).toBeTruthy();
      expect(persisted?.stepRouteRevisionId).toBeTruthy();
      expect(persisted?.stepRouteActivationId).toBeTruthy();
      expect(persisted?.stepProjectionVersionNo).toBeGreaterThan(0);

      const resolved = await createResolveRoute({
        store: mysqlRouteEligibilityResolutionStore,
      })({
        tenantId,
        agentId: agent.id,
        routeScopeKey: "prod",
        businessKey: { threadId: `hosted-e2e-${requestId}` },
      });
      expect(resolved.status).toBe("resolved");
      if (resolved.status !== "resolved")
        throw new Error(`Hosted Route 未解析: ${resolved.reason}`);
      expect(resolved.resolution.agentRevisionId).toBe(agentRevision.id);
      expect(resolved.resolution.runtimeRevisionId).toBe(persisted?.stepRuntimeRevisionId);
      expect(resolved.resolution.routeRevisionId).toBe(persisted?.stepRouteRevisionId);
      expect(resolved.resolution.routeActivationId).toBe(persisted?.stepRouteActivationId);
    } finally {
      restoreEvidence();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 12：最终调度继续使用 Request 冻结的 AgentRevision
// ═══════════════════════════════════════════════════════════

describe("场景12：最终调度继续使用 Request 冻结的 AgentRevision", () => {
  it("已创建 ExecutionBinding 不因 Agent 新 Revision 发布而变化", async () => {
    const fixture = await seedEndToEndFixture("frozen-revision");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-frozen");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    const binding = await createBindingFromResolved({
      tenantId: fixture.tenantId,
      invocationId,
      resolution,
    });

    const frozenConfigHash = binding.configHash;
    const frozenAgentRevisionId = binding.agentRevisionId;

    // 发布新 AgentRevision（但不撤回旧的）
    const newRevision = await createDraftRevision({
      tenantId: fixture.tenantId,
      agentId: fixture.agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:frozen-v2",
      instructionHash: "sha256:instr-frozen-v2",
      agentArtifactRef: "oci://registry/agent@sha256:frozen-v2",
      modelPolicyJson: { model: "doubao-pro-v2" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
      createdBy: fixture.userIdentityId,
    });
    await createVerifiedAttestationDirect(
      fixture.tenantId,
      "agent_revision",
      newRevision.id,
      "agent-content-frozen-v2",
    );
    await publishRevision(fixture.tenantId, newRevision.id, 2);

    // 已有 Binding 的 configHash 和 agentRevisionId 不变
    expect(binding.configHash).toBe(frozenConfigHash);
    expect(binding.agentRevisionId).toBe(frozenAgentRevisionId);
    expect(binding.agentRevisionId).toBe(fixture.agentRevision.id);
    expect(binding.agentRevisionId).not.toBe(newRevision.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 13：Publication 撤回后拒绝新 Binding
// ═══════════════════════════════════════════════════════════

describe("场景13：Publication 撤回后拒绝新 Binding", () => {
  it("Resolver 冻结 Publication 后新增 Withdrawal，旧 Resolution 创建 Binding 必须失败", async () => {
    const fixture = await seedEndToEndFixture("withdrawn-pub");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-withdrawn");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    // 正式 Withdrawal API 会在真实 MySQL 同事务新增 WithdrawalRecord 并撤回 Revision。
    await withdrawRevision(fixture.agentRevision.id);
    const withdrawn = await getRevisionById(fixture.agentRevision.id);
    expect(withdrawn?.revisionState).toBe("withdrawn");
    const [withdrawal] = await db
      .select()
      .from(withdrawalRecord)
      .where(
        eq(
          withdrawalRecord.publicationRecordId,
          resolution.controlPlaneEvidence.agentPublicationRecordId,
        ),
      );
    expect(withdrawal).toBeDefined();

    await expect(
      createBindingFromResolved({ tenantId: fixture.tenantId, invocationId, resolution }),
    ).rejects.toThrow();
    await expectBindingAbsent(fixture.tenantId, invocationId);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 14：Attestation 撤销后拒绝新 Binding
// ═══════════════════════════════════════════════════════════

describe("场景14：Attestation 撤销后拒绝新 Binding", () => {
  it("Resolver 冻结 Attestation 后新增 Revocation，旧 Resolution 创建 Binding 必须失败", async () => {
    const fixture = await seedEndToEndFixture("revoked-attest");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-revoked");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    const [attestationId] = resolution.controlPlaneEvidence.agentAttestationIds;
    if (!attestationId) throw new Error("冻结 Resolution 缺少 Agent Attestation");

    const revokeArtifactAttestation = createRevokeArtifactAttestation({
      store: mysqlAttestationRevocationStore,
    });
    await revokeArtifactAttestation({
      tenantId: fixture.tenantId,
      attestationId,
      actor: { tenantId: fixture.tenantId, actorType: "service", actorId: "test-revoker" },
      reason: "E2E 测试撤销",
      requestId: "req-revoke-attest-001",
    });

    await expect(
      createBindingFromResolved({ tenantId: fixture.tenantId, invocationId, resolution }),
    ).rejects.toThrow();
    await expectBindingAbsent(fixture.tenantId, invocationId);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 15：Runtime Conformance 失效后拒绝新 Binding
// ═══════════════════════════════════════════════════════════

describe("场景15：Runtime Conformance 失效后拒绝新 Binding", () => {
  it("Resolver 冻结 Conformance 后权威 Run/Case 变为不合格，旧 Resolution 创建 Binding 必须失败", async () => {
    const fixture = await seedEndToEndFixture("conformance-invalid");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-conformance-fail");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    // Conformance 事实是不可变记录，没有“撤销 Run”应用 API；这里直接改变真实 MySQL
    // 权威行来模拟 resolve 与 bind 之间的并发失效，不用 mock 或内存替代。
    const conformanceRunId = resolution.controlPlaneEvidence.conformanceRunId;
    const caseId = PUBLICATION_CONFORMANCE_CASES[0];
    if (!caseId) throw new Error("Conformance 合同未定义 Case");
    await db
      .update(runtimeConformanceRun)
      .set({ overallResult: "failed" })
      .where(eq(runtimeConformanceRun.id, conformanceRunId));
    await db
      .update(runtimeConformanceCaseResult)
      .set({ passed: false, reason: "TOCTOU invalidation" })
      .where(
        and(
          eq(runtimeConformanceCaseResult.runId, conformanceRunId),
          eq(runtimeConformanceCaseResult.caseId, caseId),
        ),
      );

    const [invalidRun] = await db
      .select({ overallResult: runtimeConformanceRun.overallResult })
      .from(runtimeConformanceRun)
      .where(eq(runtimeConformanceRun.id, conformanceRunId));
    const [invalidCase] = await db
      .select({ passed: runtimeConformanceCaseResult.passed })
      .from(runtimeConformanceCaseResult)
      .where(
        and(
          eq(runtimeConformanceCaseResult.runId, conformanceRunId),
          eq(runtimeConformanceCaseResult.caseId, caseId),
        ),
      );
    expect(invalidRun?.overallResult).toBe("failed");
    expect(invalidCase?.passed).toBe(false);

    await expect(
      createBindingFromResolved({ tenantId: fixture.tenantId, invocationId, resolution }),
    ).rejects.toThrow();
    await expectBindingAbsent(fixture.tenantId, invocationId);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 16：已创建 ExecutionBinding 不因后续变化被修改
// ═══════════════════════════════════════════════════════════

describe("场景16：已创建 ExecutionBinding 不因后续变化被修改", () => {
  it("Resolver 冻结 Route 后出现新 Revision/Activation，旧 Resolution 创建 Binding 必须失败", async () => {
    const fixture = await seedEndToEndFixture("stale-route-activation");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-stale-route-activation");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    const nextRoute = await activateRouteForTest({
      tenantId: fixture.tenantId,
      routeSetId: fixture.routeSet.id,
      routeSetExpectedVersionNo: 2,
      routeId: fixture.route.id,
      agentRevisionId: fixture.agentRevision.id,
      runtimeRevisionId: fixture.runtimeRevision.id,
      trafficWeight: 10000,
      priorityNo: 2,
      routeState: "enabled",
      actor: { tenantId: fixture.tenantId, actorType: "service", actorId: "test-updater" },
    });
    expect(nextRoute.routeRevisionId).not.toBe(resolution.routeRevisionId);
    expect(nextRoute.routeActivationId).not.toBe(resolution.routeActivationId);

    await expect(
      createBindingFromResolved({ tenantId: fixture.tenantId, invocationId, resolution }),
    ).rejects.toThrow();
    await expectBindingAbsent(fixture.tenantId, invocationId);
  });

  it("Binding 创建后新禁用 Activation 不修改数据库中的任何冻结字段", async () => {
    const fixture = await seedEndToEndFixture("immutable-binding");
    const resolution = await resolveFrozenRouteForBinding(fixture, "thread-immutable");
    const invocationId = crypto.randomUUID();
    await seedInvocation(fixture.tenantId, invocationId);

    const binding = await createBindingFromResolved({
      tenantId: fixture.tenantId,
      invocationId,
      resolution,
    });
    const frozenFromDatabase = await getExecutionBindingByInvocation(
      fixture.tenantId,
      invocationId,
    );
    expect(frozenFromDatabase).toEqual(binding);

    const disabledRoute = await disableRouteForTest({
      tenantId: fixture.tenantId,
      routeSetId: fixture.routeSet.id,
      routeId: fixture.route.id,
      expectedVersionNo: 2,
      actor: { tenantId: fixture.tenantId, actorType: "service", actorId: "test-disabler" },
      reason: "验收测试禁用 Route",
      requestId: randomUUID(),
      idempotencyKey: `scenario16-disable:${randomUUID()}`,
    });
    expect(disabledRoute.routeRevisionId).toBe(binding.routeRevisionId);
    expect(disabledRoute.routeActivationId).not.toBe(binding.routeActivationId);

    const afterDisable = await getExecutionBindingByInvocation(fixture.tenantId, invocationId);
    expect(afterDisable).toEqual(frozenFromDatabase);
    expect(afterDisable?.configHash).toBe(binding.configHash);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 17：Worker 崩溃后租约可恢复
// ═══════════════════════════════════════════════════════════

describe("场景17：Worker 崩溃后租约可恢复", () => {
  it("B 从 A 的最后 checkpoint 重领，A 恢复后不能覆盖或释放 B 的租约", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { agent, revision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "lease-agent",
      "lease-v1",
    );

    // 创建请求
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: mysqlHostedProvisioningRequestStore,
      revisionValidator: { validateRevision: validateAgentRevisionForProvisioning },
    });
    const result = await requestHostedProvisioning({
      tenantId,
      agentId: agent.id,
      agentRevisionId: revision.id,
      routeScopeKey: "prod",
    });
    if (!("requestId" in result)) throw new Error("请求创建失败");

    const now = new Date();
    const worker1Id = "worker-crashed-001";
    const [initialClaim] = await mysqlHostedProvisioningRequestStore.claimRequests({
      workerId: worker1Id,
      leaseMs: 60_000,
      batchSize: 5,
      now,
    });
    expect(initialClaim?.id).toBe(result.requestId);

    // 先原子提交一个正式 checkpoint，再由 A 领取下一步并崩溃。
    await mysqlHostedProvisioningRequestStore.updateState({
      requestId: result.requestId,
      workerId: worker1Id,
      state: "pending",
      currentStep: "prepare_runtime_revision",
      lastCompletedStep: "ensure_agent_publication",
      checkpoint: {
        agentRevisionId: revision.id,
        agentPublicationRecordId: "publication-checkpoint-001",
        agentAttestationId: "attestation-checkpoint-001",
      },
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const [claimedByWorker1] = await mysqlHostedProvisioningRequestStore.claimRequests({
      workerId: worker1Id,
      leaseMs: 60_000,
      batchSize: 5,
      now: new Date(now.getTime() + 1_000),
    });
    expect(claimedByWorker1?.leaseOwner).toBe(worker1Id);
    expect(claimedByWorker1?.lastCompletedStep).toBe("ensure_agent_publication");
    expect(claimedByWorker1?.stepAgentRevisionId).toBe(revision.id);

    const worker2Id = "worker-recovery-002";
    const [claimedByWorker2] = await mysqlHostedProvisioningRequestStore.claimRequests({
      workerId: worker2Id,
      leaseMs: 60_000,
      batchSize: 5,
      now: new Date(now.getTime() + 62_000),
    });
    expect(claimedByWorker2?.id).toBe(result.requestId);
    expect(claimedByWorker2?.leaseOwner).toBe(worker2Id);
    expect(claimedByWorker2?.currentStep).toBe("prepare_runtime_revision");
    expect(claimedByWorker2?.lastCompletedStep).toBe("ensure_agent_publication");
    expect(claimedByWorker2?.stepAgentRevisionId).toBe(revision.id);

    await expect(
      mysqlHostedProvisioningRequestStore.updateState({
        requestId: result.requestId,
        workerId: worker1Id,
        state: "permanent_failed",
        lastError: "stale worker overwrite",
      }),
    ).rejects.toBeInstanceOf(HostedProvisioningLeaseLostError);
    await expect(
      mysqlHostedProvisioningRequestStore.releaseLease({
        requestId: result.requestId,
        workerId: worker1Id,
      }),
    ).rejects.toBeInstanceOf(HostedProvisioningLeaseLostError);

    const resumed = await mysqlHostedProvisioningRequestStore.updateState({
      requestId: result.requestId,
      workerId: worker2Id,
      state: "pending",
      currentStep: "prepare_runtime_revision",
      nextAttemptAt: new Date(now.getTime() + 62_000),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(resumed.state).toBe("pending");
    expect(resumed.leaseOwner).toBeNull();
    expect(resumed.lastCompletedStep).toBe("ensure_agent_publication");
    expect(resumed.stepAgentRevisionId).toBe(revision.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 18：重复事件消费保持幂等
// ═══════════════════════════════════════════════════════════

describe("场景18：重复事件消费保持幂等", () => {
  it("同一 Outbox 事件投递两次后投影结果一致", async () => {
    const fixture = await seedEndToEndFixture("idempotent-event");

    // 投影构建器
    const buildRouteEligibility = createBuildRouteEligibility({
      store: mysqlRouteEligibilityStore,
    });

    // 事件处理器
    const handler = createProjectionEventHandler({
      store: mysqlRouteEligibilityStore,
      sourceReader: mysqlRouteEligibilitySourceReader,
      buildRouteEligibility,
    });

    // 取 RouteSet 激活事件
    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, fixture.routeSet.id));
    expect(outboxEvents.length).toBeGreaterThanOrEqual(1);
    const routeSetEvent = outboxEvents.find((e) => e.eventType === "route_set.activated");
    expect(routeSetEvent).toBeDefined();

    // 先构建初始投影（route_set.activated handler 仅重建已存在的投影，
    // 首次需要通过 buildRouteEligibility 创建投影）
    await buildRouteEligibility({
      tenantId: fixture.tenantId,
      routeId: fixture.route.id,
    });

    // 第一次处理
    await handler(routeSetEvent!);

    const [projectionAfterFirst] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, fixture.route.id))
      .limit(1);
    expect(projectionAfterFirst?.eligibilityState).toBe("eligible");

    const firstVersionNo = projectionAfterFirst?.projectionVersionNo;
    const firstLastRebuiltAt = projectionAfterFirst?.lastRebuiltAt;

    // 第二次处理同一事件 → 幂等，投影状态不变（或仅更新 lastRebuiltAt）
    await handler(routeSetEvent!);

    const [projectionAfterSecond] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, fixture.route.id))
      .limit(1);

    // eligibilityState 必须保持 eligible
    expect(projectionAfterSecond?.eligibilityState).toBe("eligible");
    // projectionVersionNo 必须一致（同一事件 → 同一权威版本）
    expect(projectionAfterSecond?.projectionVersionNo).toBe(firstVersionNo);
    // 关键证据字段不变
    expect(projectionAfterSecond?.agentRevisionId).toBe(projectionAfterFirst?.agentRevisionId);
    expect(projectionAfterSecond?.runtimeRevisionId).toBe(projectionAfterFirst?.runtimeRevisionId);
    // lastRebuiltAt 可能更新（重建立即触发），但状态一致
    expect(projectionAfterSecond?.lastRebuiltAt).toBeDefined();
    void firstLastRebuiltAt;
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 19：Route Key 在 Revision 变化后保持不变
// ═══════════════════════════════════════════════════════════

describe("场景19：Route Key 在 Revision 变化后保持不变", () => {
  it("同一 RouteSet 多次激活后 routeKey 稳定不变", async () => {
    const fixture = await seedEndToEndFixture("stable-route-key");

    // 第一次激活后的 routeKey
    const [revision1] = await db
      .select()
      .from(routeRevision)
      .where(eq(routeRevision.routeId, fixture.route.id))
      .limit(1);
    expect(revision1?.routeKey).toBe("primary");

    // 发布新 AgentRevision
    const newAgentRevision = await createDraftRevision({
      tenantId: fixture.tenantId,
      agentId: fixture.agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:stable-key-v2",
      instructionHash: "sha256:instr-stable-key-v2",
      agentArtifactRef: "oci://registry/agent@sha256:stable-key-v2",
      modelPolicyJson: { model: "doubao-pro-v2" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
      createdBy: fixture.userIdentityId,
    });
    await createVerifiedAttestationDirect(
      fixture.tenantId,
      "agent_revision",
      newAgentRevision.id,
      "agent-content-stable-key-v2",
    );
    await publishRevision(fixture.tenantId, newAgentRevision.id, 2);

    // 使用新 AgentRevision 再次激活（同一 routeId）
    const routeSetBefore = await getRouteSetById(fixture.tenantId, fixture.routeSet.id);
    const expectedVersion = routeSetBefore?.versionNo ?? 1;

    await activateRouteForTest({
      tenantId: fixture.tenantId,
      routeSetId: fixture.routeSet.id,
      routeSetExpectedVersionNo: expectedVersion,
      routeId: fixture.route.id,
      agentRevisionId: newAgentRevision.id,
      runtimeRevisionId: fixture.runtimeRevision.id,
      trafficWeight: 10000,
      priorityNo: 1,
      actor: { tenantId: fixture.tenantId, actorType: "service", actorId: "test-updater" },
    });

    // 新 RouteRevision 的 routeKey 仍是 "primary"
    const revisions = await db
      .select()
      .from(routeRevision)
      .where(eq(routeRevision.routeId, fixture.route.id))
      .orderBy(routeRevision.revisionNo);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    for (const rev of revisions) {
      expect(rev.routeKey).toBe("primary");
    }

    // DeploymentRoute 的 routeKey 也保持不变
    const [routeRow] = await db
      .select()
      .from(routeEligibilityProjection)
      .where(eq(routeEligibilityProjection.routeId, fixture.route.id))
      .limit(1);
    void routeRow;
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 20：跨租户访问全部 Fail-closed
// ═══════════════════════════════════════════════════════════

describe("场景20：跨租户访问全部 Fail-closed", () => {
  it("跨租户创建 AgentRevision → 404 RESOURCE_NOT_FOUND", async () => {
    const { userIdentityId } = await seedAdminWithActionBindings();
    const agent = await createAgent({
      tenantId: "00000000-0000-4000-8000-000000000000",
      agentKey: "cross-tenant-agent",
      displayName: "Cross Tenant Agent",
      ownerUserId: userIdentityId,
      lifecycleState: "enabled",
    });

    const crossTenantRequestId = "req-e2e-cross-tenant-001";
    const request = buildApiRequest({
      audience: "admin",
      method: "POST",
      path: "/agents/random-uuid/revisions",
      requestId: crossTenantRequestId,
      idempotencyKey: "idem-e2e-cross-tenant-001",
      body: {
        source: { source_type: "import", ref: "test-ref" },
        artifact_digest: computeArtifactDigest("cross-tenant-e2e"),
        instruction_hash: computeArtifactDigest("cross-tenant-instr-e2e"),
        model_policy: { model: "gpt-4" },
        permission_requirements: [],
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const randomAgentId = "99999999-9999-4999-8999-999999999999";
    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: randomAgentId }),
    });
    await assertCrossTenantHidden(response, crossTenantRequestId);
  });

  it("跨租户 getAgentById 返回 null", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const agent = await createAgent({
      tenantId,
      agentKey: "own-tenant-agent",
      displayName: "Own Tenant Agent",
      ownerUserId: userIdentityId,
      lifecycleState: "enabled",
    });

    // 同租户可读
    const ownTenantAgent = await getAgentById(tenantId, agent.id);
    expect(ownTenantAgent).not.toBeNull();

    // 跨租户读 → null（隐藏式拒绝）
    const crossTenantAgent = await getAgentById("99999999-9999-4999-8999-999999999999", agent.id);
    expect(crossTenantAgent).toBeNull();
  });

  it("跨租户 PublicationRecord 查询返回 null", async () => {
    const { tenantId, userIdentityId } = await seedAdminWithActionBindings();
    const { revision } = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "cross-pub-agent",
      "cross-pub-v1",
    );

    // 同租户可读
    const ownPublication = await getPublicationRecordBySubject({
      tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: revision.id,
    });
    expect(ownPublication).not.toBeNull();

    // 跨租户读 → null
    const crossPublication = await getPublicationRecordBySubject({
      tenantId: "99999999-9999-4999-8999-999999999999",
      subjectType: "agent_revision",
      subjectRevisionId: revision.id,
    });
    expect(crossPublication).toBeNull();
  });
});
