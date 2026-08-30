/**
 * S09-C06：重调度编排集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - redispatchInvocation 成功流程（4 例）：
 *   1. waiting_user → running（创建新 Attempt + 调用 Runtime + 写 invocation.started + 标记旧 binding lost + 创建新 binding）
 *   2. queued → running（无旧 SessionBinding，仍创建新 binding + 写 Event）
 *   3. 已 running 的 Invocation 不调状态机（仅更新 runtimeExecutionRef）
 *   4. 校验 attempt_no 递增 + producer_sequence_start 计算 + StartInvocationRequestBody.attempt 字段
 * - redispatchInvocation 错误处理（4 例）：
 *   5. 网络不可达 → 返回 skipped，Attempt 保持 queued
 *   6. 503 RUNTIME_UNAVAILABLE → 返回 skipped，Attempt 保持 queued
 *   7. 409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding，标记 acknowledged
 *   8. 其他 HTTP 错误（400）→ 抛出原错误
 * - redispatchInvocation 状态校验（2 例）：
 *   9. 终态 Invocation 抛 RedispatchNotAllowedError
 *   10. 跨租户 InvocationNotFoundError
 *
 * 注：Job 模式（threadId=null）的 redispatch 测试属于 S09-W03（Job 领域）范围，
 * 当前 issueContextHandle 尚未支持 Job 模式（无 threadId/triggerItemId 绑定），
 * 待 S09-W03 实现 Job 上下文句柄后再补测。
 *
 * 真实 MySQL 8 Testcontainers + 真实 mock RuntimeHttpClient，不使用 mock 数据库。
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
import { threadEventTable, threadItemTable } from "@/lib/persistence/schema/conversation";
import type { ExecutionBinding, RuntimeSessionBinding } from "@/lib/persistence/schema/executions";
import {
  invocationAttemptTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import {
  InvocationNotFoundError,
  RedispatchNotAllowedError,
  RuntimeHttpClientError,
} from "@/lib/runtime/errors";
import { createAttempt, updateAttemptState } from "@/lib/runtime/invocation-attempt-queries";
import {
  type CreateInvocationParams,
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  type RedispatchInvocationParams,
  type RedispatchResult,
  redispatchInvocation,
} from "@/lib/runtime/redispatch-queries";
import { dispatchQueuedInvocationAttempt } from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import { claimDueInvocationAttempts } from "@/lib/runtime/retry/dispatch-retry-queries";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";
import {
  type RuntimeHttpClient,
  type StartInvocationRequest,
  type StartInvocationResponse,
  createMockRuntimeClient,
} from "@/lib/runtime/runtime-client";
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

// ─── 辅助：InMemoryManagedArtifactStore（与 recovery-queries.test.ts 一致） ──

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
    externalSubject: "redispatch-owner-001",
    email: "redispatch-owner@example.com",
    displayName: "Redispatch Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "redispatch-owner-001",
    displayName: "Redispatch Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

// ─── 辅助：seed Agent + Runtime + Route（与 recovery-queries.test.ts 一致） ──

async function seedAgentAndRuntime(tenantId: string, ownerId: string) {
  const agent = await createAgent({
    tenantId,
    agentKey: "redispatch-agent",
    displayName: "Redispatch Agent",
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

  // Runtime attestation builder（DSSE Envelope + 真实 ed25519 签名）。
  // Agent 是源码不可见黑盒：发布权威 = AgentContractSnapshot，无 Attestation。
  const builderKey = generateTestBuilderKey("builder:redispatch");
  const builderKeys: BuilderKeyRegistry = {
    "builder:redispatch": builderKey.publicKeyBase64,
  };
  const store = new InMemoryManagedArtifactStore();

  await publishRevision(tenantId, agentRevision.id, 1);

  // Runtime
  const runtime = await createRuntime({
    tenantId,
    runtimeKey: "redispatch-runtime",
    displayName: "Redispatch Runtime",
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
    endpointRef: "https://redispatch-runtime.internal",
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest("runtime-content-redispatch-v1")}`,
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: computeArtifactDigest("runtime-config-redispatch-v1"),
    createdBy: ownerId,
  });

  // Runtime attestation（DSSE Envelope，复用同一 builderKey）
  const rtContent = "runtime-content-redispatch-v1";
  const rtDigest = computeArtifactDigest(rtContent);
  const rtDsseEnvelopeRef = "attestation:signature:rt-redispatch-v1";
  const rtSbomRef = "attestation:sbom:rt-redispatch-v1";
  const rtProvRef = "attestation:provenance:rt-redispatch-v1";
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
    builderIdentity: "builder:redispatch",
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

  // Route（用于 ExecutionBinding.deploymentRouteId 引用）— agent target，
  // RouteSet target={kind:"agent",agentId}，RouteRevision 只携带 Agent 事实，不携带 runtimeRevisionId。
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

// ─── 辅助：seed Invocation + ExecutionBinding +（可选）SessionBinding +（可选）Attempt ──

interface SeededInvocation {
  invocationId: string;
  threadId: string | null;
  turnId: string | null;
  jobId: string | null;
  tenantId: string;
  agentRevision: AgentRevision;
  runtimeRevisionId: string;
  binding: ExecutionBinding;
  sessionBinding: RuntimeSessionBinding | null;
}

async function seedInvocation(params: {
  tenantId: string;
  ownerId: string;
  agentRevision: AgentRevision;
  runtimeRevisionId: string;
  routeId: string;
  threadId?: string;
  turnId?: string;
  jobId?: string;
  invocationKind?: "initial" | "job";
  initialExecutionState?:
    | "queued"
    | "running"
    | "waiting_user"
    | "completed"
    | "failed"
    | "cancelled"
    | "lost";
  withSessionBinding?: boolean;
  withPriorAttempt?: boolean;
  lastHeartbeatAt?: Date | null;
}): Promise<SeededInvocation> {
  // Turn 模式（threadId 非空）：创建真实 ThreadItem 作为 triggerItem，
  // 满足 issueContextHandle 的绑定完整性要求（threadId + triggerItemId 均非空）。
  // Job 模式（threadId=null）：triggerItemId 保持 null（Job 上下文句柄属 S09-W03 范围）。
  let triggerItemId: string | null = null;
  if (params.threadId) {
    const itemId = randomUUID();
    await db.insert(threadItemTable).values({
      id: itemId,
      threadId: params.threadId,
      turnId: params.turnId ?? "turn-seed",
      itemSequence: 1,
      itemType: "user_message",
      itemState: "completed",
      authorType: "user",
      authorId: params.ownerId,
      contentJson: { text: "redispatch-test-trigger" },
      contentHash: "sha256:redispatch-test-trigger",
      contextPolicy: "include",
    });
    triggerItemId = itemId;
  }

  const invocationParams: CreateInvocationParams = {
    tenantId: params.tenantId,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? null,
    jobId: params.jobId ?? null,
    invocationKind: params.invocationKind ?? "initial",
    triggerItemId,
    actorType: "user",
    actorId: params.ownerId,
  };
  const { invocation } = await createInvocation(invocationParams);

  // 创建 ExecutionBinding（顶层 Harness Invocation 的不可变绑定，不含 Agent evidence）
  const binding = await createExecutionBinding({
    ...TEST_EXECUTION_BINDING_REQUIRED_FIELDS,
    controlPlaneEvidence: TEST_EXECUTION_BINDING_REQUIRED_FIELDS.controlPlaneEvidence,
    invocationId: invocation.id,
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    deploymentRouteId: params.routeId,
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
      threadId: params.threadId ?? null,
      jobId: params.jobId ?? null,
      externalSessionRef: `ext-session-${invocation.id}`,
    });
    await db
      .update(invocationTable)
      .set({ runtimeSessionBindingId: sessionBinding.id })
      .where(eq(invocationTable.id, invocation.id));
  }

  // 创建先前的 Attempt（attempt_no=1，已完成或运行中）
  if (params.withPriorAttempt) {
    const attempt = await createAttempt({
      invocationId: invocation.id,
      retryReasonCode: null,
      checkpointRef: null,
    });
    if (params.initialExecutionState && params.initialExecutionState !== "queued") {
      await db.transaction(async (tx) => {
        await updateAttemptState(tx, attempt.id, "running", {
          runtimeExecutionRef: "prior-exec-ref",
          startedAt: new Date(),
        });
      });
    }
  }

  return {
    invocationId: invocation.id,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? null,
    jobId: params.jobId ?? null,
    tenantId: params.tenantId,
    agentRevision: params.agentRevision,
    runtimeRevisionId: params.runtimeRevisionId,
    binding,
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

// ─── 辅助：构造 mock RuntimeHttpClient（成功响应） ──────────

function buildStartInvocationResponse(
  invocationId: string,
  attemptNo: number,
): StartInvocationResponse {
  return {
    invocation_id: invocationId,
    accepted: true,
    attempt_no: attemptNo,
    runtime_session_ref: `runtime-session-${invocationId}-${attemptNo}`,
    runtime_execution_ref: `runtime-exec-${invocationId}-${attemptNo}`,
    capabilities: {
      protocol_versions: ["2"],
      features: {
        event_stream: true,
        cancel: true,
        resume: true,
        steer: true,
        dynamic_tools: true,
        user_action: true,
        workspace_types: ["none"],
        filesystem_checkpoint: true,
      },
      limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
    },
  };
}

function buildSuccessRuntimeClient(
  invocationId: string,
  nextAttemptNo: number,
): RuntimeHttpClient & {
  calls: { startInvocation: StartInvocationRequest[] };
} {
  return createMockRuntimeClient({
    startInvocation: async (req) => buildStartInvocationResponse(invocationId, nextAttemptNo),
  });
}

// ─── 辅助：构造 redispatchInvocation 入参 ───────────────────

function buildRedispatchParams(
  seeded: SeededInvocation,
  runtimeClient: RuntimeHttpClient,
): RedispatchInvocationParams {
  return {
    tenantId: seeded.tenantId,
    invocationId: seeded.invocationId,
    retryReasonCode: "requires_redispatch",
    checkpointRef: null,
    runtimeClient,
    runtimeEndpointResolver: async (binding: ExecutionBinding) => ({
      runtimeEndpoint: "https://redispatch-runtime.internal",
      auth: { mode: "workload_token", token: "test-token" },
      gatewayEndpoints: {
        events: "https://gateway.internal/events",
        cancel: "https://gateway.internal/cancel",
        resume: "https://gateway.internal/resume",
        steer: "https://gateway.internal/steer",
        tools: "https://gateway.internal/tools",
        tool_calls: "https://gateway.internal/tool-calls",
        user_action_requests: "https://gateway.internal/user-action-requests",
      },
      governanceConfig: {
        revision_id: "gov-rev-1",
        config_digest: "sha256:test-governance-digest",
        config: {},
      },
      gatewayAccess: {
        access_token: "gw-token",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    }),
    runtimeRevisionId: seeded.runtimeRevisionId,
    agentRevision: seeded.agentRevision,
    actorType: "system",
    actorId: null,
    correlationId: "redispatch-test-1",
  };
}

// ═══════════════════════════════════════════════════════════
// 1. redispatchInvocation 成功流程
// ═══════════════════════════════════════════════════════════

describe("S09-C06 redispatchInvocation 成功流程", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let agentId: string;
  let threadId: string;
  let routeId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    agentId = seeded.agent.id;
    routeId = seeded.route.id;
    const thread = await createThreadForTest(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("waiting_user → running：创建新 Attempt + 调用 Runtime + 写 invocation.started + 标记旧 binding lost + 创建新 binding", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      withSessionBinding: true,
      withPriorAttempt: true,
      lastHeartbeatAt: new Date(),
    });

    const oldBindingId = seeded.sessionBinding?.id;
    const client = buildSuccessRuntimeClient(seeded.invocationId, 2);
    const result: RedispatchResult = await redispatchInvocation(
      buildRedispatchParams(seeded, client),
    );

    // 1. redispatched=true
    expect(result.redispatched).toBe(true);
    expect(result.skipReason).toBeUndefined();

    // 2. 新 Attempt 已创建（attemptNo=2）+ 状态 running
    expect(result.attempt).toBeDefined();
    expect(result.attempt?.attemptNo).toBe(2);
    expect(result.attempt?.attemptState).toBe("running");
    expect(result.attempt?.runtimeExecutionRef).toBeTruthy();
    expect(result.attempt?.startedAt).toBeTruthy();

    // 3. 旧 SessionBinding 标记 lost
    expect(result.previousSessionBinding).not.toBeNull();
    expect(result.previousSessionBinding?.id).toBe(oldBindingId);
    expect(result.previousSessionBinding?.bindingState).toBe("lost");
    expect(oldBindingId).toBeDefined();
    const oldBindingRefreshed = await getSessionBindingById(tenantId, oldBindingId ?? "");
    expect(oldBindingRefreshed?.bindingState).toBe("lost");

    // 4. 新 SessionBinding 已创建
    expect(result.sessionBinding).toBeDefined();
    expect(result.sessionBinding?.id).not.toBe(oldBindingId);
    expect(result.sessionBindingCreated).toBe(true);

    // 5. Invocation 状态 running
    expect(result.invocation?.executionState).toBe("running");
    expect(result.invocation?.runtimeExecutionRef).toBeTruthy();
    expect(result.invocation?.runtimeSessionBindingId).toBe(result.sessionBinding?.id);

    // 6. 写入 invocation.started Event
    expect(result.invocationStartedEvent).not.toBeNull();
    expect(result.invocationStartedEvent?.eventType).toBe("invocation.started");
    const payload = result.invocationStartedEvent?.payloadJson as Record<string, unknown>;
    expect(payload.attempt_no).toBe(2);
    expect(payload.retry_reason).toBe("requires_redispatch");
    expect(payload.redispatched).toBe(true);
    expect(payload.previous_session_binding_id).toBe(oldBindingId);
    expect(payload.producer_sequence_start).toBe(1); // 无候选事件，从 1 开始

    // 7. Runtime 被调用一次
    expect(client.calls.startInvocation).toHaveLength(1);
    const startReq = client.calls.startInvocation[0];
    expect(startReq?.requestBody.attempt).toBeDefined();
    expect(startReq?.requestBody.attempt?.attempt_no).toBe(2);
    expect(startReq?.requestBody.attempt?.retry_reason).toBe("requires_redispatch");
    expect(startReq?.requestBody.attempt?.producer_sequence_start).toBe(1);

    // 8. 数据库验证
    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("running");
  });

  it("queued → running：无旧 SessionBinding，仍创建新 binding + 写 Event", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "queued",
      withSessionBinding: false,
      withPriorAttempt: false,
    });

    const client = buildSuccessRuntimeClient(seeded.invocationId, 1);
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));

    expect(result.redispatched).toBe(true);
    expect(result.attempt?.attemptNo).toBe(1); // 首次 Attempt
    expect(result.previousSessionBinding).toBeNull(); // 无旧 binding
    expect(result.sessionBinding).toBeDefined();
    expect(result.sessionBindingCreated).toBe(true);
    expect(result.invocation?.executionState).toBe("running");
    expect(result.invocationStartedEvent).not.toBeNull();
  });

  it("已 running 的 Invocation：不调状态机，仅更新 runtimeExecutionRef", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      withSessionBinding: true,
      withPriorAttempt: true,
      lastHeartbeatAt: new Date(),
    });

    const beforeState = await getInvocationById(tenantId, seeded.invocationId);
    const beforeVersionNo = beforeState?.versionNo;
    const beforeRuntimeExecRef = beforeState?.runtimeExecutionRef;

    const client = buildSuccessRuntimeClient(seeded.invocationId, 2);
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));

    expect(result.redispatched).toBe(true);
    expect(result.invocation?.executionState).toBe("running"); // 保持 running
    expect(result.invocation?.runtimeExecutionRef).not.toBe(beforeRuntimeExecRef); // ref 更新
    // versionNo 递增（即使不调状态机，也会更新 versionNo）
    expect(result.invocation?.versionNo).toBeGreaterThan(beforeVersionNo ?? 0);
    // Attempt 仍创建
    expect(result.attempt?.attemptNo).toBe(2);
    expect(result.attempt?.attemptState).toBe("running");
  });

  it("校验 attempt_no 递增 + producer_sequence_start 计算 + attempt 字段在 requestBody 中传递", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      withSessionBinding: true,
      withPriorAttempt: true,
      lastHeartbeatAt: new Date(),
    });

    // 插入 5 条候选事件（producer_sequence = 1..5）
    for (let i = 1; i <= 5; i++) {
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

    const client = buildSuccessRuntimeClient(seeded.invocationId, 2);
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));

    expect(result.attempt?.attemptNo).toBe(2); // 已有 attempt_no=1，新分配 2

    // producer_sequence_start = MAX(5) + 1 = 6
    const startReq = client.calls.startInvocation[0];
    expect(startReq?.requestBody.attempt?.producer_sequence_start).toBe(6);

    // invocation.started Event payload 也包含 producer_sequence_start
    const payload = result.invocationStartedEvent?.payloadJson as Record<string, unknown>;
    expect(payload.producer_sequence_start).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. redispatchInvocation 错误处理
// ═══════════════════════════════════════════════════════════

describe("S09-C06 redispatchInvocation 错误处理", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let agentId: string;
  let threadId: string;
  let routeId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    agentId = seeded.agent.id;
    routeId = seeded.route.id;
    const thread = await createThreadForTest(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("网络不可达 → 返回 skipped，Attempt 保持 queued", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      withSessionBinding: true,
      withPriorAttempt: true,
    });

    const client = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("network", "Runtime 网络不可达");
      },
    });
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));

    expect(result.redispatched).toBe(false);
    expect(result.skipReason).toBe("runtime_network_unavailable");
    expect(result.attempt).toBeDefined();
    expect(result.attempt?.attemptState).toBe("queued"); // 保持 queued
    expect(result.attempt?.startedAt).toBeNull();

    // Invocation 仍处于 waiting_user（未变）
    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("waiting_user");

    // 旧 SessionBinding 未标记 lost
    expect(seeded.sessionBinding).not.toBeNull();
    const oldBinding = await getSessionBindingById(tenantId, seeded.sessionBinding?.id ?? "");
    expect(oldBinding?.bindingState).toBe("active");
  });

  it("503 RUNTIME_UNAVAILABLE → 返回 skipped，Attempt 保持 queued", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      withSessionBinding: true,
      withPriorAttempt: true,
    });

    const client = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "Runtime 暂不可用", 503, "RUNTIME_UNAVAILABLE");
      },
    });
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));

    expect(result.redispatched).toBe(false);
    expect(result.skipReason).toBe("runtime_unavailable");
    expect(result.attempt?.attemptState).toBe("queued");
  });

  it("409 IDEMPOTENCY_CONFLICT → 复用现有 SessionBinding，按成功处理", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      withSessionBinding: true,
      withPriorAttempt: true,
    });

    const oldBindingId = seeded.sessionBinding?.id;
    const client = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "幂等冲突", 409, "IDEMPOTENCY_CONFLICT");
      },
    });
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));

    expect(result.redispatched).toBe(true);
    expect(result.sessionBindingCreated).toBe(false); // 未创建新 binding
    expect(result.previousSessionBinding).toBeNull(); // 幂等复用不标记旧 binding lost

    // Attempt 仍转为 running
    expect(result.attempt?.attemptState).toBe("running");
    expect(result.attempt?.startedAt).toBeTruthy();

    // Invocation 转为 running
    expect(result.invocation?.executionState).toBe("running");

    // 写入 invocation.started Event（包含 idempotency_conflict 标记）
    expect(result.invocationStartedEvent).not.toBeNull();
    const payload = result.invocationStartedEvent?.payloadJson as Record<string, unknown>;
    expect(payload.idempotency_conflict).toBe(true);
    expect(payload.redispatched).toBe(true);

    // 旧 binding 仍 active（未标记 lost）
    expect(oldBindingId).toBeDefined();
    const oldBinding = await getSessionBindingById(tenantId, oldBindingId ?? "");
    expect(oldBinding?.bindingState).toBe("active");
  });

  it("其他 HTTP 错误（400）→ terminal 拒绝：Attempt failed + Invocation lost（不再抛出）", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      withSessionBinding: true,
      withPriorAttempt: true,
    });

    const client = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("http", "请求 schema 无效", 400, "REQUEST_SCHEMA_INVALID");
      },
    });

    // 01 专项：terminal reject 不再向上抛（调用方拿到判别结果），
    // Attempt → failed + Invocation → lost（唯一 Recovery Authority 收口）。
    const result = await redispatchInvocation(buildRedispatchParams(seeded, client));
    expect(result.redispatched).toBe(false);
    expect(result.failureErrorCode).toBe("REQUEST_SCHEMA_INVALID");
    expect(result.attempt?.attemptState).toBe("failed");
    expect(result.attempt?.errorCode).toBe("REQUEST_SCHEMA_INVALID");

    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, seeded.invocationId))
      .limit(1);
    expect(invocation?.executionState).toBe("lost");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. redispatchInvocation 状态校验
// ═══════════════════════════════════════════════════════════

describe("S09-C06 redispatchInvocation 状态校验", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let agentId: string;
  let threadId: string;
  let routeId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    agentId = seeded.agent.id;
    routeId = seeded.route.id;
    const thread = await createThreadForTest(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("终态 Invocation 抛 RedispatchNotAllowedError", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "running",
      withSessionBinding: true,
      withPriorAttempt: true,
    });
    // 转为 completed
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, seeded.invocationId, "completed");
    });

    const client = buildSuccessRuntimeClient(seeded.invocationId, 2);
    await expect(redispatchInvocation(buildRedispatchParams(seeded, client))).rejects.toThrow(
      RedispatchNotAllowedError,
    );
  });

  it("跨租户 InvocationNotFoundError", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });

    const client = buildSuccessRuntimeClient(seeded.invocationId, 2);
    const params = buildRedispatchParams(seeded, client);
    params.tenantId = "00000000-0000-0000-0000-000000000000"; // 跨租户

    await expect(redispatchInvocation(params)).rejects.toThrow(InvocationNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 01 专项：Durable Dispatch Retry（Attempt lane）
// ═══════════════════════════════════════════════════════════

describe("01 专项 Durable Dispatch Retry（Attempt lane）", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let threadId: string;
  let routeId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    routeId = seeded.route.id;
    const thread = await createThreadForTest(tenantId, ownerId, seeded.agent.id);
    threadId = thread.id;
  });

  /** 直接对指定 Attempt 执行 dispatch（Worker lane 正式入口）。 */
  function buildAttemptParams(
    seeded: SeededInvocation,
    runtimeClient: RuntimeHttpClient,
    attemptId: string,
  ) {
    return {
      tenantId: seeded.tenantId,
      attemptId,
      runtimeClient,
      runtimeEndpointResolver: async (binding: ExecutionBinding) => ({
        runtimeEndpoint: "https://redispatch-runtime.internal",
        auth: { mode: "workload_token", token: "test-token" } as const,
        gatewayEndpoints: {
          events: "https://gateway.internal/events",
          cancel: "https://gateway.internal/cancel",
          resume: "https://gateway.internal/resume",
          steer: "https://gateway.internal/steer",
          tools: "https://gateway.internal/tools",
          tool_calls: "https://gateway.internal/tool-calls",
          user_action_requests: "https://gateway.internal/user-action-requests",
        },
        governanceConfig: {
          revision_id: "test-governance-revision",
          config_digest: `sha256:${"b".repeat(64)}`,
          config: {},
        },
        gatewayAccess: {
          access_token: "test-gateway-token",
          expires_at: new Date().toISOString(),
        },
      }),
    };
  }

  it("transient → 同一 Attempt 排定 durable retry（count+1 + nextDispatchAt），不创建新 Attempt", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const attemptId = (await createAttempt({ invocationId: seeded.invocationId })).id;

    let fail = true;
    const client = createMockRuntimeClient({
      startInvocation: async () => {
        if (fail) throw new RuntimeHttpClientError("network", "Runtime 网络不可达");
        return buildStartInvocationResponse(seeded.invocationId, 1);
      },
    });

    const result = await dispatchQueuedInvocationAttempt(
      buildAttemptParams(seeded, client, attemptId),
    );
    expect(result.status).toBe("transient_scheduled");
    if (result.status !== "transient_scheduled") return;
    expect(result.dispatchAttemptCount).toBe(1);
    expect(result.nextDispatchAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.attempt.attemptState).toBe("queued");

    // 只有一个 Attempt（未创建第二个）
    const attempts = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, seeded.invocationId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.nextDispatchAt).not.toBeNull();
    expect(attempts[0]?.dispatchAttemptCount).toBe(1);
    expect(attempts[0]?.lastTransientErrorCode).toBe("runtime_network_unavailable");
    expect(attempts[0]?.dispatchLeaseOwner).toBeNull();

    // 第二次 transient → 仍同一 Attempt，count 递增
    const result2 = await dispatchQueuedInvocationAttempt(
      buildAttemptParams(seeded, client, attemptId),
    );
    expect(result2.status).toBe("transient_scheduled");
    const attempts2 = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, seeded.invocationId));
    expect(attempts2).toHaveLength(1);
    expect(attempts2[0]?.dispatchAttemptCount).toBe(2);

    // 成功 → Attempt running + Invocation running
    fail = false;
    const result3 = await dispatchQueuedInvocationAttempt(
      buildAttemptParams(seeded, client, attemptId),
    );
    expect(result3.status).toBe("started");
    const [finalAttempt] = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, attemptId))
      .limit(1);
    expect(finalAttempt?.attemptState).toBe("running");
    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("running");
  });

  it("稳定 Runtime Idempotency-Key：所有 retry 都使用 invocation-attempt:<attemptId>", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const attemptId = (await createAttempt({ invocationId: seeded.invocationId })).id;

    let calls = 0;
    const client = createMockRuntimeClient({
      startInvocation: async () => {
        calls += 1;
        if (calls < 3)
          throw new RuntimeHttpClientError("http", "Runtime 暂不可用", 503, "RUNTIME_UNAVAILABLE");
        return buildStartInvocationResponse(seeded.invocationId, 1);
      },
    });

    await dispatchQueuedInvocationAttempt(buildAttemptParams(seeded, client, attemptId));
    await dispatchQueuedInvocationAttempt(buildAttemptParams(seeded, client, attemptId));
    await dispatchQueuedInvocationAttempt(buildAttemptParams(seeded, client, attemptId));

    expect(client.calls.startInvocation).toHaveLength(3);
    const keys = client.calls.startInvocation.map((c) => c.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`invocation-attempt:${attemptId}`]));
  });

  it("5 次耗尽 → Attempt failed + Invocation lost（Recovery Authority 收口）", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
      withSessionBinding: true,
    });
    const attemptId = (await createAttempt({ invocationId: seeded.invocationId })).id;

    const client = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError("network", "Runtime 网络不可达");
      },
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await dispatchQueuedInvocationAttempt(
        buildAttemptParams(seeded, client, attemptId),
      );
      if (i < 4) {
        expect(result.status).toBe("transient_scheduled");
      } else {
        expect(result.status).toBe("transient_exhausted");
      }
    }

    const [finalAttempt] = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, attemptId))
      .limit(1);
    expect(finalAttempt?.attemptState).toBe("failed");
    expect(finalAttempt?.errorCode).toBe("dispatch_retry_exhausted");
    expect(finalAttempt?.nextDispatchAt).toBeNull();

    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("lost");
    expect(refreshed?.errorCode).toBe("dispatch_retry_exhausted");
  });

  it("retry Start 不携带 Agent Contract Context（Base Harness；Allowed Bundle 属 AgentCall 专属后续批次）", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const attemptId = (
      await createAttempt({
        invocationId: seeded.invocationId,
        retryReasonCode: "requires_redispatch",
      })
    ).id;

    const client = createMockRuntimeClient({
      startInvocation: async () => buildStartInvocationResponse(seeded.invocationId, 1),
    });

    await dispatchQueuedInvocationAttempt(buildAttemptParams(seeded, client, attemptId));

    const call = client.calls.startInvocation[0];
    if (!call) throw new Error("startInvocation 未被调用");
    // 专题01 冻结架构：Base Harness 顶层 Start Request 不执行 Agent Contract Context
    // Enrichment；invocation_context（Allowed Bundle）属 AgentCall 专属，不进入顶层。
    expect(call.requestBody.invocation_context).toBeUndefined();
  });

  it("claimDueInvocationAttempts：活跃 lease 内不可被其他 worker 重复领取；lease 过期后可接管", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const attemptId = (await createAttempt({ invocationId: seeded.invocationId })).id;

    // 注入时钟：nextDispatchAt 已到期
    const now = new Date("2026-08-27T10:00:00.000Z");
    await db
      .update(invocationAttemptTable)
      .set({ nextDispatchAt: new Date(now.getTime() - 1_000) })
      .where(eq(invocationAttemptTable.id, attemptId));

    // worker-a 领取（30s lease，10:00:30 到期）
    const claimedByA = await claimDueInvocationAttempts({
      now,
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(claimedByA.map((a) => a.id)).toContain(attemptId);

    // worker-a 已提交 lease 后的第二次 poll：lease 仍活跃（10:00:05 < 10:00:30），
    // worker-b 不得领取同一行（否则会产生重复 HTTP dispatch）
    const claimedByB = await claimDueInvocationAttempts({
      now: new Date(now.getTime() + 5_000),
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(claimedByB.filter((a) => a.id === attemptId)).toHaveLength(0);

    // DB owner 仍是 worker-a（未被 worker-b 覆盖）
    const [leased] = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, attemptId))
      .limit(1);
    expect(leased?.dispatchLeaseOwner).toBe("worker-a");

    // lease 过期后（10:00:31 > 10:00:30）：worker-b 可接管
    const reclaimed = await claimDueInvocationAttempts({
      now: new Date(now.getTime() + 31_000),
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(reclaimed.map((a) => a.id)).toContain(attemptId);
    const [takenOver] = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, attemptId))
      .limit(1);
    expect(takenOver?.dispatchLeaseOwner).toBe("worker-b");
  });

  it("claimDueInvocationAttempts：due 可领取（写 lease），非 due / 终态不领取", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const dueAttempt = await createAttempt({ invocationId: seeded.invocationId });
    const futureAttempt = await createAwaitingAttempt(seeded.invocationId);

    const now = new Date();
    await db
      .update(invocationAttemptTable)
      .set({ nextDispatchAt: new Date(now.getTime() - 1_000) })
      .where(eq(invocationAttemptTable.id, dueAttempt.id));

    const claimed = await claimDueInvocationAttempts({
      now,
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    const claimedIds = claimed.map((a) => a.id);
    expect(claimedIds).toContain(dueAttempt.id);
    expect(claimedIds).not.toContain(futureAttempt.id);
    expect(claimed.find((a) => a.id === dueAttempt.id)?.dispatchLeaseOwner).toBe("worker-a");
    expect(claimed.find((a) => a.id === dueAttempt.id)?.dispatchLeaseExpiresAt).toBeTruthy();
  });
});

