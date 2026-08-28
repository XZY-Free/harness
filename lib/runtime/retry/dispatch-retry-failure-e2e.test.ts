/**
 * Failure True E2E（08 专项 §三 E2E-01~04）：真实 HTTP A2A Provider 的 durable retry 全链。
 *
 * 覆盖：
 * - E2E-01 Initial Start transient：第一次 503 → queued Attempt 排定 durable retry →
 *   Worker 领取同一 Attempt → 第二次 200 → Invocation running（无人工第二次请求）。
 * - E2E-02 Command Resume transient：resume 第一次 503 → dispatched + nextDispatchAt →
 *   Worker retry 同一 Command（同 idempotency key）→ acknowledged。
 * - E2E-03 Worker crash lease：dispatcher CAS 后崩溃（lease 过期）→ Worker 接管 →
 *   同 idempotency key 重发 → 副作用不重复（同 taskId/contextId 响应）。
 * - E2E-04 Retry exhaustion：持续 503 → Attempt failed + Invocation lost + active Turn failed。
 *
 * 真实 MySQL 8 + 真实 node:http A2A Provider（setFlaky 真实 503），无 mock HTTP。
 */
import { randomUUID } from "node:crypto";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { turnTable } from "@/lib/persistence/schema/conversation";
import { threadItemTable } from "@/lib/persistence/schema/conversation";
import { invocationCommandTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
  dispatchResumeCommand,
  retryDispatchedInvocationCommand,
} from "@/lib/runtime/command-dispatcher";
import { createAttempt } from "@/lib/runtime/invocation-attempt-queries";
import { createInvocation } from "@/lib/runtime/invocation-queries";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { dispatchQueuedInvocationAttempt } from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import {
  claimDueInvocationAttempts,
  claimDueInvocationCommands,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  type A2ATestProvider,
  startA2ATestProvider,
} from "@/lib/runtime/test-support/a2a-test-provider";
import { createA2ATransport } from "@/lib/runtime/transport/a2a-transport";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DUMMY_DIGEST = `sha256:${"a".repeat(64)}`;

let provider: A2ATestProvider;
let tenantId: string;
let ownerId: string;

beforeEach(async () => {
  await resetDatabase(db);
  provider = await startA2ATestProvider("completed");
  provider.setResumeResponseShape("task");
  const tenant = await ensureDefaultTenant();
  tenantId = tenant.id;
  const identity = await upsertUserIdentity({
    tenantId,
    externalSubject: "retry-e2e-owner",
    email: "retry-e2e@example.com",
    displayName: "Retry E2E Owner",
  });
  ownerId = identity.id;
});

afterEach(async () => {
  await provider.close();
});

/** 种子：Thread + trigger Item + queued Invocation + base-route a2a Binding（指向 provider）。 */
async function seedQueuedInvocationWithAttempt(): Promise<{
  invocationId: string;
  attemptId: string;
  threadId: string;
  turnId: string;
}> {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    defaultModelRef: null,
    actorId: ownerId,
  });
  const turnId = randomUUID();
  const itemId = randomUUID();
  await db.insert(threadItemTable).values({
    id: itemId,
    threadId: thread.id,
    turnId,
    itemSequence: 1,
    itemType: "user_message",
    itemState: "completed",
    authorType: "user",
    authorId: ownerId,
    contentJson: { text: "retry-e2e-trigger" },
    contentHash: "sha256:retry-e2e-trigger",
    contextPolicy: "include",
  });
  await db.insert(turnTable).values({
    id: turnId,
    threadId: thread.id,
    turnSequence: 1,
    triggerType: "user_message",
    triggerItemId: itemId,
    turnState: "queued",
    activeInvocationId: null,
    latestInvocationId: null,
    acceptedAt: new Date(),
  });

  const { invocation } = await createInvocation({
    tenantId,
    threadId: thread.id,
    turnId,
    invocationKind: "initial",
    triggerItemId: itemId,
    actorType: "user",
    actorId: ownerId,
  });
  // 关联 active Turn
  await db
    .update(turnTable)
    .set({ activeInvocationId: invocation.id, latestInvocationId: invocation.id })
    .where(eq(turnTable.id, turnId));

  // A2A taskId/contextId（resume 关联用）：runtimeExecutionRef + SessionBinding
  const taskId = `task-${randomUUID().slice(0, 8)}`;
  const contextId = `ctx-${randomUUID().slice(0, 8)}`;
  e2eRefs.set(invocation.id, { taskId, contextId });

  // base-route a2a RuntimeRevision + Binding（endpoint 指向真实 provider）
  const runtimeId = randomUUID();
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId,
    runtimeKey: `runtime-${runtimeId.slice(0, 8)}`,
    displayName: "Retry E2A Runtime",
    runtimeKind: "external",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
    currentRevisionId: null,
    versionNo: 1,
  });
  const runtimeRevisionId = randomUUID();
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: DUMMY_DIGEST,
    endpointRef: provider.endpoint,
    runtimeArtifactRef: null,
    runtimeCapabilitiesJson: {
      declared: {},
      measured: {
        features: {
          streaming_transport: "pass",
          incremental_content: "not_applicable",
          input_required: "pass",
          resume: "pass",
          cancel: "not_applicable",
          durable_task_recovery: "not_measured",
        },
      },
      effective: {},
    },
    identityMode: "none",
    networkZone: "external",
    configHash: DUMMY_DIGEST,
    revisionState: "published",
    createdBy: "retry-e2e",
  });
  await db.insert(executionBindingTable).values({
    invocationId: invocation.id,
    tenantId,
    agentRevisionId: null,
    runtimeRevisionId,
    deploymentRouteId: randomUUID(),
    modelProvider: "none",
    modelId: "none",
    modelRevisionRef: null,
    initialEnvironmentLeaseId: null,
    workspaceBindingId: null,
    policyRevisionId: randomUUID(),
    policyRulesDigest: DUMMY_DIGEST,
    governanceConfigRevisionId: randomUUID(),
    governanceConfigDigest: DUMMY_DIGEST,
    contextCheckpointId: null,
    routeRevisionId: randomUUID(),
    routeActivationId: randomUUID(),
    routeContentDigest: DUMMY_DIGEST,
    runtimeArtifactId: null,
    runtimeArtifactDigest: null,
    runtimeEvidenceKind: "external_endpoint",
    runtimeConfigDigest: DUMMY_DIGEST,
    runtimeTargetDigest: DUMMY_DIGEST,
    capabilityManifestDigest: DUMMY_DIGEST,
    agentContractSnapshotId: null,
    agentContractDigest: null,
    agentContextDigest: null,
    runtimeAttestationIds: [],
    agentPublicationRecordId: null,
    runtimePublicationRecordId: randomUUID(),
    conformanceRunId: randomUUID(),
    resolutionInputDigest: DUMMY_DIGEST,
    projectionVersionNo: 1,
    environmentDefinitionRevisionId: null,
    configHash: DUMMY_DIGEST,
    boundAt: new Date(),
  });

  const attempt = await createAttempt({ invocationId: invocation.id });
  return {
    invocationId: invocation.id,
    attemptId: attempt.id,
    threadId: thread.id,
    turnId,
  };
}

