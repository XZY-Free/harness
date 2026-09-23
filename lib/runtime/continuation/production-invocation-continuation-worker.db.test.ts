import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import { POST as resolveUserAction } from "@/app/api/threads/[threadId]/user-actions/[requestId]/resolve/route";
import { createAgentActionExecutor } from "@/lib/agents/calls/application/agent-action-executor";
import {
  EXECUTION_FIXTURE_CONTRACT,
  seedAgentCallExecutionScenario,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { DEFAULT_USER_ID } from "@/lib/constants";
import { controlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { authorityIdentity } from "@/lib/executions/domain/execution-authority";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import {
  getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const resolveRoute = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });
const originalAuthMode = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

interface ExternalRuntimeFixture {
  server: Server;
  endpoint: string;
  requests: Array<{ invocationId: string; idempotencyKey: string; body: RuntimeStartRequest }>;
}

/**
 * 真实协议对端的外部 Runtime 桩。
 *
 * R02 §7 之后，Parent resume 必须经正式 Start 服务进入并由 Session 冻结稳定启动意图，
 * 因此本桩必须与真实外部 Runtime 行为一致：
 * - 只接受 `intentType=resume` 的 `/resume` 请求，且 idempotency key 必须是
 *   `start:<ownershipId>`（Session 冻结的稳定启动意图，不是临时 Key）；
 * - 接纳后先回传 `execution.started`（携带同一 intentKey 与语义摘要），再回传终态事件——
 *   与生产的 DurableReferenceRuntime 同形状；
 * - 响应体是 canonical `RuntimeStartResponse`（含 capabilitiesDigest）。
 */
async function startExternalRuntime(
  tenantId: string,
  runtimeRevisionId: string,
  runtimeCapabilities: unknown,
  completeAfterRequests = 1,
): Promise<ExternalRuntimeFixture> {
  const requests: Array<{
    invocationId: string;
    idempotencyKey: string;
    body: RuntimeStartRequest;
  }> = [];
  const capabilitiesDigest = computeCapabilityManifestDigest({
    runtimeRevisionId,
    runtimeCapabilities,
  });
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      !request.url?.match(/^\/runtime\/invocations\/[^/]+\/resume$/)
    ) {
      response.writeHead(404).end();
      return;
    }
    const invocationId = request.url.split("/")[3] ?? "";
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey) {
      response.writeHead(400).end();
      return;
    }
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
    const startRequest = RuntimeStartRequestSchema.parse(body ? JSON.parse(body) : null);
    requests.push({ invocationId, idempotencyKey, body: startRequest });
    if (startRequest.intentType !== "resume") {
      response.writeHead(400).end();
      return;
    }
    // R02 §7：稳定意图 = Session 冻结的 `start:<ownershipId>`，不接受任何临时 Key。
    if (idempotencyKey !== `start:${startRequest.authority.ownershipId}`) {
      response.writeHead(409).end();
      return;
    }
    const remoteSessionRef = `external-session:${startRequest.authority.sessionBindingId}`;
    const remoteExecutionRef = `external-execution:${startRequest.authority.ownershipId}`;
    const sequenceStart = Number(startRequest.producerSequenceStart);
    // 真实外部 Runtime 在接纳后先回 execution.started，再推进业务终态。
    await ingressRuntimeEvents({
      tenantId,
      invocationId,
      batch: {
        protocolVersion: 3,
        authority: startRequest.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: String(sequenceStart),
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: idempotencyKey,
              semanticRequestDigest: startRequest.semanticRequestDigest,
              remoteSessionRef,
              remoteExecutionRef,
              capabilitiesDigest,
            },
          },
          ...(requests.length >= completeAfterRequests
            ? [
                {
                  eventId: randomUUID(),
                  producerSequence: String(sequenceStart + 1),
                  type: "execution.completed" as const,
                  schemaVersion: 1,
                  payload: { finishReason: "execution.completed" },
                },
              ]
            : []),
        ],
      },
    });
    response.writeHead(202, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        protocolVersion: 3,
        authority: startRequest.authority,
        semanticRequestDigest: startRequest.semanticRequestDigest,
        accepted: true,
        remoteSessionRef,
        remoteExecutionRef,
        capabilitiesDigest,
        acceptedAt: Date.now(),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 Runtime 监听失败");
  return { server, endpoint: `http://127.0.0.1:${address.port}`, requests };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("生产 continuation worker durable topology", () => {
  const scenarios: Array<Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>> = [];
  const runtimes: ExternalRuntimeFixture[] = [];

  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  afterEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = originalAuthMode;
    for (const scenario of scenarios) {
      delete process.env[scenario.credentialEnvVar];
      await scenario.provider.close();
    }
    for (const runtime of runtimes) await closeServer(runtime.server);
    scenarios.length = 0;
    runtimes.length = 0;
  });

  it.each(["approve", "deny"] as const)(
    "%s 通过真实 Employee API、持久 Delivery 和生产 Worker 恢复同一 AgentCall",
    async (resolution) => {
      const defaultUserIdentity = await upsertUserIdentity({
        tenantId: DEFAULT_TENANT_ID,
        externalSubject: DEFAULT_USER_ID,
        email: "owner@snow-harness.local",
        displayName: "SnowHarness 管理员",
      });
      const scenario = await seedAgentCallExecutionScenario({
        tenantId: DEFAULT_TENANT_ID,
        threadOwnerUserId: defaultUserIdentity.id,
        providerScenario: "confirmation_resolution",
        contract: {
          ...EXECUTION_FIXTURE_CONTRACT,
          interaction: {
            ...EXECUTION_FIXTURE_CONTRACT.interaction,
            input_required: true,
            resume: true,
          },
        },
        agentInterfaceRequirements: {
          host_controls: { confirmation_action_keys: ["hr.leave.submit"] },
        },
      });
      scenarios.push(scenario);
      const runtimeId = randomUUID();
      const runtimeRevisionId = randomUUID();
      const runtimeCapabilitiesJson = { resume: true };
      const runtime = await startExternalRuntime(
        scenario.tenantId,
        runtimeRevisionId,
        runtimeCapabilitiesJson,
        resolution === "approve" ? 2 : 1,
      );
      runtimes.push(runtime);

      const runtimeTargetDigest = `sha256:${"9".repeat(64)}`;
      const now = new Date();
      await db.insert(runtimeTable).values({
        id: runtimeId,
        tenantId: scenario.tenantId,
        runtimeKey: `continuation-test-${runtimeId}`,
        displayName: "Continuation Test Runtime",
        runtimeKind: "external",
        ownerUserId: defaultUserIdentity.id,
        lifecycleState: "enabled",
        currentRevisionId: runtimeRevisionId,
        versionNo: 1,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(runtimeRevisionTable).values({
        id: runtimeRevisionId,
        tenantId: scenario.tenantId,
        runtimeId,
        revisionNo: 1,
        protocolType: "harness_runtime_protocol",
        protocolVersion: 3,
        protocolContractDigest: "1",
        runtimeEvidenceKind: "external_endpoint",
        runtimeTargetDigest,
        endpointRef: runtime.endpoint,
        runtimeArtifactRef: null,
        artifactId: null,
        artifactDigest: null,
        runtimeCapabilitiesJson,
        identityMode: "none",
        networkZone: "external",
        configHash: `sha256:${"a".repeat(64)}`,
        credentialRefId: null,
        revisionState: "published",
        createdBy: DEFAULT_USER_ID,
        createdAt: now,
        publishedAt: now,
      });
      await createExecutionBinding({
        invocationId: scenario.parentInvocationId,
        tenantId: scenario.tenantId,
        runtimeRevisionId,
        // canonical schema：ExecutionBinding.workspaceBindingId NOT NULL 且必须可解析，
        // 悬空默认值会在 ingress 校验时触发 WorkspaceNotReady。
        workspaceBindingId: (
          await createNoPlatformWorkspaceBinding(scenario.tenantId, "invocation-continuation-test")
        ).id,
        deploymentRouteId: "continuation-test-route",
        modelProvider: "test",
        modelId: "test-model",
        controlPlaneEvidence: {
          ...TEST_EXECUTION_BINDING_EVIDENCE,
          runtimeEvidenceKind: "external_endpoint",
          runtimeTargetDigest,
          runtimeArtifactId: null,
          runtimeArtifactDigest: null,
          runtimeAttestationIds: [],
        },
        projectionVersionNo: 1,
        executionSubject: executionSubjectFromUserIdentity(
          scenario.tenantId,
          defaultUserIdentity.id,
        ),
      });

      const execute = createAgentActionExecutor({
        tenantId: scenario.tenantId,
        executionSubject: executionSubjectFromUserIdentity(
          scenario.tenantId,
          defaultUserIdentity.id,
        ),
        resolveRoute,
        transportChannel: "hosted",
      });
      const action = {
        actionId: scenario.actionId,
        stepNo: 1,
        actionType: "agent.call" as const,
        purposeCode: "submit_leave",
        shortPurpose: "提交请假",
        payload: { agentId: scenario.agentId, task: "提交我的年假申请" },
      };
      // canonical Ownership acquire：Agent action 必须携带 Current Execution Authority。
      const attempt = await createAttempt({
        tenantId: scenario.tenantId,
        invocationId: scenario.parentInvocationId,
      });
      const attemptEvidence = {
        kind: "test-candidate",
        invocationId: scenario.parentInvocationId,
        attemptId: attempt.id,
      };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
          attemptId: attempt.id,
          evidence: attemptEvidence,
          digest: protocolDigest(attemptEvidence),
        }),
      );
      const { authority } = await acquireTestRuntimeAuthority({
        tenantId: scenario.tenantId,
        invocationId: scenario.parentInvocationId,
        attemptId: attempt.id,
        runtimeRevisionId,
        // canonical 生产拓扑：AgentCall 等待用户输入时 Parent Invocation 必然已
        // Start（executing/running），ingress user-action 事件也要求 executing 阶段。
        phase: "executing",
      });
      // canonical 生产拓扑：Parent Start 成功后 session 必须已 ack 为 active，
      // 否则 ingress user-action 的 executing 阶段校验（NotCurrentExecutor）不通过。
      const parentSemanticRequest = {
        fixture: "invocation-continuation-parent-start",
        invocationId: scenario.parentInvocationId,
      };
      await applyRuntimeSessionDispatchForTest(scenario.tenantId, authority.sessionBindingId, {
        bindingState: "active",
        semanticRequestJson: parentSemanticRequest,
        semanticRequestDigest: protocolDigest(parentSemanticRequest),
        remoteSessionRef: `runtime-session:${authority.sessionBindingId}`,
        remoteExecutionRef: `runtime-execution:${scenario.parentInvocationId}`,
        transportAcknowledgement: {
          capabilitiesDigest: protocolDigest(parentSemanticRequest),
        },
        startedEventId: randomUUID(),
      });
      const started = await execute(action, {
        invocationId: scenario.parentInvocationId,
        tenantId: scenario.tenantId,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        actionDigest: `sha256:${"b".repeat(64)}`,
        authority,
      });
      expect(started.pending).toMatchObject({ kind: "agent_call", callId: scenario.callId });
      expect(scenario.provider.captured).toHaveLength(1);

      const coordinator = createProductionInvocationContinuationWorker(`coordinator-${resolution}`);
      await coordinator.pollOnce();
      const initialRequests = await db
        .select()
        .from(userActionRequestTable)
        .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId));
      expect(initialRequests).toHaveLength(1);
      const request = initialRequests[0]!;
      expect(request.requestType).toBe("confirmation");
      expect(request.requestState).toBe("pending");

      const response = await resolveUserAction(
        new Request(
          `http://snow.test/api/threads/${scenario.threadId}/user-actions/${request.id}/resolve`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `resolve-${resolution}-${request.id}`,
            },
            body: JSON.stringify({ resolution }),
          },
        ),
        { params: Promise.resolve({ threadId: scenario.threadId, requestId: request.id }) },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        request_id: request.id,
        resume_dispatch: { mode: "agent_continuation", command_state: "acknowledged" },
      });

      const resumeEvents = await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(
          and(
            eq(controlPlaneOutboxEvent.eventType, "agent_call.continuation.requested"),
            eq(controlPlaneOutboxEvent.aggregateId, scenario.callId),
          ),
        )
        .orderBy(desc(controlPlaneOutboxEvent.occurredAt));
      const resumeEvent = resumeEvents.find(
        (event) =>
          (event.payloadJson as Record<string, unknown>).kind ===
          "resume_agent_after_user_response",
      );
      expect(resumeEvent).toBeTruthy();
      const pendingDelivery = await db
        .select()
        .from(controlPlaneEventDelivery)
        .where(eq(controlPlaneEventDelivery.eventId, resumeEvent?.id ?? ""));
      expect(pendingDelivery[0]?.state).toBe("pending");

      // 进程重启窗口：旧 Worker 从未处理这条 Delivery，新 Worker 只靠 DB 重新领取。
      createProductionInvocationContinuationWorker(`restarted-before-${resolution}`);
      const resumedWorker = createProductionInvocationContinuationWorker(
        `restarted-after-${resolution}`,
      );
      await resumedWorker.pollOnce();

      const [completedCall] = await db
        .select()
        .from(agentCallTable)
        .where(eq(agentCallTable.id, scenario.callId));
      expect(completedCall).toMatchObject({ id: scenario.callId, state: "completed" });
      expect(scenario.provider.captured).toHaveLength(2);
      const initial = scenario.provider.captured[0]!;
      const resumed = scenario.provider.captured[1]!;
      expect(resumed).toMatchObject({
        resume: true,
        taskId: initial.responseTaskId,
        contextId: initial.responseContextId,
        confirmationResolution: resolution,
      });
      expect(await db.select().from(agentCallTable)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(userActionRequestTable)
          .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId)),
      ).toHaveLength(1);

      // 完成 AgentCall 后的 resume_parent 也由同一个 Worker 消费，外部 Runtime 回传终态。
      await resumedWorker.pollOnce();
      if (resolution === "approve") {
        expect(runtime.requests).toHaveLength(1);
        const firstOwner = await getActiveExecutionOwnership({
          tenantId: scenario.tenantId,
          invocationId: scenario.parentInvocationId,
        });
        if (!firstOwner) throw new Error("首次 External 续接没有当前 Owner");
        const firstSession = await getRuntimeSessionBindingByOwnership(
          scenario.tenantId,
          firstOwner.id,
        );
        if (!firstSession) throw new Error("首次 External 续接没有 Session");
        const secondAuthority = authorityIdentity({
          invocationId: scenario.parentInvocationId,
          runtimeRevisionId,
          attemptId: firstOwner.attemptId,
          ownershipId: firstOwner.id,
          leaseEpoch: firstOwner.leaseEpoch,
          sessionBindingId: firstSession.id,
        });
        const secondAction = {
          ...action,
          actionId: `${scenario.actionId}-second`,
          stepNo: 2,
        };
        const secondStarted = await execute(secondAction, {
          invocationId: scenario.parentInvocationId,
          tenantId: scenario.tenantId,
          threadId: scenario.threadId,
          turnId: scenario.turnId,
          actionDigest: `sha256:${"c".repeat(64)}`,
          authority: secondAuthority,
        });
        expect(secondStarted.pending?.kind).toBe("agent_call");
        await resumedWorker.pollOnce();
        const secondRequests = await db
          .select()
          .from(userActionRequestTable)
          .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId))
          .orderBy(desc(userActionRequestTable.createdAt));
        const secondRequest = secondRequests.find((row) => row.id !== request.id);
        if (!secondRequest) throw new Error("第二个子调用没有产生正式 UserActionRequest");
        const secondResponse = await resolveUserAction(
          new Request(
            `http://snow.test/api/threads/${scenario.threadId}/user-actions/${secondRequest.id}/resolve`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": `resolve-second-${secondRequest.id}`,
              },
              body: JSON.stringify({ resolution: "approve" }),
            },
          ),
          { params: Promise.resolve({ threadId: scenario.threadId, requestId: secondRequest.id }) },
        );
        expect(secondResponse.status).toBe(200);
        await resumedWorker.pollOnce();
        await resumedWorker.pollOnce();
        const pendingContinuations = await db
          .select({
            state: controlPlaneEventDelivery.state,
            error: controlPlaneEventDelivery.lastErrorSummary,
          })
          .from(controlPlaneEventDelivery)
          .where(eq(controlPlaneEventDelivery.consumerName, "invocation_continuation"));
        expect(runtime.requests, JSON.stringify(pendingContinuations)).toHaveLength(2);
        const sessions = await getRuntimeSessionBindingsByInvocation(
          scenario.tenantId,
          scenario.parentInvocationId,
        );
        const secondSession = sessions.find((row) =>
          row.sourceOperationKey.startsWith(`agent-call:${secondStarted.pending?.callId}:`),
        );
        expect(secondSession?.id).toBeTruthy();
        expect(secondSession?.ownershipId).not.toBe(firstOwner.id);
        expect(secondSession?.attemptId).toBe(firstOwner.attemptId);
        const [retiredOwner] = await db
          .select()
          .from(executionOwnershipTable)
          .where(eq(executionOwnershipTable.id, firstOwner.id));
        expect(retiredOwner?.ownershipState).toBe("released");
        expect(sessions.find((row) => row.id === firstSession.id)?.bindingState).toBe("lost");
      }
      const [finalInvocation] = await db
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, scenario.parentInvocationId));
      const [finalTurn] = await db
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, scenario.turnId));
      expect(finalInvocation?.executionState).toBe("completed");
      expect(finalTurn?.turnState).toBe("completed");
      expect(runtime.requests).toHaveLength(resolution === "approve" ? 2 : 1);

      // A05-T08：真实对端**只**收到一个恢复意图，而且这个意图的身份/水位/环境全部取自
      // 持久冻结事实（ExecutionBinding + Attempt 的恢复锚点），不是调用方自拼资源。
      const remoteResume = runtime.requests[0];
      expect(remoteResume).toBeTruthy();
      const resumeBody = remoteResume?.body;
      if (!resumeBody) {
        throw new Error("恢复意图必须送达外部 Runtime");
      }
      expect(resumeBody.intentType).toBe("resume");
      // 传输键是 Session 冻结的稳定启动意图（`start:<ownershipId>`），不是临时/时间派生键。
      expect(remoteResume?.idempotencyKey.startsWith("start:")).toBe(true);
      const [frozenBinding] = await db
        .select()
        .from(executionBindingTable)
        .where(eq(executionBindingTable.invocationId, scenario.parentInvocationId));
      expect(frozenBinding).toBeTruthy();
      // 环境模式取自持久冻结的 ExecutionBinding，而不是调用方自拼。
      expect(resumeBody.environment.mode).toBe(frozenBinding?.environmentMode);
      const [parentAttempt] = await db
        .select()
        .from(invocationAttemptTable)
        .where(eq(invocationAttemptTable.invocationId, scenario.parentInvocationId))
        .orderBy(desc(invocationAttemptTable.createdAt))
        .limit(1);
      expect(resumeBody.recovery.kind).toBe("resume");
      if (resumeBody.recovery.kind !== "resume") {
        throw new Error("恢复请求必须携带 resume 恢复锚点，而不是 initial");
      }
      // 恢复 Anchor 必须来自持久事实（Invocation/Attempt），不是调用方自拼的临时值。
      //
      // 先把**本场景的事实**说清楚：父 Attempt 没有走真实 `execution.suspended`
      // （durable topology 夹具直接构造 waiting_user），所以它上面没有持久恢复锚点摘要。
      // 与其把断言写成"有就比较、没有就跳过"的软断言，这里把这条事实显式钉住，再断言
      // 请求里的 anchor 确实是持久事实派生出来的那个：
      //   - 有持久检查点 → `checkpoint:<attempt.filesystemCheckpointId>`；
      //   - 否则 → `invocation:<invocationId>:recovery:<持久 recoveryVersion>`。
      // `recoveryVersion` 会在恢复采纳子结果后前进，所以只比对**持久前缀**，不给序号造假；
      // 摘要则必须恰好是 anchor 的函数（生产在无持久锚点时按既有规则派生）。
      // 真实挂起 → 恢复的锚点严格一致性由 A05-T01/A05-T02 与 A06-T01 用真实 suspended 覆盖。
      expect(parentAttempt?.resumeAnchorDigest).toBeNull();
      const persistedAnchorPrefix = parentAttempt?.filesystemCheckpointId
        ? `checkpoint:${parentAttempt.filesystemCheckpointId}`
        : `invocation:${scenario.parentInvocationId}:recovery:`;
      expect(resumeBody.recovery.anchor.startsWith(persistedAnchorPrefix)).toBe(true);
      expect(resumeBody.recovery.anchorDigest).toBe(protocolDigest(resumeBody.recovery.anchor));

      // 复制同一 continuation payload 作为重复 Delivery；调用已推进版本，生产 handler 必须 no-op。
      const duplicateEventId = randomUUID();
      await db.insert(controlPlaneOutboxEvent).values({
        id: duplicateEventId,
        tenantId: resumeEvent!.tenantId,
        schemaVersion: resumeEvent!.schemaVersion,
        eventKey: `duplicate:${resumeEvent!.eventKey}:${duplicateEventId}`,
        eventType: resumeEvent!.eventType,
        aggregateType: resumeEvent!.aggregateType,
        aggregateId: resumeEvent!.aggregateId,
        aggregateVersion: resumeEvent!.aggregateVersion,
        payloadJson: resumeEvent!.payloadJson,
        occurredAt: new Date(),
        availableAt: new Date(),
      });
      await db.insert(controlPlaneEventDelivery).values({
        id: randomUUID(),
        eventId: duplicateEventId,
        consumerName: "invocation_continuation",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
      });
      await resumedWorker.pollOnce();
      expect(scenario.provider.captured).toHaveLength(resolution === "approve" ? 4 : 2);
      expect(runtime.requests).toHaveLength(resolution === "approve" ? 2 : 1);
      expect(
        await db
          .select()
          .from(userActionRequestTable)
          .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId)),
      ).toHaveLength(resolution === "approve" ? 2 : 1);
    },
  );
});
