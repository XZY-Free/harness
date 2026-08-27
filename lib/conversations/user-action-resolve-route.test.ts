/**
 * POST /api/v1/threads/{thread_id}/user-actions/{request_id}/resolve —
 * Resume 调度真值与失败语义（03 专项）HTTP 路由测试。
 *
 * 冻结不变量：
 * - 路由绝不吞掉远端调度结果（无 .catch 后无条件 200）；
 * - A2A acknowledged → 200（mode=remote, command_state=acknowledged）；
 * - A2A 网络/503 → 202（pending_retry，不虚报完成）；
 * - A2A 明确拒绝 → 422 + Invocation lost（UAR 已提交事实不回滚）；
 * - hosted/非远端协议 → 200（mode=local_runtime，不伪造 A2A ack）；
 * - 响应只保留一个 Authority（resume_dispatch），无 stale resume_command_state；
 * - 同 Idempotency-Key 同 body 重放返回同一结果，零重复远端调用。
 *
 * 真实 MySQL 8（Testcontainers）+ 真实 node:http A2A Provider，无 mock。
 */
import { randomUUID } from "node:crypto";
import { POST as resolvePOST } from "@/app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { invocationCommandTable, turnTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { createSessionBinding } from "@/lib/runtime/session-binding-queries";
import {
  type A2ATestProvider,
  startA2ATestProvider,
} from "@/lib/runtime/test-support/a2a-test-provider";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

let provider: A2ATestProvider;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
  provider = await startA2ATestProvider("completed");
  provider.setResumeResponseShape("task");
});

afterEach(async () => {
  await provider.close();
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 种子辅助 ──────────────────────────────────────────────

interface SeededResolveTarget {
  tenantId: string;
  ownerId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
  requestId: string;
}

/** waiting_user Invocation + pending input UAR（挂在已有 thread/turn 上）。 */
async function seedWaitingInputOnThread(params: {
  tenantId: string;
  ownerId: string;
  threadId: string;
  turnId: string;
}): Promise<{ invocationId: string; requestId: string }> {
  const invocationId = randomUUID();
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId: params.tenantId,
    threadId: params.threadId,
    turnId: params.turnId,
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "waiting_user",
    triggerItemId: null,
    replacesInvocationId: null,
    outputItemId: null,
    resultRef: null,
    runtimeSessionBindingId: null,
    runtimeExecutionRef: null,
    startedAt: new Date(),
    finishedAt: null,
    lastHeartbeatAt: new Date(),
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const requestId = randomUUID();
  await db.insert(userActionRequestTable).values({
    id: requestId,
    tenantId: params.tenantId,
    threadId: params.threadId,
    turnId: params.turnId,
    invocationId,
    toolCallId: null,
    itemId: null,
    requestType: "input",
    purpose: "a2a_input_required",
    requestState: "pending",
    promptJson: { kind: "user_action.requested", prompt: "请提供请假信息" },
    inputSchemaJson: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 20_000, pattern: "\\S" } },
    },
    expiresAt: null,
    versionNo: 1,
  });
  return { invocationId, requestId };
}

const DUMMY_DIGEST = `sha256:${"a".repeat(64)}`;

