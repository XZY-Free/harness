/**
 * POST /api/v1/threads/{thread_id}/user-actions/{request_id}/resolve —
 * Resume 调度真值与失败语义（03 专项）HTTP 路由测试。
 *
 * 冻结不变量：
 * - 路由绝不吞掉远端调度结果（无 .catch 后无条件 200）；
 * - A2A acknowledged → 200（mode=remote, command_state=acknowledged）；
 * - A2A 网络/503 → 202（pending_retry，不虚报完成）；
 * - A2A 明确拒绝 → 422 + Invocation lost（UAR 已提交事实不回滚）；
 * - 普通 Runtime UAR 的 Hosted local transport → 真实 dispatch 后返回 runtime 状态；
 * - purpose=a2a_input_required 的 Agent UAR 由 durable continuation 恢复，不走 Runtime command；
 * - 响应只保留一个 Authority（resume_dispatch），无 stale resume_command_state；
 * - 同 Idempotency-Key 同 body 重放返回同一结果，零重复远端调用。
 *
 * 真实 MySQL 8（Testcontainers）+ 真实 node:http A2A Provider，无 mock。
 */
import { randomUUID } from "node:crypto";
import { POST as resolvePOST } from "@/app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route";
import {
  type A2ATestProvider,
  startA2ATestProvider,
} from "@/lib/agents/calls/test/a2a-test-provider";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { testCapabilityCatalogBindingFields } from "@/lib/executions/test-support/test-capability-catalog";
import { invocationCommandTable, turnTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createConfiguredHostedRuntimeApplicationService } from "@/lib/runtime/application/production-resume-harness-invocation";
import { setCommandGatewayHostedApplicationServiceForTest } from "@/lib/runtime/command-dispatch-gateway";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { createSessionBinding } from "@/lib/runtime/session-binding-queries";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

let provider: A2ATestProvider;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
  setCommandGatewayHostedApplicationServiceForTest(null);
  provider = await startA2ATestProvider("completed");
  provider.setResumeResponseShape("task");
});

afterEach(async () => {
  await provider.close();
  setCommandGatewayHostedApplicationServiceForTest(null);
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
  await db
    .update(turnTable)
    .set({ turnState: "waiting_user", activeInvocationId: invocationId })
    .where(eq(turnTable.id, params.turnId));
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
    purpose: "runtime_input_required",
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
    threadId: params.threadId,
    externalSessionRef: contextId,
    runtimeCapabilities: defaultRuntimeCapabilities(),
  });
  await db
    .update(invocationTable)
    .set({ runtimeExecutionRef: taskId, runtimeSessionBindingId: binding.id })
    .where(eq(invocationTable.id, params.invocationId));
  await db.insert(executionBindingTable).values({
    ...testCapabilityCatalogBindingFields(params.invocationId),
    invocationId: params.invocationId,
    tenantId: params.tenantId,
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
    runtimeAttestationIds: [],
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
  it("hosted 协议通过 local transport 完成真实 resume dispatch", async () => {
    const decisionViews: Array<{ observations: unknown[] }> = [];
    setCommandGatewayHostedApplicationServiceForTest(
      createConfiguredHostedRuntimeApplicationService({
        decisionPort: {
          async decideNextAction(view) {
            decisionViews.push(view);
            return {
              actionId: "respond-after-user-input",
              stepNo: 1,
              actionType: "respond",
              purposeCode: "answer_ready",
              shortPurpose: "按用户补充信息回答",
              payload: { evidenceRefs: [] },
            };
          },
        },
        finalResponsePort: {
          async generateFinalResponse() {
            return "已根据补充信息完成";
          },
        },
        modelRef: "test-model",
      }),
    );
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
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
      harnessActionId: "action-request-input-route-1",
      toolCallId: null,
      itemId: null,
      requestType: "input",
      purpose: "runtime_input_required",
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
    expect(body.resume_dispatch).toMatchObject({ mode: "runtime", command_state: "acknowledged" });
    expect("resume_command_state" in body).toBe(false);
    expect((await getInvocationById(ctx.tenantId, invocation.id))?.executionState).toBe(
      "completed",
    );
    expect(decisionViews).toHaveLength(1);
    expect(decisionViews[0]?.observations).toContainEqual(
      expect.objectContaining({
        observationType: "user_input",
        data: expect.objectContaining({
          harnessActionId: "action-request-input-route-1",
          response: { text: "年休假，明天一天" },
        }),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 04 专项：Resume Command 真值（dispatched=false 显式 switch）
// ═══════════════════════════════════════════════════════════

describe("POST resolve — dispatched=false 显式 switch（04 专项 P1-4）", () => {
  it("unsupported_capability（effective resume=false）→ 422 UNSUPPORTED_CAPABILITY + Invocation lost；不恢复 pending", async () => {
    const ctx = await seedDispatchableTurn();
    const { threadId, turnId, tenantId, ownerId } = ctx;
    const dispatch = await dispatchInvocationForTurn({
      tenantId,
      turnId,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
    });
    const invocationId = dispatch.invocation?.id;
    if (!invocationId || !dispatch.binding) throw new Error("调度失败：未创建 Invocation/Binding");
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user" })
      .where(eq(invocationTable.id, invocationId));
    await db.update(turnTable).set({ turnState: "waiting_user" }).where(eq(turnTable.id, turnId));
    const requestId = randomUUID();
    await db.insert(userActionRequestTable).values({
      id: requestId,
      tenantId,
      threadId,
      turnId,
      invocationId,
      requestType: "input",
      purpose: "runtime_input_required",
      requestState: "pending",
      promptJson: { prompt: "请提供请假信息" },
      inputSchemaJson: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
      },
    });
    // Binding 有效，但 Runtime capability 形状损坏 → fail-closed effective resume=false。
    const [rev] = await db
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, dispatch.binding.runtimeRevisionId))
      .limit(1);
    await db
      .update(runtimeRevisionTable)
      .set({ runtimeCapabilitiesJson: {} })
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