/** 创建一个 nextDispatchAt 在未来的 queued Attempt（不会被 claim）。 */
async function createAwaitingAttempt(invocationId: string) {
  const attempt = await createAttempt({ invocationId });
  await db
    .update(invocationAttemptTable)
    .set({ nextDispatchAt: new Date(Date.now() + 60_000) })
    .where(eq(invocationAttemptTable.id, attempt.id));
  return attempt;
}

// ═══════════════════════════════════════════════════════════
// 01 专项：Runtime Dispatch Retry Worker（组合 lane）
// ═══════════════════════════════════════════════════════════

describe("01 专项 Runtime Dispatch Retry Worker", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: AgentRevision;
  let runtimeRevisionId: string;
  let threadId: string;
  let routeId: string;

  beforeEach(async () => {
    const tenantCtx = await seedTenantAndOwner();
    tenantId = tenantCtx.tenantId;
    ownerId = tenantCtx.ownerId;
    const seeded = await seedAgentAndRuntime(tenantId, ownerId);
    agentRevision = seeded.agentRevision;
    runtimeRevisionId = seeded.runtimeRevision.id;
    routeId = seeded.route.id;
    const thread = await createThreadForTest(tenantId, ownerId, seeded.agent.id);
    threadId = thread.id;
  });

  it("Worker tick：claim due Attempt → 同一 Attempt dispatch 成功（Invocation running）", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const attempt = await createAttempt({
      invocationId: seeded.invocationId,
      retryReasonCode: "initial_dispatch_unavailable",
    });
    // 排定 durable retry（已到期）
    await db
      .update(invocationAttemptTable)
      .set({ nextDispatchAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, attempt.id));

    let attemptsSeen = 0;
    const worker = createRuntimeDispatchRetryWorker({
      workerId: "worker-test-1",
      dispatchAttempt: async (claimed) => {
        attemptsSeen += 1;
        expect(claimed.id).toBe(attempt.id);
        const client = createMockRuntimeClient({
          startInvocation: async () => buildStartInvocationResponse(seeded.invocationId, 1),
        });
        const params = buildWorkerAttemptParams(seeded, client, claimed.id);
        const result = await dispatchQueuedInvocationAttempt(params);
        expect(result.status).toBe("started");
      },
      dispatchCommand: async () => {},
    });

    const tickResult = await worker.tick();
    expect(tickResult.attempts).toBe(1);
    expect(attemptsSeen).toBe(1);

    const [finalAttempt] = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, attempt.id))
      .limit(1);
    expect(finalAttempt?.attemptState).toBe("running");
    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("running");

    // 再次 tick：无 due work
    const tickResult2 = await worker.tick();
    expect(tickResult2.attempts).toBe(0);
    expect(attemptsSeen).toBe(1);
  });

  it("Worker 两实例并发：同一 Attempt 只被一个 lane 处理（SKIP LOCKED）", async () => {
    const seeded = await seedInvocation({
      tenantId,
      ownerId,
      agentRevision,
      runtimeRevisionId,
      routeId,
      threadId,
      turnId: "turn-1",
      initialExecutionState: "waiting_user",
    });
    const attempt = await createAttempt({
      invocationId: seeded.invocationId,
      retryReasonCode: "initial_dispatch_unavailable",
    });
    await db
      .update(invocationAttemptTable)
      .set({ nextDispatchAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, attempt.id));

    let dispatchCount = 0;
    const makeWorker = (id: string) =>
      createRuntimeDispatchRetryWorker({
        workerId: id,
        dispatchAttempt: async () => {
          dispatchCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
        dispatchCommand: async () => {},
      });

    // 并发 tick 两个 worker
    await Promise.all([makeWorker("worker-a").tick(), makeWorker("worker-b").tick()]);
    // SKIP LOCKED：同一个 Attempt 只被处理一次
    expect(dispatchCount).toBe(1);
  });
});

/** Worker 测试用 Attempt dispatch 参数（成功 mock）。 */
function buildWorkerAttemptParams(
  seeded: SeededInvocation,
  runtimeClient: RuntimeHttpClient,
  attemptId: string,
) {
  return {
    tenantId: seeded.tenantId,
    attemptId,
    runtimeClient,
    runtimeEndpointResolver: async () => ({
      runtimeEndpoint: "https://redispatch-runtime.internal",
      auth: { mode: "workload_token", token: "test-token" } as const,
      gatewayEndpoints: {
        events: "https://gateway.internal/events",
        cancel: "https://gateway.internal/cancel",
        resume: "https://gateway.internal/resume",
        steer: "https://gateway.internal/steer",
        tools: "https://gateway.internal/tools",
        tool_calls: "https://gateway.internal/tool-calls",
        user_action_requests: "https://gateway.internal/user-action-requests",
      },
      governanceConfig: {
        revision_id: "test-governance-revision",
        config_digest: `sha256:${"b".repeat(64)}`,
        config: {},
      },
      gatewayAccess: {
        access_token: "test-gateway-token",
        expires_at: new Date().toISOString(),
      },
    }),
  };
}
