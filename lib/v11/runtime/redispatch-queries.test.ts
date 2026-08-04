/**
 * S09-C06：V11 重调度编排集成测试（真实 MySQL 8）。
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
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type SbomDocument,
  type SignatureBundle,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createExecutionBinding } from "@/lib/executions/test-support/create-unverified-execution-binding";
import type { AuditActor } from "@/lib/identity/audit";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
  upsertDeploymentRoute,
} from "@/lib/routes/application/deployment-route-service";
import { createRuntime } from "@/lib/runtimes/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtimes/persistence/runtime-revision-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import {
  InvocationNotFoundError,
  RedispatchNotAllowedError,
  RuntimeHttpClientError,
} from "@/lib/v11/runtime/errors";
import { createAttempt, updateAttemptState } from "@/lib/v11/runtime/invocation-attempt-queries";
import {
  type CreateInvocationParams,
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/v11/runtime/invocation-queries";
import {
  type RedispatchInvocationParams,
  type RedispatchResult,
  redispatchInvocation,
} from "@/lib/v11/runtime/redispatch-queries";
import {
  type RuntimeHttpClient,
  type StartInvocationRequest,
  type StartInvocationResponse,
  createMockRuntimeClient,
} from "@/lib/v11/runtime/runtime-client";
import {
  createSessionBinding,
  getSessionBindingById,
} from "@/lib/v11/runtime/session-binding-queries";
import type { V11AgentRevision } from "@/lib/v11/schema/agent";
import { v11ThreadEvent, v11ThreadItem } from "@/lib/v11/schema/conversation";
import type { V11ExecutionBinding, V11RuntimeSessionBinding } from "@/lib/v11/schema/runtime";
import {
  v11Invocation,
  v11InvocationAttempt,
  v11RuntimeEventIngress,
} from "@/lib/v11/schema/runtime";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/v11/test-support/publish-trusted-runtime-revision";
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
  private signatures = new Map<string, SignatureBundle>();
  private sboms = new Map<string, SbomDocument>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeSignatureBundle(ref: string, bundle: SignatureBundle): void {
    this.signatures.set(ref, bundle);
  }
  writeSbom(ref: string, doc: SbomDocument): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readSignatureBundle(ref: string): Promise<SignatureBundle> {
    const bundle = this.signatures.get(ref);
    if (!bundle) throw new Error(`signature bundle not found: ${ref}`);
    return bundle;
  }
  async readSbom(ref: string): Promise<SbomDocument> {
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

  const agentRevision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: "git:redispatch-v1",
    instructionHash: "sha256:instruction_redispatch_v1",
    agentArtifactRef: "oci://registry/agent@sha256:redispatch-v1",
    modelPolicyJson: { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
    createdBy: ownerId,
  });

  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = Buffer.from(der.subarray(der.length - 32));
  const publicKeyBase64 = rawPublicKey.toString("base64");
  const content = "agent-content-redispatch-v1";
  const digest = computeArtifactDigest(content);
  const sigRef = "attestation:signature:redispatch-v1";
  const sbomRef = "attestation:sbom:redispatch-v1";
  const provRef = "attestation:provenance:redispatch-v1";

  const store = new InMemoryManagedArtifactStore();
  const sig = sign(null, Buffer.from(digest, "utf-8"), privateKey);
  store.writeSignatureBundle(sigRef, {
    algorithm: "ed25519",
    publicKey: publicKeyBase64,
    signature: sig.toString("base64"),
  });
  store.writeSbom(sbomRef, {
    packages: [{ name: "lodash", version: "4.17.21", licenses: ["MIT"], vulnerabilities: [] }],
  });
  store.writeProvenance(provRef, {
    sourceRevision: "git:abc123",
    buildPipeline: "ci-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  });

  const builderKeys: BuilderKeyRegistry = {
    "builder:redispatch": publicKeyBase64,
  };

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType: "agent_revision",
    artifactRevisionId: agentRevision.id,
    artifactDigest: digest,
    signatureBundleRef: sigRef,
    sbomRef,
    provenanceRef: provRef,
    builderIdentity: "builder:redispatch",
  };
  await verifyAndPersistAttestation(input, store, builderKeys, buildActor(tenantId, "ci-001"));
  await publishRevision(tenantId, agentRevision.id, 1);

  // Runtime
  const runtime = await createRuntime({
    tenantId,
    runtimeKey: "redispatch-runtime",
    displayName: "Redispatch Runtime",
    runtimeKind: "hosted",
    ownerUserId: ownerId,
  });

  const runtimeRevision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: "https://redispatch-runtime.internal",
    runtimeArtifactRef: "oci://registry/runtime@sha256:redispatch-v1",
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: "sha256:config_redispatch_v1",
    createdBy: ownerId,
  });

  // Runtime attestation
  const rtContent = "runtime-content-redispatch-v1";
  const rtDigest = computeArtifactDigest(rtContent);
  const rtSigRef = "attestation:signature:rt-redispatch-v1";
  const rtSbomRef = "attestation:sbom:rt-redispatch-v1";
  const rtProvRef = "attestation:provenance:rt-redispatch-v1";
  const rtSig = sign(null, Buffer.from(rtDigest, "utf-8"), privateKey);
  store.writeSignatureBundle(rtSigRef, {
    algorithm: "ed25519",
    publicKey: publicKeyBase64,
    signature: rtSig.toString("base64"),
  });
  store.writeSbom(rtSbomRef, {
    packages: [{ name: "lodash", version: "4.17.21", licenses: ["MIT"], vulnerabilities: [] }],
  });
  store.writeProvenance(rtProvRef, {
    sourceRevision: "git:abc123",
    buildPipeline: "ci-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  });

  const rtInput: VerifyAttestationInput = {
    tenantId,
    artifactType: "runtime_revision",
    artifactRevisionId: runtimeRevision.id,
    artifactDigest: rtDigest,
    signatureBundleRef: rtSigRef,
    sbomRef: rtSbomRef,
    provenanceRef: rtProvRef,
    builderIdentity: "builder:redispatch",
  };
  const rtAttestation = await verifyAndPersistAttestation(rtInput, store, builderKeys, buildActor(tenantId, "ci-001"));
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: runtimeRevision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: rtAttestation.id,
  });

  // Route（用于 ExecutionBinding.deploymentRouteId 引用）
  const routeSet = await createRouteSet({
    tenantId,
    agentId: agent.id,
    routeScopeKey: "default",
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
  agentRevision: V11AgentRevision;
  runtimeRevisionId: string;
  binding: V11ExecutionBinding;
  sessionBinding: V11RuntimeSessionBinding | null;
}

async function seedInvocation(params: {
  tenantId: string;
  ownerId: string;
  agentRevision: V11AgentRevision;
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
    await db.insert(v11ThreadItem).values({
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

  // 创建 ExecutionBinding
  const binding = await createExecutionBinding({
    invocationId: invocation.id,
    tenantId: params.tenantId,
    agentRevisionId: params.agentRevision.id,
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
      .update(v11Invocation)
      .set({ lastHeartbeatAt: params.lastHeartbeatAt })
      .where(eq(v11Invocation.id, invocation.id));
  }

  // 创建 SessionBinding
  let sessionBinding: V11RuntimeSessionBinding | null = null;
  if (params.withSessionBinding) {
    sessionBinding = await createSessionBinding({
      tenantId: params.tenantId,
      runtimeRevisionId: params.runtimeRevisionId,
      threadId: params.threadId ?? null,
      jobId: params.jobId ?? null,
      externalSessionRef: `ext-session-${invocation.id}`,
    });
    await db
      .update(v11Invocation)
      .set({ runtimeSessionBindingId: sessionBinding.id })
      .where(eq(v11Invocation.id, invocation.id));
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
    primaryAgentId: agentId,
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
      protocol_versions: ["1"],
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
    runtimeEndpointResolver: async (binding: V11ExecutionBinding) => ({
      runtimeEndpoint: "https://redispatch-runtime.internal",
      authToken: "test-token",
      gatewayEndpoints: {
        events: "https://gateway.internal/events",
        cancel: "https://gateway.internal/cancel",
        resume: "https://gateway.internal/resume",
        steer: "https://gateway.internal/steer",
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
  let agentRevision: V11AgentRevision;
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
      await db.insert(v11RuntimeEventIngress).values({
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
  let agentRevision: V11AgentRevision;
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

  it("其他 HTTP 错误（400）→ 抛出原错误", async () => {
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

    await expect(redispatchInvocation(buildRedispatchParams(seeded, client))).rejects.toThrow(
      RuntimeHttpClientError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 3. redispatchInvocation 状态校验
// ═══════════════════════════════════════════════════════════

describe("S09-C06 redispatchInvocation 状态校验", () => {
  let tenantId: string;
  let ownerId: string;
  let agentRevision: V11AgentRevision;
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
