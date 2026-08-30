/**
 * S09-C06：Worker 重启恢复仓储集成测试（真实 MySQL 8）。
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
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { createDraftRevisionWithContractSnapshot } from "@/lib/agents/test-support/create-draft-revision-with-contract";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import {
  type PredicateSupplyChain,
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  TEST_EXECUTION_BINDING_REQUIRED_FIELDS,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agents";
import { threadEventTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import type { Turn } from "@/lib/persistence/schema/conversation";
import type { RuntimeSessionBinding } from "@/lib/persistence/schema/executions";
import { invocationTable, runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { resolveTurnControls } from "@/lib/runtime/capabilities/turn-controls";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";
import { createAttempt } from "@/lib/runtime/invocation-attempt-queries";
import {
  type CreateInvocationParams,
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  type MarkInvocationLostResult,
  type StaleInvocationSummary,
  findStaleInvocations,
  getLatestProducerSequence,
  markInvocationLost,
} from "@/lib/runtime/recovery-queries";
import { createSessionBinding, getSessionBindingById } from "@/lib/runtime/session-binding-queries";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
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

  const agentRevision = await createDraftRevisionWithContractSnapshot({
    tenantId,
    agentId: agent.id,
    modelPolicyJson: { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
    createdBy: ownerId,
  });

  // Agent 是源码不可见黑盒：发布权威 = AgentContractSnapshot，无 Attestation。
  await publishRevision(tenantId, agentRevision.id, 1);

  // Runtime
  const runtime = await createRuntime({
    tenantId,
    runtimeKey: "recovery-runtime",
    displayName: "Recovery Runtime",
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const runtimeRevision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: "https://recovery-runtime.internal",
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest("runtime-content-recovery-v1")}`,
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: computeArtifactDigest("runtime-config-recovery-v1"),
    createdBy: ownerId,
  });

  // Runtime attestation builder（DSSE Envelope + 真实 ed25519 签名）
  const builderKey = generateTestBuilderKey("builder:recovery");
  const builderKeys: BuilderKeyRegistry = {
    "builder:recovery": builderKey.publicKeyBase64,
  };
  const store = new InMemoryManagedArtifactStore();

  const rtContent = "runtime-content-recovery-v1";
  const rtDigest = computeArtifactDigest(rtContent);
  const rtDsseEnvelopeRef = "attestation:signature:rt-recovery-v1";
  const rtSbomRef = "attestation:sbom:rt-recovery-v1";
  const rtProvRef = "attestation:provenance:rt-recovery-v1";
  const rtSbomDoc = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };
  const rtProvDoc = {
    buildPipeline: "ci-1",
    sourceRevision: "git_commit_1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
  const rtSupplyChain: PredicateSupplyChain = {
    sbomRef: rtSbomRef,
    sbomContent: rtSbomDoc,
    provenanceRef: rtProvRef,
    provenanceContent: rtProvDoc,
  };
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
  await publishRuntimeRevisionForTest({
    tenantId,
    revisionId: runtimeRevision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: rtAttestation.id,
  });

  // Route — agent target（RouteSet target={kind:"agent",agentId}，RouteRevision 只携带 Agent 事实，不携带 runtimeRevisionId）。
  const routeSet = await createRouteSet({
    tenantId,
    target: { kind: "agent", agentId: agent.id },
    routeScopeKey: "default",
    routeScopeJson: { networkZone: "internal" },
  });
  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: {
      kind: "agent",
      agentRevisionId: agentRevision.id,
      agentEndpointRef: "https://agent.example.com/a2a",
      agentIdentityMode: "bearer",
      agentCredentialRefId: "cred-1",
      agentNetworkZone: "private",
    },
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
    expect(result.invocationLostEvent).not.toBeNull();
    expect(result.invocationLostEvent?.eventType).toBe("invocation.lost");
    const payload = result.invocationLostEvent?.payloadJson as Record<string, unknown>;
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
    expect(result.invocationLostEvent?.eventType).toBe("invocation.lost");
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
    expect(result.invocationLostEvent).toBeNull(); // Job 模式不写 ThreadEvent
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
        candidateType: "assistant_message_chunk",
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

// ═══════════════════════════════════════════════════════════
// 02 专项：Recovery 与 Turn 终态事务一致性
// ═══════════════════════════════════════════════════════════

describe("02 专项 Recovery 与 Turn 终态事务一致性", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let threadId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    const thread = await createThreadForTest(tenantId, ownerId, seeded.agent.id);
    threadId = thread.id;
  });

  /** 创建真实 Turn 行（running + activeInvocationId 指向 invocation）。 */
  async function createRunningTurnForInvocation(
    invocationId: string,
    activeInvocationId: string | null,
  ): Promise<string> {
    const turnId = randomUUID();
    await db.insert(turnTable).values({
      id: turnId,
      threadId,
      turnSequence: 1,
      triggerType: "user_message",
      turnState: "running",
      activeInvocationId,
      latestInvocationId: activeInvocationId,
      acceptedAt: new Date(),
      startedAt: new Date(),
    });
    return turnId;
  }

  it("active Invocation lost → 同一事务：Invocation lost + Session lost + Turn failed + invocation.lost/turn.failed 两个 Event 连续", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-pending",
      initialExecutionState: "running",
      withSessionBinding: true,
      lastHeartbeatAt: new Date(Date.now() - 10_000),
    });
    const turnId = await createRunningTurnForInvocation(seeded.invocationId, seeded.invocationId);
    // 修正 invocation.turnId 指向真实 Turn
    await db
      .update(invocationTable)
      .set({ turnId })
      .where(eq(invocationTable.id, seeded.invocationId));

    const result = await markInvocationLost({
      tenantId,
      invocationId: seeded.invocationId,
      reasonCode: "heartbeat_timeout",
      errorSummary: "Worker 心跳超时",
    });

    expect(result.invocation.executionState).toBe("lost");
    expect(result.sessionBinding?.bindingState).toBe("lost");
    expect(result.invocationLostEvent?.eventType).toBe("invocation.lost");
    expect(result.turnFailedEvent?.eventType).toBe("turn.failed");

    // Turn → failed + activeInvocationId 清空 + errorCode/finishedAt
    const [turnRow] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
    expect(turnRow?.turnState).toBe("failed");
    expect(turnRow?.activeInvocationId).toBeNull();
    expect(turnRow?.latestInvocationId).toBe(seeded.invocationId);
    expect(turnRow?.errorCode).toBe("heartbeat_timeout");
    expect(turnRow?.finishedAt).not.toBeNull();

    // 两个 Event sequence 连续
    expect(
      result.turnFailedEvent && result.invocationLostEvent
        ? result.turnFailedEvent.eventSequence - result.invocationLostEvent.eventSequence
        : 99,
    ).toBe(1);
  });

  it("lost Invocation 不是 active（superseded）→ 只把 Invocation lost，不改 Turn", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-pending",
      initialExecutionState: "running",
      lastHeartbeatAt: new Date(),
    });
    // Turn 当前 active 是另一个 Invocation B
    const otherInvocationId = randomUUID();
    const turnId = await createRunningTurnForInvocation(seeded.invocationId, otherInvocationId);
    await db
      .update(invocationTable)
      .set({ turnId })
      .where(eq(invocationTable.id, seeded.invocationId));

    const result = await markInvocationLost({
      tenantId,
      invocationId: seeded.invocationId,
      reasonCode: "runtime_lost",
    });

    expect(result.invocation.executionState).toBe("lost");
    expect(result.turnFailedEvent).toBeNull();
    const [turnRow] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
    expect(turnRow?.turnState).toBe("running");
    expect(turnRow?.activeInvocationId).toBe(otherInvocationId);
  });

  it("事务故障注入：Event 写入失败 → Invocation/Session/Turn 全部回滚", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-pending",
      initialExecutionState: "running",
      withSessionBinding: true,
      lastHeartbeatAt: new Date(),
    });
    const turnId = await createRunningTurnForInvocation(seeded.invocationId, seeded.invocationId);
    await db
      .update(invocationTable)
      .set({ turnId })
      .where(eq(invocationTable.id, seeded.invocationId));

    // 预先在同 thread 写入一个占用 idempotencyKey 的 Event → invocation.lost insert 唯一冲突
    const conflictKey = "recovery-tx-inject";
    const [threadRow] = await db
      .select({ lastEventSequence: threadTable.lastEventSequence })
      .from(threadTable)
      .where(eq(threadTable.id, threadId))
      .limit(1);
    const conflictSeq = (threadRow?.lastEventSequence ?? 0) + 1;
    await db.insert(threadEventTable).values({
      id: randomUUID(),
      threadId,
      eventSequence: conflictSeq,
      eventType: "turn.queued",
      schemaVersion: 1,
      turnId,
      actorType: "system",
      payloadJson: {},
      idempotencyKey: conflictKey,
      occurredAt: new Date(),
      ingestedAt: new Date(),
    });

    await expect(
      markInvocationLost({
        tenantId,
        invocationId: seeded.invocationId,
        reasonCode: "heartbeat_timeout",
        idempotencyKey: conflictKey,
      }),
    ).rejects.toThrow();

    // 全部回滚：Invocation 仍 running、Session 仍 active、Turn 仍 running
    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("running");
    const [turnRow] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
    expect(turnRow?.turnState).toBe("running");
    expect(turnRow?.activeInvocationId).toBe(seeded.invocationId);
    if (seeded.sessionBinding) {
      const sb = await getSessionBindingById(tenantId, seeded.sessionBinding.id);
      expect(sb?.bindingState).toBe("active");
    }
  });

  it("Turn 客户端投影：Invocation lost → turn_state=failed → controls.cancel_supported=false", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-pending",
      initialExecutionState: "running",
      withSessionBinding: true,
      lastHeartbeatAt: new Date(),
    });
    const turnId = await createRunningTurnForInvocation(seeded.invocationId, seeded.invocationId);
    await db
      .update(invocationTable)
      .set({ turnId })
      .where(eq(invocationTable.id, seeded.invocationId));

    await markInvocationLost({
      tenantId,
      invocationId: seeded.invocationId,
      reasonCode: "runtime_lost",
    });

    const [turnRow] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
    expect(turnRow?.turnState).toBe("failed");
    const controls = await resolveTurnControls(tenantId, [turnRow as Turn]);
    expect(controls.get(turnId)?.cancel_supported).toBe(false);
    expect(controls.get(turnId)?.resume_supported).toBe(false);
    expect(controls.get(turnId)?.steer_supported).toBe(false);
  });

  it("重复 mark：第二次抛 InvocationAlreadyTerminalError，Event 不重复", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      threadId,
      turnId: "turn-pending",
      initialExecutionState: "running",
      lastHeartbeatAt: new Date(),
    });
    const turnId = await createRunningTurnForInvocation(seeded.invocationId, seeded.invocationId);
    await db
      .update(invocationTable)
      .set({ turnId })
      .where(eq(invocationTable.id, seeded.invocationId));

    await markInvocationLost({
      tenantId,
      invocationId: seeded.invocationId,
      reasonCode: "heartbeat_timeout",
    });
    await expect(
      markInvocationLost({
        tenantId,
        invocationId: seeded.invocationId,
        reasonCode: "heartbeat_timeout",
      }),
    ).rejects.toThrow(InvocationAlreadyTerminalError);

    const events = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.threadId, threadId));
    const lostCount = events.filter((e) => e.eventType === "invocation.lost").length;
    const turnFailedCount = events.filter((e) => e.eventType === "turn.failed").length;
    expect(lostCount).toBe(1);
    expect(turnFailedCount).toBe(1);
  });
});
