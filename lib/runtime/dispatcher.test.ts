/**
 * S05-C01：V11 调度服务与 Invocation/Binding/Attempt 集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - Invocation 仓储：createInvocation / getInvocationById / getInvocationsByTurn / updateInvocationState / heartbeat
 * - ExecutionBinding 仓储：createExecutionBinding / 不可变 1:1 / configHash 稳定 / 跨租户隔离
 * - InvocationAttempt 仓储：createAttempt / attemptNo 递增 / getLatestAttempt / updateAttemptState 状态机
 * - Dispatcher 调度：dispatchInvocationForTurn 完整链路 / 无路由保持 accepted / 状态冲突
 * - Projector 扩展：invocation.queued / turn.queued 事件投影只前移 cursor
 *
 * 真实 ed25519 签名 + 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  buildDsseArtifactAttestationEnvelope,
  computeTestDigest,
  type PredicateSupplyChain,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createCreateExecutionBinding } from "@/lib/executions/application/create-execution-binding";
import { ExecutionBindingAlreadyExistsError as StableExecutionBindingAlreadyExistsError } from "@/lib/executions/domain/execution-binding";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { mysqlExecutionBindingStore } from "@/lib/executions/persistence/mysql-execution-binding-store";
import {
  computeBindingConfigHash,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agent";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtime";
import { withdrawalRecord } from "@/lib/publications/persistence/publication-record";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
  listEnabledRouteProjections,
  upsertDeploymentRoute,
} from "@/lib/routes/application/deployment-route-service";
import {
  type ResolveRouteCommand,
  type RouteResolver,
  createResolveRoute,
} from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import {
  DispatchTurnStateError,
  ExecutionBindingAlreadyExistsError,
  InvocationAttemptNotFoundError,
  InvocationAttemptStateConflictError,
  InvocationNotFoundError,
  InvocationStateConflictError,
} from "@/lib/runtime/errors";
import {
  createAttempt,
  getAttemptById,
  getAttemptsByInvocation,
  getLatestAttempt,
  updateAttemptState,
} from "@/lib/runtime/invocation-attempt-queries";
import {
  createInvocation,
  getInvocationById,
  getInvocationsByTurn,
  recordInvocationHeartbeat,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/test-support/publish-trusted-runtime-revision";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

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
    externalSubject: "dispatch-owner-001",
    email: "dispatch-owner@example.com",
    displayName: "Dispatch Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "dispatch-owner-001",
    displayName: "Dispatch Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

// ─── 辅助：创建 verified attestation ───────────────────────

async function createVerifiedAttestation(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
) {
  const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, { sbomRef, sbomContent: buildCleanSbom(), provenanceRef: provRef, provenanceContent: buildValidProvenance() }),
  );
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:company-agent-runtime",
  };

  return verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );
}

// ─── 辅助：seed Agent + published AgentRevision + attestation ─

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  requiredCaps: string[],
  contentSuffix: string,
  modelPolicy?: Record<string, unknown>,
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
    modelPolicyJson: modelPolicy ?? { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: requiredCaps, optional: [] },
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${contentSuffix}`,
  );
  const publication = await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    attestationId: attestation.id,
    actorId: ownerId,
  });

  const publishedRevision = await getRevisionById(revision.id);
  if (!publishedRevision) throw new Error("测试 AgentRevision 发布后无法回读");
  return { agent, revision: publishedRevision, attestation, publication };
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
    lifecycleState: "enabled",
  });

  const artifactContent = `runtime-content-${contentSuffix}`;
  const artifactDigest = computeArtifactDigest(artifactContent);

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${artifactDigest}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "managed",
    networkZone: "internal",
    configHash: `sha256:config_${contentSuffix}`,
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    artifactContent,
  );
  const publication = await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  const publishedRevision = await getRuntimeRevisionById(revision.id);
  if (!publishedRevision) throw new Error("测试 RuntimeRevision 发布后无法回读");
  return { runtime, revision: publishedRevision, attestation, publication };
}

// ─── 辅助：seed 完整调度上下文（Tenant + User + Agent + Runtime + Route + Thread + Turn） ─

interface FullDispatchContext {
  tenantId: string;
  ownerId: string;
  agentId: string;
  agentRevision: AgentRevision;
  runtimeRevision: RuntimeRevision;
  agentAttestationId: string;
  runtimeAttestationId: string;
  agentPublicationRecordId: string;
  runtimePublicationRecordId: string;
  conformanceRunId: string;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

async function seedFullDispatchContext(): Promise<FullDispatchContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  const {
    agent,
    revision: agentRevision,
    attestation: agentAttestation,
    publication: agentPublication,
  } = await seedPublishedAgentRevision(tenantId, ownerId, "finance", ["event_stream"], "v1");

  const {
    revision: runtimeRevision,
    attestation: runtimeAttestation,
    publication: runtimePublication,
  } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "doubao-hosted",
    ["event_stream"],
    "v1",
  );

  // 创建 RouteSet + Route
  const routeSet = await createRouteSet({
    tenantId,
    agentId: agent.id,
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await upsertDeploymentRoute({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: agentRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  // 创建 Thread
  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    primaryAgentId: agent.id,
    actorId: ownerId,
  });

  // 接纳用户消息 Turn
  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析财务数据" },
    actorId: ownerId,
  });

  return {
    tenantId,
    ownerId,
    agentId: agent.id,
    agentRevision,
    runtimeRevision,
    agentAttestationId: agentAttestation.id,
    runtimeAttestationId: runtimeAttestation.id,
    agentPublicationRecordId: agentPublication.publicationRecordId,
    runtimePublicationRecordId: runtimePublication.publicationRecordId,
    conformanceRunId: runtimePublication.conformanceRunId,
    routeId: routeResult.route.id,
    routeSetId: routeSet.id,
    threadId: thread.id,
    turnId: turn.id,
    triggerItemId: turn.triggerItemId ?? null,
  };
}

// ═══════════════════════════════════════════════════════════
// 1. Invocation 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 Invocation 仓储", () => {
  let ctx: FullDispatchContext;

  beforeEach(async () => {
    ctx = await seedFullDispatchContext();
  });

  it("createInvocation 创建会话 Invocation（kind=initial, state=queued, invocationSequence=1）", async () => {
    const { invocation, event } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
      triggerItemId: ctx.triggerItemId,
    });

    expect(invocation.tenantId).toBe(ctx.tenantId);
    expect(invocation.threadId).toBe(ctx.threadId);
    expect(invocation.turnId).toBe(ctx.turnId);
    expect(invocation.jobId).toBeNull();
    expect(invocation.invocationSequence).toBe(1);
    expect(invocation.invocationKind).toBe("initial");
    expect(invocation.executionState).toBe("queued");
    expect(invocation.triggerItemId).toBe(ctx.triggerItemId);
    expect(invocation.versionNo).toBe(1);

    // invocation.queued 事件已写入
    expect(event).toBeDefined();
    expect(event.eventType).toBe("invocation.queued");
    expect(event.turnId).toBe(ctx.turnId);
    expect(event.invocationId).toBe(invocation.id);
  });

  it("createInvocation turnId/jobId 都为空 → InvocationStateConflictError", async () => {
    await expect(
      createInvocation({
        tenantId: ctx.tenantId,
        invocationKind: "initial",
      }),
    ).rejects.toThrow(InvocationStateConflictError);
  });

  it("createInvocation turnId 存在但 threadId 缺失 → InvocationStateConflictError", async () => {
    await expect(
      createInvocation({
        tenantId: ctx.tenantId,
        turnId: ctx.turnId,
        invocationKind: "initial",
      }),
    ).rejects.toThrow(InvocationStateConflictError);
  });

  it("createInvocation 第二次 invocationSequence 递增为 2", async () => {
    await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });

    const { invocation: second } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "regenerate",
      replacesInvocationId: "some-old-invocation",
    });

    expect(second.invocationSequence).toBe(2);
    expect(second.invocationKind).toBe("regenerate");
    expect(second.replacesInvocationId).toBe("some-old-invocation");
  });

  it("getInvocationById 跨租户隔离（返回 null）", async () => {
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });

    const found = await getInvocationById("11111111-1111-4111-8111-111111111111", invocation.id);
    expect(found).toBeNull();
  });

  it("getInvocationsByTurn 按 invocationSequence 升序返回", async () => {
    await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });
    await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "regenerate",
    });

    const list = await getInvocationsByTurn(ctx.tenantId, ctx.turnId);
    expect(list).toHaveLength(2);
    expect(list[0]?.invocationSequence).toBe(1);
    expect(list[1]?.invocationSequence).toBe(2);
  });

  it("updateInvocationState queued → running → completed 状态机转换", async () => {
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });

    await db.transaction(async (tx) => {
      const running = await updateInvocationState(tx, ctx.tenantId, invocation.id, "running");
      expect(running.executionState).toBe("running");
      expect(running.versionNo).toBe(2);
      expect(running.startedAt).toBeDefined();
      expect(running.lastHeartbeatAt).toBeDefined();
    });

    await db.transaction(async (tx) => {
      const completed = await updateInvocationState(tx, ctx.tenantId, invocation.id, "completed");
      expect(completed.executionState).toBe("completed");
      expect(completed.versionNo).toBe(3);
      expect(completed.finishedAt).toBeDefined();
    });
  });

  it("updateInvocationState 终态 → 任何状态 → InvocationStateConflictError", async () => {
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });

    await db.transaction(async (tx) => {
      await updateInvocationState(tx, ctx.tenantId, invocation.id, "running");
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, ctx.tenantId, invocation.id, "completed");
    });

    // completed 是终态，不可恢复
    await expect(
      db.transaction(async (tx) => {
        await updateInvocationState(tx, ctx.tenantId, invocation.id, "running");
      }),
    ).rejects.toThrow(InvocationStateConflictError);
  });

  it("updateInvocationState 跨租户 → InvocationNotFoundError", async () => {
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });

    await expect(
      db.transaction(async (tx) => {
        await updateInvocationState(
          tx,
          "11111111-1111-4111-8111-111111111111",
          invocation.id,
          "running",
        );
      }),
    ).rejects.toThrow(InvocationNotFoundError);
  });

  it("recordInvocationHeartbeat 更新 lastHeartbeatAt", async () => {
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });

    const heartbeatTime = new Date("2026-07-16T10:00:00.000Z");
    const updated = await recordInvocationHeartbeat(ctx.tenantId, invocation.id, heartbeatTime);
    expect(updated).not.toBeNull();
    expect(updated?.lastHeartbeatAt).toEqual(heartbeatTime);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. ExecutionBinding 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 ExecutionBinding 仓储", () => {
  let ctx: FullDispatchContext;
  let invocationId: string;

  beforeEach(async () => {
    ctx = await seedFullDispatchContext();
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });
    invocationId = invocation.id;
  });

  it("computeBindingConfigHash 相同输入产生相同 hash", async () => {
    const input = {
      agentRevisionId: "agent-rev-1",
      runtimeRevisionId: "runtime-rev-1",
      deploymentRouteId: "route-1",
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
      initialEnvironmentLeaseId: null,
      workspaceBindingId: null,
      policyRevisionId: null,
      contextCheckpointId: null,
    };
    const hash1 = computeBindingConfigHash(input);
    const hash2 = computeBindingConfigHash(input);
    expect(hash1).toBe(hash2);
    expect(hash1.startsWith("sha256:")).toBe(true);
  });

  it("computeBindingConfigHash 字段顺序不影响 hash", async () => {
    const hash1 = computeBindingConfigHash({
      agentRevisionId: "a",
      runtimeRevisionId: "b",
      deploymentRouteId: "c",
      modelProvider: "d",
      modelId: "e",
      modelRevisionRef: null,
      initialEnvironmentLeaseId: null,
      workspaceBindingId: null,
      policyRevisionId: null,
      contextCheckpointId: null,
    });
    // 重新构造相同内容（key 顺序不同）
    const hash2 = computeBindingConfigHash({
      contextCheckpointId: null,
      policyRevisionId: null,
      workspaceBindingId: null,
      initialEnvironmentLeaseId: null,
      modelRevisionRef: null,
      modelId: "e",
      modelProvider: "d",
      deploymentRouteId: "c",
      runtimeRevisionId: "b",
      agentRevisionId: "a",
    });
    expect(hash1).toBe(hash2);
  });

  it("createExecutionBinding 创建不可变 1:1 绑定", async () => {
    const binding = await createExecutionBinding({
      invocationId,
      tenantId: ctx.tenantId,
      agentRevisionId: ctx.agentRevision.id,
      runtimeRevisionId: ctx.runtimeRevision.id,
      deploymentRouteId: ctx.routeId,
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
    });

    expect(binding.invocationId).toBe(invocationId);
    expect(binding.tenantId).toBe(ctx.tenantId);
    expect(binding.agentRevisionId).toBe(ctx.agentRevision.id);
    expect(binding.runtimeRevisionId).toBe(ctx.runtimeRevision.id);
    expect(binding.deploymentRouteId).toBe(ctx.routeId);
    expect(binding.modelProvider).toBe("doubao");
    expect(binding.modelId).toBe("doubao-pro");
    expect(binding.configHash.startsWith("sha256:")).toBe(true);
  });

  it("createExecutionBinding 同 invocationId 重复创建 → ExecutionBindingAlreadyExistsError", async () => {
    await createExecutionBinding({
      invocationId,
      tenantId: ctx.tenantId,
      agentRevisionId: ctx.agentRevision.id,
      runtimeRevisionId: ctx.runtimeRevision.id,
      deploymentRouteId: ctx.routeId,
      modelProvider: "doubao",
      modelId: "doubao-pro",
    });

    await expect(
      createExecutionBinding({
        invocationId,
        tenantId: ctx.tenantId,
        agentRevisionId: ctx.agentRevision.id,
        runtimeRevisionId: ctx.runtimeRevision.id,
        deploymentRouteId: ctx.routeId,
        modelProvider: "doubao",
        modelId: "doubao-pro",
      }),
    ).rejects.toThrow(ExecutionBindingAlreadyExistsError);
  });

  it("getExecutionBindingByInvocation 跨租户隔离（返回 null）", async () => {
    await createExecutionBinding({
      invocationId,
      tenantId: ctx.tenantId,
      agentRevisionId: ctx.agentRevision.id,
      runtimeRevisionId: ctx.runtimeRevision.id,
      deploymentRouteId: ctx.routeId,
      modelProvider: "doubao",
      modelId: "doubao-pro",
    });

    const found = await getExecutionBindingByInvocation(
      "11111111-1111-4111-8111-111111111111",
      invocationId,
    );
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. InvocationAttempt 仓储
// ═══════════════════════════════════════════════════════════

describe("V11 InvocationAttempt 仓储", () => {
  let ctx: FullDispatchContext;
  let invocationId: string;

  beforeEach(async () => {
    ctx = await seedFullDispatchContext();
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });
    invocationId = invocation.id;
  });

  it("createAttempt 首次 attemptNo=1，state=queued", async () => {
    const attempt = await createAttempt({ invocationId });

    expect(attempt.invocationId).toBe(invocationId);
    expect(attempt.attemptNo).toBe(1);
    expect(attempt.attemptState).toBe("queued");
    expect(attempt.retryReasonCode).toBeNull();
    expect(attempt.checkpointRef).toBeNull();
  });

  it("createAttempt 第二次 attemptNo=2（递增）", async () => {
    await createAttempt({ invocationId });
    const second = await createAttempt({
      invocationId,
      retryReasonCode: "infra_error",
      checkpointRef: "checkpoint-001",
    });

    expect(second.attemptNo).toBe(2);
    expect(second.retryReasonCode).toBe("infra_error");
    expect(second.checkpointRef).toBe("checkpoint-001");
  });

  it("getAttemptById 存在时返回，不存在返回 null", async () => {
    const attempt = await createAttempt({ invocationId });
    const found = await getAttemptById(attempt.id);
    expect(found?.id).toBe(attempt.id);

    const notFound = await getAttemptById("nonexistent-id");
    expect(notFound).toBeNull();
  });

  it("getLatestAttempt 返回 attemptNo 最大的 Attempt", async () => {
    await createAttempt({ invocationId });
    await createAttempt({ invocationId });
    const third = await createAttempt({ invocationId });

    const latest = await getLatestAttempt(invocationId);
    expect(latest?.attemptNo).toBe(3);
    expect(latest?.id).toBe(third.id);
  });

  it("getAttemptsByInvocation 按 attemptNo 升序返回", async () => {
    await createAttempt({ invocationId });
    await createAttempt({ invocationId });
    await createAttempt({ invocationId });

    const list = await getAttemptsByInvocation(invocationId);
    expect(list).toHaveLength(3);
    expect(list[0]?.attemptNo).toBe(1);
    expect(list[1]?.attemptNo).toBe(2);
    expect(list[2]?.attemptNo).toBe(3);
  });

  it("updateAttemptState queued → running → completed 状态机", async () => {
    const attempt = await createAttempt({ invocationId });

    await db.transaction(async (tx) => {
      const running = await updateAttemptState(tx, attempt.id, "running", {
        workerRef: "worker-001",
        runtimeExecutionRef: "exec-001",
      });
      expect(running.attemptState).toBe("running");
      expect(running.workerRef).toBe("worker-001");
      expect(running.runtimeExecutionRef).toBe("exec-001");
      expect(running.startedAt).toBeDefined();
    });

    await db.transaction(async (tx) => {
      const completed = await updateAttemptState(tx, attempt.id, "completed");
      expect(completed.attemptState).toBe("completed");
      expect(completed.finishedAt).toBeDefined();
    });
  });

  it("updateAttemptState 终态 → 任何状态 → InvocationAttemptStateConflictError", async () => {
    const attempt = await createAttempt({ invocationId });

    await db.transaction(async (tx) => {
      await updateAttemptState(tx, attempt.id, "running");
    });
    await db.transaction(async (tx) => {
      await updateAttemptState(tx, attempt.id, "completed");
    });

    await expect(
      db.transaction(async (tx) => {
        await updateAttemptState(tx, attempt.id, "running");
      }),
    ).rejects.toThrow(InvocationAttemptStateConflictError);
  });

  it("updateAttemptState 不存在 → InvocationAttemptNotFoundError", async () => {
    await expect(
      db.transaction(async (tx) => {
        await updateAttemptState(tx, "nonexistent-id", "running");
      }),
    ).rejects.toThrow(InvocationAttemptNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Dispatcher 调度
// ═══════════════════════════════════════════════════════════

describe("V11 Dispatcher 调度", () => {
  it("dispatchInvocationForTurn 只消费正式 RouteResolver 的解析结果", async () => {
    const ctx = await seedFullDispatchContext();
    const commands: ResolveRouteCommand[] = [];
    const routeResolver: RouteResolver = async (command) => {
      commands.push(command);
      return {
        status: "unresolved",
        reason: "no_eligible_route",
        evaluatedCandidateCount: 1,
      };
    };

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      routeResolver,
    });

    expect(result).toEqual({ dispatched: false, reason: "no_effective_route" });
    expect(commands).toEqual([
      {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
        businessKey: { threadId: ctx.threadId },
        attributes: {},
      },
    ]);
  });

  it("dispatchInvocationForTurn 完整链路：Invocation + Binding + Attempt + Turn→queued", async () => {
    const ctx = await seedFullDispatchContext();

    const result = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });

    expect(result.dispatched).toBe(true);
    expect(result.invocation).toBeDefined();
    expect(result.binding).toBeDefined();
    expect(result.attempt).toBeDefined();
    expect(result.turn).toBeDefined();

    // Invocation 验证
    expect(result.invocation?.turnId).toBe(ctx.turnId);
    expect(result.invocation?.threadId).toBe(ctx.threadId);
    expect(result.invocation?.invocationKind).toBe("initial");
    expect(result.invocation?.executionState).toBe("queued");

    // ExecutionBinding 验证
    expect(result.binding?.invocationId).toBe(result.invocation?.id);
    expect(result.binding?.agentRevisionId).toBe(ctx.agentRevision.id);
    expect(result.binding?.runtimeRevisionId).toBe(ctx.runtimeRevision.id);
    expect(result.binding?.deploymentRouteId).toBe(ctx.routeId);
    expect(result.binding).toMatchObject({
      routeRevisionId: result.routeResolution?.routeRevisionId,
      routeActivationId: result.routeResolution?.routeActivationId,
      routeContentDigest: result.routeResolution?.routeContentDigest,
      resolutionInputDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      agentArtifactDigest: ctx.agentRevision.artifactDigest,
      runtimeArtifactDigest: ctx.runtimeRevision.artifactDigest,
      runtimeConfigDigest: ctx.runtimeRevision.configHash,
      capabilityManifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      agentAttestationIds: [ctx.agentAttestationId],
      runtimeAttestationIds: [ctx.runtimeAttestationId],
      agentPublicationRecordId: ctx.agentPublicationRecordId,
      runtimePublicationRecordId: ctx.runtimePublicationRecordId,
      conformanceRunId: ctx.conformanceRunId,
    });

    // Attempt 验证
    expect(result.attempt?.invocationId).toBe(result.invocation?.id);
    expect(result.attempt?.attemptNo).toBe(1);
    expect(result.attempt?.attemptState).toBe("queued");

    // Turn 状态变为 queued
    expect(result.turn?.turnState).toBe("queued");
    expect(result.turn?.activeInvocationId).toBe(result.invocation?.id);
    expect(result.turn?.latestInvocationId).toBe(result.invocation?.id);

    // 事件写入
    expect(result.invocationQueuedEvent?.eventType).toBe("invocation.queued");
    expect(result.turnQueuedEvent?.eventType).toBe("turn.queued");
  });

  it("Resolver 后发生撤回时拒绝创建新的 ExecutionBinding", async () => {
    const ctx = await seedFullDispatchContext();
    const routeResolver = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });
    const staleOutcome = await routeResolver({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
      businessKey: { threadId: ctx.threadId },
    });
    expect(staleOutcome.status).toBe("resolved");
    await db.insert(withdrawalRecord).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      publicationRecordId: ctx.runtimePublicationRecordId,
      subjectType: "runtime_revision",
      subjectRevisionId: ctx.runtimeRevision.id,
      reasonCode: "security",
      reason: "binding race test",
      withdrawnByType: "system",
      withdrawnBy: "dispatcher-test",
      withdrawnAt: new Date(),
    });

    await expect(
      dispatchInvocationForTurn({
        tenantId: ctx.tenantId,
        turnId: ctx.turnId,
        routeResolver: async () => staleOutcome,
      }),
    ).rejects.toThrow(/ExecutionBinding.*控制面证据/);
    const invocations = await getInvocationsByTurn(ctx.tenantId, ctx.turnId);
    expect(invocations).toHaveLength(1);
    await expect(
      getExecutionBindingByInvocation(ctx.tenantId, invocations[0]?.id ?? ""),
    ).resolves.toBeNull();
  });

  it("同一 Invocation 并发绑定只有一个权威结果", async () => {
    const ctx = await seedFullDispatchContext();
    const { invocation } = await createInvocation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationKind: "initial",
    });
    const outcome = await createResolveRoute({ store: mysqlRouteEligibilityResolutionStore })({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
      businessKey: { threadId: ctx.threadId },
    });
    if (outcome.status !== "resolved") throw new Error("测试路由未解析");
    const resolution = outcome.resolution;
    const command = {
      invocationId: invocation.id,
      tenantId: ctx.tenantId,
      agentRevisionId: resolution.agentRevisionId,
      runtimeRevisionId: resolution.runtimeRevisionId,
      deploymentRouteId: resolution.deploymentRouteId,
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
      initialEnvironmentLeaseId: null,
      workspaceBindingId: null,
      policyRevisionId: resolution.policyRevisionId,
      contextCheckpointId: null,
      environmentDefinitionRevisionId: null,
      controlPlaneEvidence: {
        routeRevisionId: resolution.routeRevisionId,
        routeActivationId: resolution.routeActivationId,
        routeContentDigest: resolution.routeContentDigest,
        resolutionInputDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ...resolution.controlPlaneEvidence,
      },
    };
    const createBinding = createCreateExecutionBinding({ store: mysqlExecutionBindingStore });

    const results = await Promise.allSettled([createBinding(command), createBinding(command)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(StableExecutionBindingAlreadyExistsError),
    });
    await expect(
      getExecutionBindingByInvocation(ctx.tenantId, invocation.id),
    ).resolves.toMatchObject({
      routeRevisionId: resolution.routeRevisionId,
      runtimePublicationRecordId: resolution.controlPlaneEvidence.runtimePublicationRecordId,
    });
  });

  it("发布撤回不会改写已创建 Binding 的历史证据", async () => {
    const ctx = await seedFullDispatchContext();
    const result = await dispatchInvocationForTurn({ tenantId: ctx.tenantId, turnId: ctx.turnId });
    const invocationId = result.invocation?.id;
    if (!invocationId || !result.binding) throw new Error("测试 Binding 未创建");
    const frozen = {
      routeRevisionId: result.binding.routeRevisionId,
      routeActivationId: result.binding.routeActivationId,
      agentArtifactDigest: result.binding.agentArtifactDigest,
      runtimeArtifactDigest: result.binding.runtimeArtifactDigest,
      agentPublicationRecordId: result.binding.agentPublicationRecordId,
      runtimePublicationRecordId: result.binding.runtimePublicationRecordId,
      conformanceRunId: result.binding.conformanceRunId,
      configHash: result.binding.configHash,
    };
    await db.insert(withdrawalRecord).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      publicationRecordId: ctx.runtimePublicationRecordId,
      subjectType: "runtime_revision",
      subjectRevisionId: ctx.runtimeRevision.id,
      reasonCode: "security",
      reason: "history freeze test",
      withdrawnByType: "system",
      withdrawnBy: "dispatcher-test",
      withdrawnAt: new Date(),
    });

    await expect(
      getExecutionBindingByInvocation(ctx.tenantId, invocationId),
    ).resolves.toMatchObject(frozen);
  });

  it("dispatchInvocationForTurn 无有效路由 → Turn 保持 accepted（不报错）", async () => {
    const { tenantId, ownerId } = await seedTenantAndOwner();
    const { agent } = await seedPublishedAgentRevision(
      tenantId,
      ownerId,
      "no-route-agent",
      ["event_stream"],
      "v1",
    );

    const { thread } = await createThread({
      tenantId,
      ownerUserId: ownerId,
      primaryAgentId: agent.id,
      actorId: ownerId,
    });

    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: ownerId,
      content: { text: "无路由测试" },
      actorId: ownerId,
    });

    const result = await dispatchInvocationForTurn({
      tenantId,
      turnId: turn.id,
    });

    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("no_effective_route");
    expect(result.invocation).toBeUndefined();
    expect(result.binding).toBeUndefined();
    expect(result.attempt).toBeUndefined();
  });

  it("dispatchInvocationForTurn Turn 不在 accepted 状态 → DispatchTurnStateError", async () => {
    const ctx = await seedFullDispatchContext();

    // 先调度一次（Turn → queued）
    await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });

    // 再次调度（Turn 已是 queued）
    await expect(
      dispatchInvocationForTurn({
        tenantId: ctx.tenantId,
        turnId: ctx.turnId,
      }),
    ).rejects.toThrow(DispatchTurnStateError);
  });

  it("dispatchInvocationForTurn Turn 不存在 → DispatchTurnStateError", async () => {
    const ctx = await seedFullDispatchContext();

    await expect(
      dispatchInvocationForTurn({
        tenantId: ctx.tenantId,
        turnId: "nonexistent-turn-id",
      }),
    ).rejects.toThrow(DispatchTurnStateError);
  });

  it("dispatchInvocationForTurn 跨租户 → DispatchTurnStateError（Turn 不可见）", async () => {
    const ctx = await seedFullDispatchContext();

    await expect(
      dispatchInvocationForTurn({
        tenantId: "11111111-1111-4111-8111-111111111111",
        turnId: ctx.turnId,
      }),
    ).rejects.toThrow(DispatchTurnStateError);
  });

  it("dispatchInvocationForTurn 从 AgentRevision.modelPolicyJson 提取模型信息写入 Binding", async () => {
    const { tenantId, ownerId } = await seedTenantAndOwner();

    // 使用自定义模型策略
    const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
      tenantId,
      ownerId,
      "custom-model-agent",
      ["event_stream"],
      "v2",
      { default: "gpt-4o", provider: "openai", revision: "2024-08" },
    );

    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "openai-hosted",
      ["event_stream"],
      "v2",
    );

    const routeSet = await createRouteSet({
      tenantId,
      agentId: agent.id,
      routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
      routeScopeJson: {},
    });

    const routeResult = await upsertDeploymentRoute({
      tenantId,
      routeSetId: routeSet.id,
      routeSetExpectedVersionNo: 1,
      agentRevisionId: agentRevision.id,
      runtimeRevisionId: runtimeRevision.id,
      trafficWeight: MAX_TRAFFIC_WEIGHT,
      actor: buildActor(tenantId, "deploy-bot-001"),
    });

    const { thread } = await createThread({
      tenantId,
      ownerUserId: ownerId,
      primaryAgentId: agent.id,
      actorId: ownerId,
    });

    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: ownerId,
      content: { text: "自定义模型测试" },
      actorId: ownerId,
    });

    const result = await dispatchInvocationForTurn({
      tenantId,
      turnId: turn.id,
    });

    expect(result.dispatched).toBe(true);
    expect(result.binding?.modelProvider).toBe("openai");
    expect(result.binding?.modelId).toBe("gpt-4o");
    expect(result.binding?.modelRevisionRef).toBe("2024-08");
    expect(result.binding?.deploymentRouteId).toBe(routeResult.route.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 路由解析与有效路由查询
// ═══════════════════════════════════════════════════════════

describe("V11 路由解析与有效路由查询", () => {
  it("listEnabledRouteProjections 返回 enabled 路由", async () => {
    const ctx = await seedFullDispatchContext();

    const routes = await listEnabledRouteProjections(
      ctx.tenantId,
      ctx.agentId,
      DEFAULT_ROUTE_SCOPE_KEY,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routeState).toBe("enabled");
    expect(routes[0]?.agentRevisionId).toBe(ctx.agentRevision.id);
  });

  it("listEnabledRouteProjections 跨租户返回空", async () => {
    const ctx = await seedFullDispatchContext();

    const routes = await listEnabledRouteProjections(
      "11111111-1111-4111-8111-111111111111",
      ctx.agentId,
      DEFAULT_ROUTE_SCOPE_KEY,
    );
    expect(routes).toHaveLength(0);
  });
});
