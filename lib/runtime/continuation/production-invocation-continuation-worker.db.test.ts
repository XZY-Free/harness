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
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import { RuntimeStartRequestSchema, protocolDigest } from "@/lib/runtime/runtime-protocol";
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
  requests: Array<{ invocationId: string; idempotencyKey: string; body: unknown }>;
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
): Promise<ExternalRuntimeFixture> {
  const requests: Array<{ invocationId: string; idempotencyKey: string; body: unknown }> = [];
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
          {
            eventId: randomUUID(),
            producerSequence: String(sequenceStart + 1),
            type: "execution.completed",
            schemaVersion: 1,
            payload: { finishReason: "execution.completed" },
          },
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
        markAttemptPreparedInTransaction(tx, {
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
      expect(runtime.requests).toHaveLength(1);

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
      expect(scenario.provider.captured).toHaveLength(2);
      expect(runtime.requests).toHaveLength(1);
      expect(
        await db
          .select()
          .from(userActionRequestTable)
          .where(eq(userActionRequestTable.invocationId, scenario.parentInvocationId)),
      ).toHaveLength(1);
    },
  );
});