/** 手工 base-route ExecutionBinding + external A2A RuntimeRevision（endpoint 可控）。 */
async function attachA2ABinding(params: {
  tenantId: string;
  invocationId: string;
  threadId: string;
  endpoint: string;
}): Promise<{ runtimeRevisionId: string; taskId: string; contextId: string }> {
  const runtimeId = randomUUID();
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: params.tenantId,
    runtimeKey: `runtime-${runtimeId}`,
    displayName: "A2A Runtime",
    runtimeKind: "external",
    ownerUserId: params.tenantId,
    lifecycleState: "enabled",
    currentRevisionId: null,
    versionNo: 1,
  });
  const runtimeRevisionId = randomUUID();
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    runtimeId,
    revisionNo: 1,
    protocolType: "a2a",
    protocolContractRevision: "0.3.0",
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: DUMMY_DIGEST,
    endpointRef: params.endpoint,
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
    createdBy: "route-test",
  });
  const taskId = `task-${randomUUID().slice(0, 8)}`;
  const contextId = `ctx-${randomUUID().slice(0, 8)}`;
  const binding = await createSessionBinding({
    tenantId: params.tenantId,
    runtimeRevisionId,
    agentRevisionId: null,
    threadId: params.threadId,
    externalSessionRef: contextId,
  });
  await db
    .update(invocationTable)
    .set({ runtimeExecutionRef: taskId, runtimeSessionBindingId: binding.id })
    .where(eq(invocationTable.id, params.invocationId));
  await db.insert(executionBindingTable).values({
    invocationId: params.invocationId,
    tenantId: params.tenantId,
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
  // resume 事件序号 MAX+1：预置一条 ingress 事件（producer_sequence=1）。
  await ingressEventBatch({
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    producerSequenceStart: 1,
    events: [
      {
        producer_event_id: `seed:${params.invocationId}:1`,
        producer_sequence: 1,
        schema_version: 1,
        type: "progress.snapshot",
        payload: { source: "a2a", task_id: taskId, task_state: "working" },
      },
    ],
  });
  return { runtimeRevisionId, taskId, contextId };
}

async function callResolve(
  threadId: string,
  requestId: string,
  idempotencyKey: string,
): Promise<Response> {
  return resolvePOST(
    buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/user-actions/${requestId}/resolve`,
      idempotencyKey,
      body: { resolution: "submit", response_redacted: { text: "年休假，明天一天" } },
    }),
    {
      params: Promise.resolve({
        thread_id: threadId,
        request_id: requestId,
      }),
    },
  );
}

// ─── 用例 ─────────────────────────────────────────────────

describe("POST resolve — Resume 调度真值（03 专项）", () => {
  it("A2A acknowledged → 200 mode=remote command_state=acknowledged；无 stale 字段", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { invocationId, requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    await attachA2ABinding({ tenantId, invocationId, threadId, endpoint: provider.endpoint });

    const response = await callResolve(threadId, requestId, "idem-resolve-ack-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resume_dispatch).toEqual({
      mode: "remote",
      command_state: "acknowledged",
    });
    // 03 §9：唯一 Authority，不输出 stale resume_command_state。
    expect("resume_command_state" in body).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain(provider.endpoint);
  });

  it("A2A 不可达（dead endpoint）→ 202 pending_retry；不虚报完成；Invocation 仍 running", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { invocationId, requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    const dead = await startA2ATestProvider("completed");
    const deadEndpoint = dead.endpoint;
    await dead.close();
    await attachA2ABinding({
      tenantId,
      invocationId,
      threadId,
      endpoint: deadEndpoint,
    });

    const response = await callResolve(threadId, requestId, "idem-resolve-dispatched-1");
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resume_dispatch).toEqual({
      mode: "remote",
      command_state: "dispatched",
      pending_retry: true,
    });
    // 03 §7：dispatched 不提前 mark lost，Invocation remains running。
    const [inv] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId))
      .limit(1);
    expect(inv?.executionState).toBe("running");
  });

  it("A2A 明确拒绝（correlation 篡改）→ 422 + Invocation lost；UAR 已提交事实不回滚", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { invocationId, requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    await attachA2ABinding({ tenantId, invocationId, threadId, endpoint: provider.endpoint });
    provider.corruptResumeCorrelation();

    const response = await callResolve(threadId, requestId, "idem-resolve-failed-1");
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
    expect(body.error.message).toBe("补充信息已保存，但运行服务未能恢复执行。");
    expect(body.error.details.resume_command_state).toBe("failed");
    expect(body.error.details.resume_command_id).toBeTruthy();
    // 脱敏：无 endpoint / bearer / stack / transcript。
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(provider.endpoint);
    expect(serialized).not.toContain("Bearer");

    // UAR remains resolved；resume command failed；Invocation lost。
    const [uar] = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, requestId))
      .limit(1);
    expect(uar?.requestState).toBe("resolved");
    expect(uar?.responseRedactedJson).toEqual({ text: "年休假，明天一天" });
    const [cmd] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.invocationId, invocationId))
      .limit(1);
    expect(cmd?.commandState).toBe("failed");
    const [inv] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId))
      .limit(1);
    expect(inv?.executionState).toBe("lost");
    expect(inv?.errorCode).toBe("resume_dispatch_failed");
  });

  it("hosted 协议（非 A2A）→ 200 mode=local_runtime，不伪造 A2A ack", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });
    const invocation = dispatch.invocation;
    if (!invocation) throw new Error("调度失败：未创建 Invocation");
    // hosted Invocation 推进到 waiting_user + UAR。
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user" })
      .where(eq(invocationTable.id, invocation.id));
    await db
      .update(turnTable)
      .set({ turnState: "waiting_user" })
      .where(eq(turnTable.id, ctx.turnId));
    const requestId = randomUUID();
    await db.insert(userActionRequestTable).values({
      id: requestId,
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      invocationId: invocation.id,
      toolCallId: null,
      itemId: null,
      requestType: "input",
      purpose: "a2a_input_required",
      requestState: "pending",
      promptJson: { kind: "user_action.requested", prompt: "请提供请假信息" },
      inputSchemaJson: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
      },
      expiresAt: null,
      versionNo: 1,
    });

    const response = await callResolve(ctx.threadId, requestId, "idem-resolve-hosted-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resume_dispatch).toMatchObject({ mode: "local_runtime" });
    expect("resume_command_state" in body).toBe(false);
  });

  it("同 Idempotency-Key 同 body 重放 → 返回同一 200 结果，零重复远端调用", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { invocationId, requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    await attachA2ABinding({ tenantId, invocationId, threadId, endpoint: provider.endpoint });

    const first = await callResolve(threadId, requestId, "idem-resolve-replay-1");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const resumeCalls = provider.captured.filter((c) => c.resume).length;
    expect(resumeCalls).toBe(1);

    const replay = await callResolve(threadId, requestId, "idem-resolve-replay-1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    // 无第二次远端调用。
    expect(provider.captured.filter((c) => c.resume).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 04 专项：Resume Command 真值（dispatched=false 显式 switch）
// ═══════════════════════════════════════════════════════════

describe("POST resolve — dispatched=false 显式 switch（04 专项 P1-4）", () => {
  it("unsupported_capability（effective resume=false）→ 422 UNSUPPORTED_CAPABILITY + Invocation lost；不恢复 pending", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { invocationId, requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    // Binding 有效，但 RuntimeRevision measured resume=fail → effective resume=false
    await attachA2ABinding({ tenantId, invocationId, threadId, endpoint: provider.endpoint });
    const [rev] = await db
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.endpointRef, provider.endpoint))
      .limit(1);
    const caps = rev?.runtimeCapabilitiesJson as {
      measured: { features: Record<string, string> };
    };
    caps.measured.features.resume = "fail";
    await db
      .update(runtimeRevisionTable)
      .set({ runtimeCapabilitiesJson: caps })
      .where(eq(runtimeRevisionTable.id, rev?.id ?? ""));

    const response = await callResolve(threadId, requestId, "idem-resolve-unsupported-1");
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    expect(body.error?.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(body.error?.details?.reason).toBe("unsupported_capability");

    // Invocation 由唯一 Recovery Authority 收口（resume_unsupported）；UAR 不回 pending
    const [inv] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId))
      .limit(1);
    expect(inv?.executionState).toBe("lost");
    expect(inv?.errorCode).toBe("resume_unsupported");
    const [uar] = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, requestId))
      .limit(1);
    expect(uar?.requestState).toBe("resolved");

    // 同 key 同 body 重放 → 同一 422 失败（幂等 terminal replay，不重复副作用）
    const replay = await callResolve(threadId, requestId, "idem-resolve-unsupported-1");
    expect(replay.status).toBe(422);
    const replayBody = (await replay.json()) as { error?: { code?: string } };
    expect(replayBody.error?.code).toBe("UNSUPPORTED_CAPABILITY");
  });

  it("command_not_found（Binding 缺失 → 内部一致性错误）→ 409，不能 200；Invocation lost", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { invocationId, requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    // 不 attach ExecutionBinding → 网关 loadCommandContext 返回 command_not_found
    // （Invocation 存在但 Binding 缺失 = 内部一致性错误）。

    const response = await callResolve(threadId, requestId, "idem-resolve-cnf-1");
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    expect(body.error?.code).toBe("OPERATION_PAYLOAD_CONFLICT");
    expect(body.error?.details?.reason).toBe("command_not_found");

    const [inv] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId))
      .limit(1);
    expect(inv?.executionState).toBe("lost");
    expect(inv?.errorCode).toBe("resume_command_missing");
  });

  it("raw runtime error / endpoint / bearer 不出现在响应中（sanitized）", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const { requestId } = await seedWaitingInputOnThread({
      tenantId,
      ownerId,
      threadId,
      turnId,
    });
    const response = await callResolve(threadId, requestId, "idem-resolve-sanitized-1");
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain(provider.endpoint);
  });
});