/** a2a transport + endpoint resolver（governance/gatewayAccess 测试形态）。 */
/** invocationId → taskId/contextId（resume 关联）。 */
const e2eRefs = new Map<string, { taskId: string; contextId: string }>();

function makeTransportAndResolver() {
  const transport = createA2ATransport({
    capabilities: { cancel: false, resume: true, steer: false },
    eventBatchSink: async () => {},
    resolveRuntimeRefs: async (invocationId: string) => {
      const refs = e2eRefs.get(invocationId);
      return refs ? { runtimeExecutionRef: refs.taskId, runtimeSessionRef: refs.contextId } : null;
    },
    resolveNextProducerSequence: async () => 100,
  });
  const endpointResolver = async () => ({
    runtimeEndpoint: provider.endpoint,
    auth: { mode: "none" } as const,
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
      revision_id: "retry-e2e-governance",
      config_digest: DUMMY_DIGEST,
      config: {},
    },
    gatewayAccess: {
      access_token: "retry-e2e-gateway-token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  return { transport, endpointResolver };
}

describe("Failure True E2E（真实 HTTP Provider，08 专项 E2E-01~04）", () => {
  it("E2E-01 Initial Start transient：503 → 同一 Attempt durable retry → 200 → Invocation running", async () => {
    const seeded = await seedQueuedInvocationWithAttempt();
    provider.setFlaky(1); // 第一次 503，第二次 200

    const { transport, endpointResolver } = makeTransportAndResolver();
    const first = await dispatchQueuedInvocationAttempt({
      tenantId,
      attemptId: seeded.attemptId,
      runtimeClient: transport,
      runtimeEndpointResolver: endpointResolver,
    });
    expect(first.status).toBe("transient_scheduled");

    // 排进 due（nextDispatchAt 到期）→ Worker claim → 同一 Attempt 再 dispatch
    await db
      .update(invocationAttemptTable)
      .set({ nextDispatchAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, seeded.attemptId));
    const claimed = await claimDueInvocationAttempts({
      now: new Date(),
      leaseOwner: "worker-e2e-1",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(claimed.map((a) => a.id)).toContain(seeded.attemptId);

    const second = await dispatchQueuedInvocationAttempt({
      tenantId,
      attemptId: seeded.attemptId,
      runtimeClient: transport,
      runtimeEndpointResolver: endpointResolver,
    });
    expect(second.status).toBe("started");

    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("running");
    // 无人工第二次请求：同一 Attempt，两次 HTTP（503 + 200）
    const postRequests = provider.requests.filter((r) => r.method === "POST");
    expect(postRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("E2E-02 Command Resume transient：503 → dispatched+nextDispatchAt → Worker retry 同 Command → acknowledged", async () => {
    const seeded = await seedQueuedInvocationWithAttempt();
    // 先把 Invocation 推到 waiting_user + 建 resume command
    await db.transaction(async (tx) => {
      await tx
        .update(invocationTable)
        .set({ executionState: "waiting_user" })
        .where(eq(invocationTable.id, seeded.invocationId));
    });
    const commandId = randomUUID();
    await db.insert(invocationCommandTable).values({
      id: commandId,
      invocationId: seeded.invocationId,
      threadId: seeded.threadId,
      turnId: seeded.turnId,
      commandType: "resume",
      commandPayloadJson: { resume_payload: { text: "年休假，明天一天" } },
      commandPayloadHash: `sha256:${commandId}`,
      commandState: "queued",
      idempotencyKey: `resume-e2e-${commandId.slice(0, 8)}`,
    });

    provider.setFlaky(1);
    const { transport, endpointResolver } = makeTransportAndResolver();
    const first = await dispatchResumeCommand({
      tenantId,
      commandId,
      runtimeClient: transport,
      runtimeEndpointResolver: endpointResolver,
    });
    expect(first.commandState).toBe("dispatched");
    expect(first.pendingRetry).toBeDefined();

    // nextDispatchAt 到期 → Worker claim → retry 同一 Command（同 idempotency key）
    await db
      .update(invocationCommandTable)
      .set({ nextDispatchAt: new Date(Date.now() - 1) })
      .where(eq(invocationCommandTable.id, commandId));
    const claimed = await claimDueInvocationCommands({
      now: new Date(),
      leaseOwner: "worker-e2e-2",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(claimed.map((c) => c.id)).toContain(commandId);

    const second = await retryDispatchedInvocationCommand({
      tenantId,
      commandId,
      runtimeClient: transport,
      runtimeEndpointResolver: endpointResolver,
    });
    expect(second.commandState).toBe("acknowledged");

    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, commandId))
      .limit(1);
    expect(command?.commandState).toBe("acknowledged");
    // 两次 HTTP 使用同一稳定 idempotency key
    const keys = provider.requests.filter((r) => r.idempotencyKey).map((r) => r.idempotencyKey);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("E2E-03 Worker crash lease：CAS dispatched 后崩溃（lease 过期）→ 接管重发同 key → acknowledged", async () => {
    const seeded = await seedQueuedInvocationWithAttempt();
    await db.transaction(async (tx) => {
      await tx
        .update(invocationTable)
        .set({ executionState: "waiting_user" })
        .where(eq(invocationTable.id, seeded.invocationId));
    });
    const commandId = randomUUID();
    const idemKey = `resume-e2e-crash-${commandId.slice(0, 8)}`;
    await db.insert(invocationCommandTable).values({
      id: commandId,
      invocationId: seeded.invocationId,
      threadId: seeded.threadId,
      turnId: seeded.turnId,
      commandType: "resume",
      commandPayloadJson: { resume_payload: { text: "补充信息" } },
      commandPayloadHash: `sha256:${commandId}`,
      commandState: "dispatched",
      idempotencyKey: idemKey,
      dispatchAttemptCount: 1,
      lastDispatchAttemptAt: new Date(Date.now() - 60_000),
      dispatchLeaseOwner: "worker-crashed",
      dispatchLeaseExpiresAt: new Date(Date.now() - 1_000),
    });

    // lease 过期 → 接管
    const claimed = await claimDueInvocationCommands({
      now: new Date(),
      leaseOwner: "worker-e2e-3",
      leaseDurationMs: 30_000,
      limit: 10,
    });
    expect(claimed.map((c) => c.id)).toContain(commandId);

    const { transport, endpointResolver } = makeTransportAndResolver();
    const result = await retryDispatchedInvocationCommand({
      tenantId,
      commandId,
      runtimeClient: transport,
      runtimeEndpointResolver: endpointResolver,
    });
    expect(result.commandState).toBe("acknowledged");
    // 同一稳定 idempotency key
    const keys = provider.requests.filter((r) => r.idempotencyKey).map((r) => r.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([idemKey]));
  });

  it("E2E-04 Retry exhaustion：持续 503 → Attempt failed + Invocation lost + active Turn failed", async () => {
    const seeded = await seedQueuedInvocationWithAttempt();
    provider.setFlaky(99); // 持续 503

    const { transport, endpointResolver } = makeTransportAndResolver();
    let lastStatus: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      // 每轮把 nextDispatchAt 提前到期（模拟时间推进）
      await db
        .update(invocationAttemptTable)
        .set({ nextDispatchAt: new Date(Date.now() - 1) })
        .where(eq(invocationAttemptTable.id, seeded.attemptId));
      const result = await dispatchQueuedInvocationAttempt({
        tenantId,
        attemptId: seeded.attemptId,
        runtimeClient: transport,
        runtimeEndpointResolver: endpointResolver,
      });
      lastStatus = result.status;
    }
    expect(lastStatus).toBe("transient_exhausted");

    const refreshed = await getInvocationById(tenantId, seeded.invocationId);
    expect(refreshed?.executionState).toBe("lost");
    expect(refreshed?.errorCode).toBe("dispatch_retry_exhausted");

    const [turnRow] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, seeded.turnId))
      .limit(1);
    expect(turnRow?.turnState).toBe("failed");
    expect(turnRow?.activeInvocationId).toBeNull();
  });
});
