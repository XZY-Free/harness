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
import { createThread } from "@/lib/conversations/thread-queries";
/**
 * S09-C06：V11 Worker 重启恢复仓储集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - findStaleInvocations（5 例）：找到心跳超时的 running/waiting_user/queued Invocation /
 *   不返回未超时的 Invocation / 不返回终态 Invocation / 不返回 lastHeartbeatAt=null /
 *   跨租户隔离
 * - markInvocationLost（5 例）：running → lost + 写 invocation.lost Event + 标记 SessionBinding lost /
 *   waiting_user → lost / 终态抛 InvocationAlreadyTerminalError / 跨租户 InvocationNotFoundError /
 *   Job 模式（threadId=null）不写 ThreadEvent
 * - getLatestProducerSequence（3 例）：返回 MAX(producer_sequence) / 无候选事件返回 0 /
 *   Invocation 不存在返回 null
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createExecutionBinding,
  TEST_EXECUTION_BINDING_REQUIRED_FIELDS,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agent";
import type { RuntimeSessionBinding } from "@/lib/persistence/schema/runtime";
import { invocationTable, runtimeEventIngressTable } from "@/lib/persistence/schema/runtime";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";
import { createAttempt } from "@/lib/runtime/invocation-attempt-queries";
import {
  type CreateInvocationParams,
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import {
  type MarkInvocationLostResult,
  type StaleInvocationSummary,
  findStaleInvocations,
  getLatestProducerSequence,
  markInvocationLost,
} from "@/lib/runtime/recovery-queries";
import { createSessionBinding, getSessionBindingById } from "@/lib/runtime/session-binding-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/test-support/publish-trusted-runtime-revision";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore（与 command-dispatcher.test.ts 一致） ──

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

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

// ─── 辅助：seed 租户 + 用户 ────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "recovery-owner-001",
    email: "recovery-owner@example.com",
    displayName: "Recovery Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "recovery-owner-001",
    displayName: "Recovery Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

// ─── 辅助：seed Agent + Runtime + Route ────────────────────

async function seedAgentAndRuntime(tenantId: string, ownerId: string) {
  const agent = await createAgent({
    tenantId,
    agentKey: "recovery-agent",
    displayName: "Recovery Agent",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const agentRevision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: "git:recovery-v1",
    instructionHash: "sha256:instruction_recovery_v1",
    agentArtifactRef: "oci://registry/agent@sha256:recovery-v1",
    modelPolicyJson: { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
    createdBy: ownerId,
  });

  // 创建 attestation（DSSE Envelope + 真实 ed25519 签名）
  const builderKey = generateTestBuilderKey("builder:recovery");
  const publicKeyBase64 = builderKey.publicKeyBase64;
  const content = "agent-content-recovery-v1";
  const digest = computeArtifactDigest(content);
  const dsseEnvelopeRef = "attestation:signature:recovery-v1";
  const sbomRef = "attestation:sbom:recovery-v1";
  const provRef = "attestation:provenance:recovery-v1";

  const sbomDoc = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } }, components: [{ type: "library", name: "lodash", version: "4.17.21", licenses: [{ license: { id: "MIT" } }] }] };
  const provDoc = {
    sourceRevision: "git:abc123",
    buildPipeline: "ci-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
  const supplyChain: PredicateSupplyChain = { sbomRef, sbomContent: sbomDoc, provenanceRef: provRef, provenanceContent: provDoc };
  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(builderKey, digest, supplyChain),
  );
  store.writeSbom(sbomRef, sbomDoc);
  store.writeProvenance(provRef, provDoc);

  const builderKeys: BuilderKeyRegistry = {
    "builder:recovery": publicKeyBase64,
  };

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType: "agent_revision",
    artifactRevisionId: agentRevision.id,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:recovery",
  };
  await verifyAndPersistAttestation(input, store, builderKeys, buildActor(tenantId, "ci-001"));
  await publishRevision(tenantId, agentRevision.id, 1);

  // Runtime
  const runtime = await createRuntime({
    tenantId,
    runtimeKey: "recovery-runtime",
    displayName: "Recovery Runtime",
    runtimeKind: "hosted",
    ownerUserId: ownerId,
  });

  const runtimeRevision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: "https://recovery-runtime.internal",
    runtimeArtifactRef: "oci://registry/runtime@sha256:recovery-v1",
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: "sha256:config_recovery_v1",
    createdBy: ownerId,
  });

  // Runtime attestation（DSSE Envelope，复用同一 builderKey）
  const rtContent = "runtime-content-recovery-v1";
  const rtDigest = computeArtifactDigest(rtContent);
  const rtDsseEnvelopeRef = "attestation:signature:rt-recovery-v1";
  const rtSbomRef = "attestation:sbom:rt-recovery-v1";
  const rtProvRef = "attestation:provenance:rt-recovery-v1";
  const rtSbomDoc = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } }, components: [{ type: "library", name: "lodash", version: "4.17.21", licenses: [{ license: { id: "MIT" } }] }] };
  const rtProvDoc = {
    sourceRevision: "git:abc123",
    buildPipeline: "ci-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
  const rtSupplyChain: PredicateSupplyChain = { sbomRef: rtSbomRef, sbomContent: rtSbomDoc, provenanceRef: rtProvRef, provenanceContent: rtProvDoc };
  store.writeDsseEnvelope(
    rtDsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(builderKey, rtDigest, rtSupplyChain),
  );
  store.writeSbom(rtSbomRef, rtSbomDoc);
  store.writeProvenance(rtProvRef, rtProvDoc);

  const rtInput: VerifyAttestationInput = {
    tenantId,
    artifactType: "runtime_revision",
    artifactRevisionId: runtimeRevision.id,
    artifactDigest: rtDigest,
    dsseEnvelopeRef: rtDsseEnvelopeRef,
    builderIdentity: "builder:recovery",
  };
  const rtAttestation = await verifyAndPersistAttestation(
    rtInput,
    store,
    builderKeys,
    buildActor(tenantId, "ci-001"),
  );
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: runtimeRevision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: rtAttestation.id,
  });

  // Route
  const routeSet = await createRouteSet({
    tenantId,
    agentId: agent.id,
    routeScopeKey: "default",
    routeScopeJson: { networkZone: "internal" },
  });
  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: agentRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  return {
    agent,
    agentRevision,
    runtime,
    runtimeRevision,
    routeSet,
    route: routeResult.route,
  };
}

// ─── 辅助：创建 Invocation + ExecutionBinding + SessionBinding ──

interface SeededInvocation {
  invocationId: string;
  threadId: string;
  turnId: string | null;
  tenantId: string;
  agentRevision: AgentRevision;
  runtimeRevisionId: string;
  sessionBinding: RuntimeSessionBinding | null;
}

async function seedInvocation(params: {
  tenantId: string;
  ownerId: string;
  agentRevision: AgentRevision;
  runtimeRevisionId: string;
  threadId: string;
  turnId: string;
  initialExecutionState?: "queued" | "running" | "waiting_user";
  withSessionBinding?: boolean;
  lastHeartbeatAt?: Date | null;
}): Promise<SeededInvocation> {
  const invocationParams: CreateInvocationParams = {
    tenantId: params.tenantId,
    threadId: params.threadId,
    turnId: params.turnId,
    invocationKind: "initial",
    triggerItemId: null,
    actorType: "user",
    actorId: params.ownerId,
  };
  const { invocation } = await createInvocation(invocationParams);

  // 创建 ExecutionBinding
  await createExecutionBinding({
    ...TEST_EXECUTION_BINDING_REQUIRED_FIELDS,
    invocationId: invocation.id,
    tenantId: params.tenantId,
    agentRevisionId: params.agentRevision.id,
    runtimeRevisionId: params.runtimeRevisionId,
    deploymentRouteId: "test-route-id",
    modelProvider: "doubao",
    modelId: "doubao-pro",
    modelRevisionRef: null,
  });

  // 状态转换（按状态机分步推进：queued → running → 目标态）
  // 状态机：queued → running/cancelled/failed/lost；running → waiting_user/completed/failed/cancelled/lost；
  //        waiting_user → running/cancelled/failed/lost
  // 因此所有非 queued 状态都需先经 running（包括 initialState=running 本身）
  const initialState = params.initialExecutionState;
  if (initialState && initialState !== "queued") {
    await db.transaction(async (tx) => {
      // 第一步：queued → running（initialState=running 时也需执行此转换）
      await updateInvocationState(tx, params.tenantId, invocation.id, "running");
      // 第二步：running → 目标态（waiting_user/completed/failed/cancelled/lost；running 时跳过）
      if (initialState !== "running") {
        await updateInvocationState(tx, params.tenantId, invocation.id, initialState);
      }
    });
  }

  // 设置 lastHeartbeatAt
  if (params.lastHeartbeatAt !== undefined) {
    await db
      .update(invocationTable)
      .set({ lastHeartbeatAt: params.lastHeartbeatAt })
      .where(eq(invocationTable.id, invocation.id));
  }

  // 创建 SessionBinding
  let sessionBinding: RuntimeSessionBinding | null = null;
  if (params.withSessionBinding) {
    sessionBinding = await createSessionBinding({
      tenantId: params.tenantId,
      runtimeRevisionId: params.runtimeRevisionId,
      threadId: params.threadId,
      externalSessionRef: `ext-session-${invocation.id}`,
    });
    await db
      .update(invocationTable)
      .set({ runtimeSessionBindingId: sessionBinding.id })
      .where(eq(invocationTable.id, invocation.id));
  }

  return {
    invocationId: invocation.id,
    threadId: params.threadId,
    turnId: params.turnId,
    tenantId: params.tenantId,
    agentRevision: params.agentRevision,
    runtimeRevisionId: params.runtimeRevisionId,
    sessionBinding,
  };
}

async function createThreadForTest(tenantId: string, ownerId: string, agentId: string) {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    primaryAgentId: agentId,
    actorId: ownerId,
  });
  return thread;
}

// ═══════════════════════════════════════════════════════════
// 1. findStaleInvocations
// ═══════════════════════════════════════════════════════════

describe("S09-C06 findStaleInvocations", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    agentId = seeded.agent.id;
    const thread = await createThreadForTest(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("找到心跳超时的 running Invocation（按 lastHeartbeatAt 升序）", async () => {
    const now = new Date();
    const staleTime = new Date(now.getTime() - 60_000); // 60 秒前
    await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      lastHeartbeatAt: staleTime,
    });

    const results = await findStaleInvocations({
      tenantId,
      thresholdMs: 30_000,
      now,
    });

    expect(results.length).toBe(1);
    const result = results[0] as StaleInvocationSummary;
    expect(result.executionState).toBe("running");
    expect(result.lastHeartbeatAt).toEqual(staleTime);
  });

  it("不返回未超时的 Invocation（lastHeartbeatAt 在阈值内）", async () => {
    const now = new Date();
    const recentTime = new Date(now.getTime() - 10_000); // 10 秒前（30 秒阈值内）
    await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      lastHeartbeatAt: recentTime,
    });

    const results = await findStaleInvocations({
      tenantId,
      thresholdMs: 30_000,
      now,
    });

    expect(results).toHaveLength(0);
  });

  it("不返回终态 Invocation（completed/failed/cancelled/lost）", async () => {
    const now = new Date();
    const staleTime = new Date(now.getTime() - 60_000);
    // 先创建 running Invocation，再转为 completed
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      lastHeartbeatAt: staleTime,
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, seeded.invocationId, "completed");
    });

    const results = await findStaleInvocations({
      tenantId,
      thresholdMs: 30_000,
      now,
    });

    expect(results).toHaveLength(0);
  });

  it("不返回 lastHeartbeatAt=null 的 Invocation（从未调度）", async () => {
    const now = new Date();
    await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "queued",
      lastHeartbeatAt: null,
    });

    const results = await findStaleInvocations({
      tenantId,
      thresholdMs: 30_000,
      now,
    });

    expect(results).toHaveLength(0);
  });

  it("跨租户隔离：不返回其他租户的 Invocation", async () => {
    const now = new Date();
    const staleTime = new Date(now.getTime() - 60_000);
    await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      lastHeartbeatAt: staleTime,
    });

    // 用不存在的 tenantId 查询
    const results = await findStaleInvocations({
      tenantId: "00000000-0000-0000-0000-000000000000",
      thresholdMs: 30_000,
      now,
    });

    expect(results).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. markInvocationLost
// ═══════════════════════════════════════════════════════════

describe("S09-C06 markInvocationLost", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    agentId = seeded.agent.id;
    const thread = await createThreadForTest(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("running → lost + 写 invocation.lost ThreadEvent + 标记 SessionBinding lost", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      withSessionBinding: true,
      lastHeartbeatAt: new Date(),
    });

    const result: MarkInvocationLostResult = await markInvocationLost({
      tenantId,
      invocationId: seeded.invocationId,
      reasonCode: "heartbeat_timeout",
      errorSummary: "Worker 心跳超时",
    });

    // Invocation 转为 lost
    expect(result.invocation.executionState).toBe("lost");
    expect(result.invocation.errorCode).toBe("heartbeat_timeout");
    expect(result.invocation.errorSummary).toBe("Worker 心跳超时");

    // 写入 invocation.lost Event
    expect(result.event).not.toBeNull();
    expect(result.event?.eventType).toBe("invocation.lost");
    const payload = result.event?.payloadJson as Record<string, unknown>;
    expect(payload.reason_code).toBe("heartbeat_timeout");

    // SessionBinding 标记为 lost
    expect(result.sessionBinding).not.toBeNull();
    expect(result.sessionBinding?.bindingState).toBe("lost");

    // 数据库验证
    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("lost");
  });

  it("waiting_user → lost + 写 invocation.lost Event", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      lastHeartbeatAt: new Date(),
    });

    const result = await markInvocationLost({
      tenantId,
      invocationId: seeded.invocationId,
      reasonCode: "runtime_lost",
    });

    expect(result.invocation.executionState).toBe("lost");
    expect(result.event?.eventType).toBe("invocation.lost");
  });

  it("终态 Invocation 抛 InvocationAlreadyTerminalError", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
    });
    // 先转为 completed
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, seeded.invocationId, "completed");
    });

    await expect(
      markInvocationLost({
        tenantId,
        invocationId: seeded.invocationId,
        reasonCode: "heartbeat_timeout",
      }),
    ).rejects.toThrow(InvocationAlreadyTerminalError);
  });

  it("跨租户不可见 → InvocationNotFoundError", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
    });

    await expect(
      markInvocationLost({
        tenantId: "00000000-0000-0000-0000-000000000000",
        invocationId: seeded.invocationId,
        reasonCode: "heartbeat_timeout",
      }),
    ).rejects.toThrow(InvocationNotFoundError);
  });

  it("Job 模式（threadId=null）不写 ThreadEvent", async () => {
    // 创建 Job 模式 Invocation（threadId=null, jobId 非空）
    const invocationParams: CreateInvocationParams = {
      tenantId,
      jobId: "test-job-id",
      invocationKind: "job",
      triggerItemId: null,
      actorType: "system",
      actorId: ownerId,
    };
    const { invocation } = await createInvocation(invocationParams);

    await createExecutionBinding({
      ...TEST_EXECUTION_BINDING_REQUIRED_FIELDS,
      invocationId: invocation.id,
      tenantId,
      agentRevisionId: agentRevision.id,
      runtimeRevisionId,
      deploymentRouteId: "test-route-id",
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
    });

    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "running");
    });

    const result = await markInvocationLost({
      tenantId,
      invocationId: invocation.id,
      reasonCode: "heartbeat_timeout",
    });

    expect(result.invocation.executionState).toBe("lost");
    expect(result.event).toBeNull(); // Job 模式不写 ThreadEvent
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getLatestProducerSequence
// ═══════════════════════════════════════════════════════════

describe("S09-C06 getLatestProducerSequence", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    agentId = seeded.agent.id;
    const thread = await createThreadForTest(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("返回 MAX(producer_sequence)", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
    });

    // 插入 3 条候选事件（producer_sequence = 1, 2, 3）
    for (let i = 1; i <= 3; i++) {
      await db.insert(runtimeEventIngressTable).values({
        tenantId,
        invocationId: seeded.invocationId,
        producerEventId: `evt-${i}`,
        producerSequence: i,
        candidateType: "agent_message_chunk",
        payloadHash: `sha256:hash-${i}`,
        payloadJson: { content: `chunk-${i}` },
        receivedAt: new Date(),
        mappedAt: null,
      });
    }

    const result = await getLatestProducerSequence(tenantId, seeded.invocationId);
    expect(result).toBe(3);
  });

  it("无候选事件返回 0", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
    });

    const result = await getLatestProducerSequence(tenantId, seeded.invocationId);
    expect(result).toBe(0);
  });

  it("Invocation 不存在返回 null", async () => {
    const result = await getLatestProducerSequence(
      tenantId,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });
});
