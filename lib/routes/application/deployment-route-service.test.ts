/**
 * S03-C04：V11 DeploymentRoute 路由控制面集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - RouteSet CRUD：createRouteSet / getRouteSetById / getRouteSetByAgentScope + 跨租户隔离。
 * - Route 查询：getRouteById / listRoutesBySet / listEnabledRouteProjections。
 * - upsertDeploymentRoute：ETag 乐观锁 + published 校验 + attestation 门禁 + 能力子集校验 + 权重校验 + 审计。
 * - disableDeploymentRoute：ETag 乐观锁 + 审计。
 * - 回滚：snapshot → 修改 → 恢复 → 只影响新 Invocation。
 * - 阶段验收：并发 ETag 冲突 / versionNo 单调递增 / affectsNewInvocationsOnly / 未验证制品 RouteSet 不变化。
 *
 * 真实 ed25519 签名 + 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { createHash } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  buildDsseArtifactAttestationEnvelope,
  type PredicateSupplyChain,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  getIdempotencyRecordById,
  insertProcessingRecord,
} from "@/lib/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  AgentCapabilityUnsupportedError,
  MAX_TRAFFIC_WEIGHT,
  RevisionNotPublishedError,
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  RouteWeightInvalidError,
  createRouteSet,
  disableDeploymentRoute,
  getRouteById,
  getRouteSetByAgentScope,
  getRouteSetById,
  getRouteSetSnapshot,
  listEnabledRouteProjections,
  listRoutesBySet,
  upsertDeploymentRoute,
} from "@/lib/routes/application/deployment-route-service";
import { mysqlRouteControlStore } from "@/lib/routes/persistence/mysql-route-control-store";
import type {
  RouteControlSession,
  RouteControlStore,
} from "@/lib/routes/persistence/route-control-store";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { createRuntime } from "@/lib/runtimes/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtimes/persistence/runtime-revision-queries";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/v11/test-support/publish-trusted-runtime-revision";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore（DSSE Envelope） ────

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

// ─── 辅助：DSSE Envelope 构造（来自 test-support） ─────────
// generateTestBuilderKey / buildDsseArtifactAttestationEnvelope 来自 test-support。

function buildCleanSbom(): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
    components: [
      { type: "library", name: "lodash", version: "4.17.21", licenses: [{ license: { id: "MIT" } }] },
    ],
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

// ─── 辅助：seed 租户 + 用户 ────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "route-owner-001",
    email: "route-owner@example.com",
    displayName: "Route Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "route-owner-001",
    displayName: "Route Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

type RouteTransactionStep =
  | "appendRevision"
  | "appendActivation"
  | "updateRouteProjection"
  | "advanceRouteSetVersion"
  | "appendAudit"
  | "appendOutbox"
  | "completeIdempotency";

function failAfterRouteStep(store: RouteControlStore, failureStep: RouteTransactionStep) {
  return {
    transaction: <T>(operation: (session: RouteControlSession) => Promise<T>) =>
      store.transaction((session) => {
        const failAfter = async <TResult>(step: RouteTransactionStep, result: Promise<TResult>) => {
          const value = await result;
          if (step === failureStep) throw new Error(`injected failure after ${step}`);
          return value;
        };
        return operation({
          ...session,
          appendRevision: (params) => failAfter("appendRevision", session.appendRevision(params)),
          appendActivation: (params) =>
            failAfter("appendActivation", session.appendActivation(params)),
          updateRouteProjection: (params) =>
            failAfter("updateRouteProjection", session.updateRouteProjection(params)),
          advanceRouteSetVersion: (params) =>
            failAfter("advanceRouteSetVersion", session.advanceRouteSetVersion(params)),
          appendAudit: (params) => failAfter("appendAudit", session.appendAudit(params)),
          appendOutbox: (params) => failAfter("appendOutbox", session.appendOutbox(params)),
          completeIdempotency: (params) =>
            failAfter("completeIdempotency", session.completeIdempotency(params)),
        });
      }),
  } satisfies RouteControlStore;
}

// ─── 辅助：创建 verified attestation ───────────────────────

async function createVerifiedAttestation(
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
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const sbomDoc = buildCleanSbom();
  const provDoc = buildValidProvenance();
  const supplyChain: PredicateSupplyChain = { sbomRef, sbomContent: sbomDoc, provenanceRef: provRef, provenanceContent: provDoc };
  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, supplyChain),
  );
  store.writeSbom(sbomRef, sbomDoc);
  store.writeProvenance(provRef, provDoc);

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:company-agent-runtime",
  };

  const attestation = await verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );
  return attestation.id;
}

// ─── 辅助：seed Agent + published AgentRevision + attestation ─

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  requiredCaps: string[],
  contentSuffix: string,
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
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
    agentInterfaceRequirementsJson: { required: requiredCaps, optional: [] },
    createdBy: ownerId,
  });

  await createVerifiedAttestation(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${contentSuffix}`,
  );
  await publishRevision(tenantId, revision.id, 1);

  return { agent, revision };
}

// ─── 辅助：seed Runtime + published RuntimeRevision + attestation ─

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  capabilities: string[],
  contentSuffix: string,
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
  });

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@sha256:${contentSuffix}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "managed",
    networkZone: "internal",
    configHash: `sha256:${createHash("sha256").update(`config_${contentSuffix}`).digest("hex")}`,
    createdBy: ownerId,
  });

  const attestationId = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId,
  });

  return { runtime, revision };
}

// ═══════════════════════════════════════════════════════════
// 1. RouteSet CRUD
// ═══════════════════════════════════════════════════════════

describe("V11 RouteSet CRUD", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    ownerId = seeded.ownerId;
    const { agent } = await seedPublishedAgentRevision(
      tenantId,
      ownerId,
      "finance",
      ["event_stream"],
      "v1",
    );
    agentId = agent.id;
  });

  it("createRouteSet 创建新 RouteSet（versionNo=1）", async () => {
    const routeSet = await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });
    expect(routeSet.id).toBeDefined();
    expect(routeSet.tenantId).toBe(tenantId);
    expect(routeSet.agentId).toBe(agentId);
    expect(routeSet.routeScopeKey).toBe("prod");
    expect(routeSet.versionNo).toBe(1);
  });

  it("createRouteSet 同 tenant+agent+scope 唯一约束冲突", async () => {
    await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    await expect(
      createRouteSet({
        tenantId,
        agentId,
        routeScopeKey: "prod",
        routeScopeJson: {},
      }),
    ).rejects.toThrow();
  });

  it("getRouteSetById 存在时返回", async () => {
    const created = await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    const found = await getRouteSetById(tenantId, created.id);
    expect(found?.id).toBe(created.id);
  });

  it("getRouteSetById 不存在返回 null", async () => {
    expect(await getRouteSetById(tenantId, "missing-id")).toBeNull();
  });

  it("getRouteSetById 跨租户隔离", async () => {
    const created = await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    expect(await getRouteSetById("11111111-1111-4111-8111-111111111111", created.id)).toBeNull();
  });

  it("getRouteSetByAgentScope 按 agent+scope 查询", async () => {
    await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "canary",
      routeScopeJson: {},
    });
    const found = await getRouteSetByAgentScope(tenantId, agentId, "canary");
    expect(found?.routeScopeKey).toBe("canary");
  });

  it("getRouteSetByAgentScope 跨租户隔离", async () => {
    await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    const found = await getRouteSetByAgentScope(
      "11111111-1111-4111-8111-111111111111",
      agentId,
      "prod",
    );
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. upsertDeploymentRoute 成功路径 + 门禁
// ═══════════════════════════════════════════════════════════

describe("V11 upsertDeploymentRoute", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;
  let agentRevisionId: string;
  let runtimeId: string;
  let runtimeRevisionId: string;
  let routeSetId: string;

  beforeEach(async () => {
    const seeded = await seedTenantAndOwner();
    tenantId = seeded.tenantId;
    ownerId = seeded.ownerId;

    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      ownerId,
      "finance",
      ["event_stream", "steer"],
      "agent-v1",
    );
    agentId = agentResult.agent.id;
    agentRevisionId = agentResult.revision.id;

    const runtimeResult = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "doubao-hosted",
      ["event_stream", "steer", "cancel", "tool_call"],
      "runtime-v1",
    );
    runtimeId = runtimeResult.runtime.id;
    runtimeRevisionId = runtimeResult.revision.id;

    const routeSet = await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });
    routeSetId = routeSet.id;
  });

  it("成功路径：所有门禁通过 → route 创建 + versionNo 递增 + 审计", async () => {
    const result = await upsertDeploymentRoute({
      tenantId,
      routeSetId,
      routeSetExpectedVersionNo: 1,
      agentRevisionId,
      runtimeRevisionId,
      trafficWeight: 10000,
      priorityNo: 1,
      actor: buildActor(tenantId, "deploy-bot-001"),
    });

    expect(result.route.routeSetId).toBe(routeSetId);
    expect(result.route.agentRevisionId).toBe(agentRevisionId);
    expect(result.route.runtimeRevisionId).toBe(runtimeRevisionId);
    expect(result.route.trafficWeight).toBe(10000);
    expect(result.route.routeState).toBe("enabled");
    expect(result.routeSet.versionNo).toBe(2);
    expect(result.etag).toBe("route-set-2");
    expect(result.affectsNewInvocationsOnly).toBe(true);

    // 审计写入
    const auditEvents = await listAuditEvents({
      tenantId,
      actionType: "route.update",
      targetType: "deployment_route",
      targetId: result.route.id,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.reason).toContain("DeploymentRoute 更新");
  });

  it("ETag 不匹配 → RouteSetVersionConflictError", async () => {
    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 99, // 错误的 ETag
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(RouteSetVersionConflictError);
  });

  it("RouteSet 不存在 → RouteSetNotFoundError", async () => {
    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId: "nonexistent-routeset",
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(RouteSetNotFoundError);
  });

  it("AgentRevision 未 published → RevisionNotPublishedError", async () => {
    // 创建 draft AgentRevision（未 publish）
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId,
      sourceType: "code",
      sourceRevision: "git:draft",
      instructionHash: "sha256:draft",
      agentArtifactRef: "oci://registry/agent@sha256:draft",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
      createdBy: ownerId,
    });

    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId: draftRevision.id,
        runtimeRevisionId,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(RevisionNotPublishedError);
  });

  it("RuntimeRevision 未 published → RevisionNotPublishedError", async () => {
    const draftRuntimeRevision = await createDraftRuntimeRevision({
      tenantId,
      runtimeId,
      protocolType: "a2a",
      endpointRef: "https://draft.internal",
      runtimeArtifactRef: "oci://registry/runtime@sha256:draft",
      runtimeCapabilitiesJson: ["event_stream", "steer"],
      identityMode: "managed",
      networkZone: "internal",
      configHash: "sha256:draft",
      createdBy: ownerId,
    });

    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId: draftRuntimeRevision.id,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(RevisionNotPublishedError);
  });

  it("AgentRevision attestation 未 verified → 抛错", async () => {
    // 创建新 AgentRevision 并 publish，但不创建 attestation
    // beforeEach 已 publish 第一个 Revision，Agent.versionNo 递增到 2
    const newRevision = await createDraftRevision({
      tenantId,
      agentId,
      sourceType: "code",
      sourceRevision: "git:no-attest",
      instructionHash: "sha256:no-attest",
      agentArtifactRef: "oci://registry/agent@sha256:no-attest",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
      createdBy: ownerId,
    });
    await publishRevision(tenantId, newRevision.id, 2);

    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId: newRevision.id,
        runtimeRevisionId,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(/attestation 未 verified/);
  });

  it("RuntimeRevision attestation 已撤销 → 抛错", async () => {
    // beforeEach 已 publish 第一个 Revision，Runtime.versionNo 递增到 2
    const newRuntimeRevision = await createDraftRuntimeRevision({
      tenantId,
      runtimeId,
      protocolType: "a2a",
      endpointRef: "https://no-attest.internal",
      runtimeArtifactRef: `oci://registry/runtime@sha256:${"d".repeat(64)}`,
      runtimeCapabilitiesJson: ["event_stream", "steer"],
      identityMode: "managed",
      networkZone: "internal",
      configHash: `sha256:${createHash("sha256").update("no-attest").digest("hex")}`,
      createdBy: ownerId,
    });
    const rtAttestationId = await createVerifiedAttestation(
      tenantId,
      "runtime_revision",
      newRuntimeRevision.id,
      "runtime-content-no-attest",
    );
    await publishTrustedRuntimeRevisionForTest({
      tenantId,
      revisionId: newRuntimeRevision.id,
      runtimeExpectedVersionNo: 2,
      attestationId: rtAttestationId,
    });
    // 撤销 attestation 使 route 层校验失败
    const { revokeAttestation } = await import(
      "@/lib/artifacts/persistence/artifact-attestation-queries"
    );
    await revokeAttestation(
      tenantId,
      rtAttestationId,
      buildActor(tenantId, "admin-001"),
      "测试撤销",
    );

    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId: newRuntimeRevision.id,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(/attestation 未 verified/);
  });

  it("能力子集不满足 → AgentCapabilityUnsupportedError", async () => {
    // 在 RouteSet 所属 Agent 下创建需要 memory 的新修订（Runtime 不提供 memory）
    const memAgentRev = await createDraftRevision({
      tenantId,
      agentId,
      sourceType: "code",
      sourceRevision: "git:mem-v1",
      instructionHash: "sha256:mem-v1",
      agentArtifactRef: "oci://registry/agent@sha256:mem-v1",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream", "memory"], optional: [] },
      createdBy: ownerId,
    });
    await createVerifiedAttestation(
      tenantId,
      "agent_revision",
      memAgentRev.id,
      "agent-content-mem-v1",
    );
    await publishRevision(tenantId, memAgentRev.id, 2);

    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId: memAgentRev.id,
        runtimeRevisionId,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(AgentCapabilityUnsupportedError);
  });

  it("权重超出范围 → RouteWeightInvalidError", async () => {
    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: MAX_TRAFFIC_WEIGHT + 1,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(RouteWeightInvalidError);

    await expect(
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: -1,
        actor: buildActor(tenantId, "deploy-bot-001"),
      }),
    ).rejects.toThrow(RouteWeightInvalidError);
  });

  it("更新已有路由（同组合 upsert）→ 权重更新 + versionNo 递增", async () => {
    // 第一次创建
    const r1 = await upsertDeploymentRoute({
      tenantId,
      routeSetId,
      routeSetExpectedVersionNo: 1,
      agentRevisionId,
      runtimeRevisionId,
      trafficWeight: 3000,
      actor: buildActor(tenantId, "deploy-bot-001"),
    });
    expect(r1.route.trafficWeight).toBe(3000);
    expect(r1.routeSet.versionNo).toBe(2);

    // 第二次更新（同组合，不同权重）
    const r2 = await upsertDeploymentRoute({
      tenantId,
      routeSetId,
      routeSetExpectedVersionNo: 2,
      agentRevisionId,
      runtimeRevisionId,
      trafficWeight: 7000,
      actor: buildActor(tenantId, "deploy-bot-001"),
    });
    expect(r2.route.id).toBe(r1.route.id); // 同一路由行
    expect(r2.route.trafficWeight).toBe(7000);
    expect(r2.routeSet.versionNo).toBe(3);

    const revisions = await db
      .select()
      .from(routeRevision)
      .where(eq(routeRevision.routeId, r1.route.id))
      .orderBy(asc(routeRevision.revisionNo));
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ revisionNo: 1, trafficWeight: 3000 });
    expect(revisions[1]).toMatchObject({ revisionNo: 2, trafficWeight: 7000 });
    expect(revisions[0]?.contentDigest).not.toBe(revisions[1]?.contentDigest);

    const activations = await db
      .select()
      .from(routeActivation)
      .where(eq(routeActivation.routeId, r1.route.id))
      .orderBy(asc(routeActivation.activationSequence));
    expect(activations).toHaveLength(2);
    expect(activations[0]).toMatchObject({
      routeRevisionId: revisions[0]?.id,
      previousRouteRevisionId: null,
      activationSequence: 1,
    });
    expect(activations[1]).toMatchObject({
      routeRevisionId: revisions[1]?.id,
      previousRouteRevisionId: revisions[0]?.id,
      activationSequence: 2,
    });
    expect(r2.route.activeRouteRevisionId).toBe(revisions[1]?.id);

    const outboxEvents = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, r1.route.id));
    expect(
      outboxEvents.filter((event) => event.eventType === "route.revision.validated"),
    ).toHaveLength(2);
    expect(outboxEvents.filter((event) => event.eventType === "route.activated")).toHaveLength(2);
  });

  it("相同 Idempotency-Key 重试只保留一个修订和一个激活事实", async () => {
    const command = {
      tenantId,
      routeSetId,
      routeSetExpectedVersionNo: 1,
      agentRevisionId,
      runtimeRevisionId,
      trafficWeight: 5000,
      actor: buildActor(tenantId, "deploy-bot-001"),
      requestId: "request-route-idempotency",
      idempotencyKey: "route-idempotency-001",
    };
    const first = await upsertDeploymentRoute(command);
    const replay = await upsertDeploymentRoute(command);

    expect(replay.routeRevisionId).toBe(first.routeRevisionId);
    expect(replay.routeActivationId).toBe(first.routeActivationId);
    expect(
      await db.select().from(routeRevision).where(eq(routeRevision.routeId, first.route.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(routeActivation).where(eq(routeActivation.routeId, first.route.id)),
    ).toHaveLength(1);
  });

  it("两个并发激活只有一个权威结果，冲突事务不留下修订或激活", async () => {
    const results = await Promise.allSettled([
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 4000,
        actor: buildActor(tenantId, "deploy-bot-001"),
        idempotencyKey: "route-concurrent-a",
      }),
      upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 6000,
        actor: buildActor(tenantId, "deploy-bot-002"),
        idempotencyKey: "route-concurrent-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(RouteSetVersionConflictError) });

    const routes = await listRoutesBySet(routeSetId);
    expect(routes).toHaveLength(1);
    const authoritativeRoute = routes[0];
    if (!authoritativeRoute) throw new Error("并发激活未留下权威路由");
    expect(
      await db.select().from(routeRevision).where(eq(routeRevision.routeId, authoritativeRoute.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(routeActivation)
        .where(eq(routeActivation.routeId, authoritativeRoute.id)),
    ).toHaveLength(1);
    expect((await getRouteSetById(tenantId, routeSetId))?.versionNo).toBe(2);
  });

  // ═══════════════════════════════════════════════════════════
  // 3. Route 查询
  // ═══════════════════════════════════════════════════════════

  describe("V11 Route 查询", () => {
    let tenantId: string;
    let ownerId: string;
    let agentId: string;
    let agentRevisionId: string;
    let runtimeRevisionId: string;
    let routeSetId: string;
    let routeId: string;

    beforeEach(async () => {
      const seeded = await seedTenantAndOwner();
      tenantId = seeded.tenantId;
      ownerId = seeded.ownerId;

      const agentResult = await seedPublishedAgentRevision(
        tenantId,
        ownerId,
        "finance",
        ["event_stream"],
        "v1",
      );
      agentId = agentResult.agent.id;
      agentRevisionId = agentResult.revision.id;

      const runtimeResult = await seedPublishedRuntimeRevision(
        tenantId,
        ownerId,
        "doubao-hosted",
        ["event_stream", "steer"],
        "v1",
      );
      runtimeRevisionId = runtimeResult.revision.id;

      const routeSet = await createRouteSet({
        tenantId,
        agentId,
        routeScopeKey: "prod",
        routeScopeJson: {},
      });
      routeSetId = routeSet.id;

      const result = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      routeId = result.route.id;
    });

    it("getRouteById 存在时返回", async () => {
      const route = await getRouteById(tenantId, routeId);
      expect(route?.id).toBe(routeId);
      expect(route?.trafficWeight).toBe(10000);
    });

    it("getRouteById 不存在返回 null", async () => {
      expect(await getRouteById(tenantId, "missing-route")).toBeNull();
    });

    it("getRouteById 跨租户隔离", async () => {
      expect(await getRouteById("11111111-1111-4111-8111-111111111111", routeId)).toBeNull();
    });

    it("listRoutesBySet 列出所有路由", async () => {
      const list = await listRoutesBySet(routeSetId);
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(routeId);
    });

    it("listRoutesBySet 按 routeState 过滤", async () => {
      const enabled = await listRoutesBySet(routeSetId, { routeState: "enabled" });
      expect(enabled).toHaveLength(1);
      const disabled = await listRoutesBySet(routeSetId, { routeState: "disabled" });
      expect(disabled).toHaveLength(0);
    });

    it("listEnabledRouteProjections 返回 enabled 路由", async () => {
      const routes = await listEnabledRouteProjections(tenantId, agentId, "prod");
      expect(routes).toHaveLength(1);
      expect(routes[0]?.id).toBe(routeId);
    });

    it("listEnabledRouteProjections 无 RouteSet 时返回空数组", async () => {
      const routes = await listEnabledRouteProjections(tenantId, agentId, "nonexistent-scope");
      expect(routes).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. disableDeploymentRoute
  // ═══════════════════════════════════════════════════════════

  describe("V11 disableDeploymentRoute", () => {
    let tenantId: string;
    let ownerId: string;
    let routeSetId: string;
    let routeId: string;
    let currentVersionNo: number;

    beforeEach(async () => {
      const seeded = await seedTenantAndOwner();
      tenantId = seeded.tenantId;
      ownerId = seeded.ownerId;

      const { agent, revision: agentRev } = await seedPublishedAgentRevision(
        tenantId,
        ownerId,
        "finance",
        ["event_stream"],
        "v1",
      );
      const { revision: runtimeRev } = await seedPublishedRuntimeRevision(
        tenantId,
        ownerId,
        "doubao-hosted",
        ["event_stream"],
        "v1",
      );

      const routeSet = await createRouteSet({
        tenantId,
        agentId: agent.id,
        routeScopeKey: "prod",
        routeScopeJson: {},
      });
      routeSetId = routeSet.id;

      const result = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId: agentRev.id,
        runtimeRevisionId: runtimeRev.id,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      routeId = result.route.id;
      currentVersionNo = result.routeSet.versionNo;
    });

    it("成功路径：route 禁用 + versionNo 递增 + 审计", async () => {
      const result = await disableDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: currentVersionNo,
        routeId,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });

      expect(result.route.routeState).toBe("disabled");
      expect(result.routeSet.versionNo).toBe(currentVersionNo + 1);
      expect(result.etag).toBe(`route-set-${currentVersionNo + 1}`);
      expect(result.affectsNewInvocationsOnly).toBe(true);

      // 审计写入
      const auditEvents = await listAuditEvents({
        tenantId,
        actionType: "route.update",
        targetType: "deployment_route",
        targetId: routeId,
      });
      // 两次：upsert + disable
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]?.reason).toContain("禁用");

      // listEnabledRouteProjections 不再返回 disabled 路由
      const effective = await listEnabledRouteProjections(
        tenantId,
        result.routeSet.agentId,
        "prod",
      );
      expect(effective).toHaveLength(0);
    });

    it("ETag 不匹配 → RouteSetVersionConflictError", async () => {
      await expect(
        disableDeploymentRoute({
          tenantId,
          routeSetId,
          routeSetExpectedVersionNo: 99,
          routeId,
          actor: buildActor(tenantId, "deploy-bot-001"),
        }),
      ).rejects.toThrow(RouteSetVersionConflictError);
    });

    it("Route 不存在 → RouteNotFoundError", async () => {
      await expect(
        disableDeploymentRoute({
          tenantId,
          routeSetId,
          routeSetExpectedVersionNo: currentVersionNo,
          routeId: "nonexistent-route",
          actor: buildActor(tenantId, "deploy-bot-001"),
        }),
      ).rejects.toThrow(RouteNotFoundError);
    });

    it("Route 不属于该 RouteSet → RouteNotFoundError", async () => {
      // 创建另一个 RouteSet
      const otherRouteSet = await createRouteSet({
        tenantId,
        agentId: "some-other-agent-id",
        routeScopeKey: "other",
        routeScopeJson: {},
      });
      await expect(
        disableDeploymentRoute({
          tenantId,
          routeSetId: otherRouteSet.id,
          routeSetExpectedVersionNo: 1,
          routeId,
          actor: buildActor(tenantId, "deploy-bot-001"),
        }),
      ).rejects.toThrow(RouteNotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. 回滚场景
  // ═══════════════════════════════════════════════════════════

  describe("V11 回滚场景", () => {
    let tenantId: string;
    let ownerId: string;
    let agentId: string;
    let agentRev1Id: string;
    let runtimeRev1Id: string;
    let routeSetId: string;

    beforeEach(async () => {
      const seeded = await seedTenantAndOwner();
      tenantId = seeded.tenantId;
      ownerId = seeded.ownerId;

      const { agent, revision: agentRev } = await seedPublishedAgentRevision(
        tenantId,
        ownerId,
        "finance",
        ["event_stream"],
        "v1",
      );
      agentId = agent.id;
      agentRev1Id = agentRev.id;

      const { revision: runtimeRev } = await seedPublishedRuntimeRevision(
        tenantId,
        ownerId,
        "doubao-hosted",
        ["event_stream"],
        "v1",
      );
      runtimeRev1Id = runtimeRev.id;

      const routeSet = await createRouteSet({
        tenantId,
        agentId,
        routeScopeKey: "prod",
        routeScopeJson: {},
      });
      routeSetId = routeSet.id;
    });

    it("snapshot → 修改 → 恢复 → 只影响新 Invocation", async () => {
      // 初始：100% 流量到 rev1
      const r1 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId: agentRev1Id,
        runtimeRevisionId: runtimeRev1Id,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      const route1Id = r1.route.id;
      expect(r1.routeSet.versionNo).toBe(2);

      // 快照
      const snapshot = await getRouteSetSnapshot(tenantId, routeSetId);
      expect(snapshot.versionNo).toBe(2);
      expect(snapshot.enabledRoutes).toHaveLength(1);
      expect(snapshot.enabledRoutes[0]?.id).toBe(route1Id);

      // 修改：创建 rev2 并切换 100% 流量
      const { revision: agentRev2 } = await seedPublishedAgentRevision(
        tenantId,
        ownerId,
        "finance-v2",
        ["event_stream"],
        "v2",
      );
      // 需要创建第二个 Agent（agentKey 不同），但这会导致 agentId 不同
      // 实际上灰度是在同一 Agent 的不同 Revision 之间
      // 但我们的 seedPublishedAgentRevision 创建新 Agent。为了测试灰度，需要同一 Agent 的新 Revision。
      // 这里简化：直接在 RouteSet 中添加第二条路由（不同组合）

      // 实际上，为了在同一 Agent 上创建第二个 Revision：
      const agentRev2Draft = await createDraftRevision({
        tenantId,
        agentId,
        sourceType: "code",
        sourceRevision: "git:v2",
        instructionHash: "sha256:instruction_v2",
        agentArtifactRef: "oci://registry/agent@sha256:v2",
        modelPolicyJson: {},
        permissionRequirementsJson: {},
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
        createdBy: ownerId,
      });
      await createVerifiedAttestation(
        tenantId,
        "agent_revision",
        agentRev2Draft.id,
        "agent-content-v2",
      );
      await publishRevision(tenantId, agentRev2Draft.id, 2); // versionNo=2

      // 灰度：rev1 90%, rev2 10%
      const r2 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 2,
        agentRevisionId: agentRev1Id,
        runtimeRevisionId: runtimeRev1Id,
        trafficWeight: 9000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      expect(r2.routeSet.versionNo).toBe(3);

      const r3 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 3,
        agentRevisionId: agentRev2Draft.id,
        runtimeRevisionId: runtimeRev1Id,
        trafficWeight: 1000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      expect(r3.routeSet.versionNo).toBe(4);

      // 验证：2 条 enabled 路由
      const effectiveAfterCanary = await listEnabledRouteProjections(tenantId, agentId, "prod");
      expect(effectiveAfterCanary).toHaveLength(2);

      // 回滚：禁用 rev2 路由，恢复 rev1 100%
      const r4 = await disableDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 4,
        routeId: r3.route.id,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      expect(r4.routeSet.versionNo).toBe(5);

      const r5 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 5,
        agentRevisionId: agentRev1Id,
        runtimeRevisionId: runtimeRev1Id,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      expect(r5.routeSet.versionNo).toBe(6);
      expect(r5.routeRevisionId).toBe(r1.routeRevisionId);
      // 验证 RouteActivation 在 DB 中的内部状态
      const [r5Activation] = await db
        .select()
        .from(routeActivation)
        .where(eq(routeActivation.id, r5.routeActivationId));
      expect(r5Activation?.previousRouteRevisionId).toBe(r2.routeRevisionId);
      expect(r5Activation?.activationSequence).toBe(3);

      // 验证回滚后：只有 1 条 enabled 路由（rev1 100%）
      const effectiveAfterRollback = await listEnabledRouteProjections(tenantId, agentId, "prod");
      expect(effectiveAfterRollback).toHaveLength(1);
      expect(effectiveAfterRollback[0]?.agentRevisionId).toBe(agentRev1Id);
      expect(effectiveAfterRollback[0]?.trafficWeight).toBe(10000);

      // versionNo 单调递增（回滚也递增，不回退）
      expect(r5.routeSet.versionNo).toBeGreaterThan(snapshot.versionNo);

      // 历史路由行仍可查询（不物理删除）
      const allRoutes = await listRoutesBySet(routeSetId);
      expect(allRoutes).toHaveLength(2);
      const disabledRoutes = allRoutes.filter((r) => r.routeState === "disabled");
      expect(disabledRoutes).toHaveLength(1);
      expect(disabledRoutes[0]?.id).toBe(r3.route.id);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 6. S03-W03 阶段验收场景
  // ═══════════════════════════════════════════════════════════

  describe("S03-W03 阶段验收场景", () => {
    let tenantId: string;
    let ownerId: string;
    let agentId: string;
    let agentRevisionId: string;
    let runtimeRevisionId: string;
    let routeSetId: string;

    beforeEach(async () => {
      const seeded = await seedTenantAndOwner();
      tenantId = seeded.tenantId;
      ownerId = seeded.ownerId;

      const { agent, revision: agentRev } = await seedPublishedAgentRevision(
        tenantId,
        ownerId,
        "finance",
        ["event_stream"],
        "v1",
      );
      agentId = agent.id;
      agentRevisionId = agentRev.id;

      const { revision: runtimeRev } = await seedPublishedRuntimeRevision(
        tenantId,
        ownerId,
        "doubao-hosted",
        ["event_stream"],
        "v1",
      );
      runtimeRevisionId = runtimeRev.id;

      const routeSet = await createRouteSet({
        tenantId,
        agentId,
        routeScopeKey: "prod",
        routeScopeJson: {},
      });
      routeSetId = routeSet.id;
    });

    it("并发更新路由 → 旧 ETag 返回冲突，不出现部分权重", async () => {
      // 第一次更新成功（versionNo 1→2）
      const r1 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 5000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      expect(r1.routeSet.versionNo).toBe(2);

      // 用旧 ETag（1）再次更新 → 冲突
      await expect(
        upsertDeploymentRoute({
          tenantId,
          routeSetId,
          routeSetExpectedVersionNo: 1, // 旧 ETag
          agentRevisionId,
          runtimeRevisionId,
          trafficWeight: 7000,
          actor: buildActor(tenantId, "deploy-bot-002"),
        }),
      ).rejects.toThrow(RouteSetVersionConflictError);

      // 验证权重未被第二次更新覆盖
      const route = await getRouteById(tenantId, r1.route.id);
      expect(route?.trafficWeight).toBe(5000);
    });

    it("回滚 → 只影响新 Invocation，历史路由行可查询", async () => {
      // 初始路由
      const r1 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });

      // 禁用路由（模拟回滚到无流量）
      const r2 = await disableDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: r1.routeSet.versionNo,
        routeId: r1.route.id,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });

      // 新 Invocation 不再有有效路由
      const effective = await listEnabledRouteProjections(tenantId, agentId, "prod");
      expect(effective).toHaveLength(0);

      // 历史路由行仍可查询
      const allRoutes = await listRoutesBySet(routeSetId);
      expect(allRoutes).toHaveLength(1);
      expect(allRoutes[0]?.routeState).toBe("disabled");
      expect(allRoutes[0]?.id).toBe(r1.route.id);

      // versionNo 单调递增
      expect(r2.routeSet.versionNo).toBeGreaterThan(r1.routeSet.versionNo);
    });

    it("未验证制品 → 路由发布抛错，RouteSet 不变化（versionNo 不递增）", async () => {
      // 创建未验证的 AgentRevision 并 publish
      const unverifiedAgentRev = await createDraftRevision({
        tenantId,
        agentId,
        sourceType: "code",
        sourceRevision: "git:unverified",
        instructionHash: "sha256:unverified",
        agentArtifactRef: "oci://registry/agent@sha256:unverified",
        modelPolicyJson: {},
        permissionRequirementsJson: {},
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
        createdBy: ownerId,
      });
      await publishRevision(tenantId, unverifiedAgentRev.id, 2);

      // 路由更新应抛错
      await expect(
        upsertDeploymentRoute({
          tenantId,
          routeSetId,
          routeSetExpectedVersionNo: 1,
          agentRevisionId: unverifiedAgentRev.id,
          runtimeRevisionId,
          trafficWeight: 5000,
          actor: buildActor(tenantId, "deploy-bot-001"),
        }),
      ).rejects.toThrow(/attestation 未 verified/);

      // RouteSet versionNo 不变
      const routeSet = await getRouteSetById(tenantId, routeSetId);
      expect(routeSet?.versionNo).toBe(1);
    });

    it("Runtime 缺少 required capability → Route 发布失败", async () => {
      // 在 RouteSet 所属 Agent 下创建需要 memory 的新修订
      const memAgentRev = await createDraftRevision({
        tenantId,
        agentId,
        sourceType: "code",
        sourceRevision: "git:mem-v1",
        instructionHash: "sha256:mem-v1",
        agentArtifactRef: "oci://registry/agent@sha256:mem-v1",
        modelPolicyJson: {},
        permissionRequirementsJson: {},
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: { required: ["event_stream", "memory"], optional: [] },
        createdBy: ownerId,
      });
      await createVerifiedAttestation(
        tenantId,
        "agent_revision",
        memAgentRev.id,
        "agent-content-mem-v1",
      );
      await publishRevision(tenantId, memAgentRev.id, 2);

      // Runtime 不提供 memory → 路由发布失败
      await expect(
        upsertDeploymentRoute({
          tenantId,
          routeSetId,
          routeSetExpectedVersionNo: 1,
          agentRevisionId: memAgentRev.id,
          runtimeRevisionId,
          trafficWeight: 5000,
          actor: buildActor(tenantId, "deploy-bot-001"),
        }),
      ).rejects.toThrow(AgentCapabilityUnsupportedError);

      // RouteSet versionNo 不变
      const routeSet = await getRouteSetById(tenantId, routeSetId);
      expect(routeSet?.versionNo).toBe(1);
    });

    it("affectsNewInvocationsOnly 固定为 true", async () => {
      const result = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });
      expect(result.affectsNewInvocationsOnly).toBe(true);
    });

    it("MAX_TRAFFIC_WEIGHT 为 10000", async () => {
      expect(MAX_TRAFFIC_WEIGHT).toBe(10000);
    });

    it("route.update actionType 写入审计", async () => {
      const result = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 10000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });

      const auditEvents = await listAuditEvents({
        tenantId,
        actionType: "route.update",
        targetType: "deployment_route",
        targetId: result.route.id,
      });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]?.afterHash).toBeTruthy();
    });

    it("灰度：同 RouteSet 多条路由（不同组合）", async () => {
      // 创建第二个 AgentRevision（同 Agent）
      const agentRev2 = await createDraftRevision({
        tenantId,
        agentId,
        sourceType: "code",
        sourceRevision: "git:v2",
        instructionHash: "sha256:v2",
        agentArtifactRef: "oci://registry/agent@sha256:v2",
        modelPolicyJson: {},
        permissionRequirementsJson: {},
        delegationPolicyJson: {},
        agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
        createdBy: ownerId,
      });
      await createVerifiedAttestation(tenantId, "agent_revision", agentRev2.id, "agent-content-v2");
      await publishRevision(tenantId, agentRev2.id, 2);

      // rev1: 70%
      const r1 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: 1,
        agentRevisionId,
        runtimeRevisionId,
        trafficWeight: 7000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });

      // rev2: 30%
      const r2 = await upsertDeploymentRoute({
        tenantId,
        routeSetId,
        routeSetExpectedVersionNo: r1.routeSet.versionNo,
        agentRevisionId: agentRev2.id,
        runtimeRevisionId,
        trafficWeight: 3000,
        actor: buildActor(tenantId, "deploy-bot-001"),
      });

      // 2 条 enabled 路由
      const effective = await listEnabledRouteProjections(tenantId, agentId, "prod");
      expect(effective).toHaveLength(2);

      // 权重总和 = 10000
      const totalWeight = effective.reduce((sum, r) => sum + r.trafficWeight, 0);
      expect(totalWeight).toBe(10000);
    });
  });
});
