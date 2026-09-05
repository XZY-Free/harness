import { randomUUID } from "node:crypto";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import {
  DEFAULT_TENANT_ID,
  INITIAL_GOVERNANCE_CONFIG,
  computeGovernanceConfigDigest,
  ensureDefaultTenant,
} from "@/lib/identity/tenant-bootstrap";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { threadEventTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable, runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import {
  type CapabilityCatalogAgent,
  buildCapabilityCatalogSnapshot,
} from "@/lib/runtime/harness-loop/capability-catalog";
import { and, asc, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as runtimeEventsPOST } from "../runtime-events/route";
import { POST as userActionRequestsPOST } from "../user-action-requests/route";
import { POST } from "./route";

const TENANT = DEFAULT_TENANT_ID;
const agentScenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
  agentScenarios.length = 0;
});

afterEach(async () => {
  for (const scenario of agentScenarios) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.close();
  }
});

async function seedRunningTurn(
  preferredAgentId: string | null = null,
  harnessLoopLimits?: { maxLoopSteps?: number },
  agentCandidate?: CapabilityCatalogAgent,
) {
  const threadId = randomUUID();
  const turnId = randomUUID();
  const invocationId = randomUUID();
  await db.insert(threadTable).values({
    id: threadId,
    tenantId: TENANT,
    ownerUserId: "user-1",
    lifecycleState: "active",
    lastActivityAt: new Date(),
    lastTurnSequence: 1,
    lastItemSequence: 0,
    lastEventSequence: 0,
    pendingQueueVersionNo: 1,
    versionNo: 1,
  });
  await db.insert(turnTable).values({
    id: turnId,
    threadId,
    turnSequence: 1,
    triggerType: "user_message",
    turnState: "running",
    activeInvocationId: invocationId,
    latestInvocationId: invocationId,
    regenerationNo: 0,
    preferredAgentId,
    agentUseMode: preferredAgentId ? "preferred" : null,
    versionNo: 1,
  });
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId: TENANT,
    threadId,
    turnId,
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "running",
    versionNo: 1,
  });
  const [governanceSet] = await db
    .select({ revisionId: governanceConfigSetTable.currentRevisionId })
    .from(governanceConfigSetTable)
    .where(eq(governanceConfigSetTable.tenantId, TENANT))
    .limit(1);
  if (!governanceSet?.revisionId) throw new Error("测试 Governance Revision 不存在");
  const [governanceRevision] = await db
    .select({ digest: governanceConfigRevisionTable.configDigest })
    .from(governanceConfigRevisionTable)
    .where(eq(governanceConfigRevisionTable.id, governanceSet.revisionId))
    .limit(1);
  if (!governanceRevision) throw new Error("测试 Governance Revision 不存在");
  let governanceDigest = governanceRevision.digest;
  if (harnessLoopLimits) {
    const config = {
      ...INITIAL_GOVERNANCE_CONFIG,
      harnessLoopLimits: {
        ...INITIAL_GOVERNANCE_CONFIG.harnessLoopLimits,
        ...harnessLoopLimits,
      },
    };
    governanceDigest = computeGovernanceConfigDigest(config);
    await db
      .update(governanceConfigRevisionTable)
      .set({ configJson: config, configDigest: governanceDigest })
      .where(eq(governanceConfigRevisionTable.id, governanceSet.revisionId));
  }
  await createExecutionBinding({
    invocationId,
    tenantId: TENANT,
    runtimeRevisionId: "runtime-revision-test",
    deploymentRouteId: "deployment-route-test",
    modelProvider: "test",
    modelId: "test-model",
    governanceConfigRevisionId: governanceSet.revisionId,
    governanceConfigDigest: governanceDigest,
    controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
    projectionVersionNo: 1,
    ...(preferredAgentId
      ? {
          capabilityCatalogFields: capabilityCatalogFields(
            invocationId,
            preferredAgentId,
            agentCandidate ?? testAgentCandidate(preferredAgentId),
          ),
        }
      : {}),
  });
  return { threadId, turnId, invocationId };
}

function testAgentCandidate(agentId: string): CapabilityCatalogAgent {
  return {
    agentId,
    agentRevisionId: "test-agent-revision",
    routeRevisionId: "test-agent-route-revision",
    contractSnapshotId: "test-agent-contract-snapshot",
    contractDigest: `sha256:${"7".repeat(64)}`,
    publicationRecordId: "test-agent-publication",
    displayName: "测试 Agent",
    description: "测试能力目录 Agent",
    scenarioDeclaration: "unspecified",
    applicableScenarios: [],
    excludedScenarios: [],
    contractSummary: "测试合同",
    contextRequirements: [],
  };
}

function capabilityCatalogFields(
  invocationId: string,
  preferredAgentId: string,
  agentCandidate: CapabilityCatalogAgent,
) {
  const catalog = buildCapabilityCatalogSnapshot({
    invocationId,
    preferredAgentId,
    agentCandidate,
    tools: [],
    knowledgeSources: [],
    sourceRefs: [`test-agent:${preferredAgentId}`],
    now: new Date("2026-09-04T00:00:00.000Z"),
  });
  return {
    capabilityCatalogJson: catalog.snapshot,
    capabilityCatalogDigest: catalog.digest,
    capabilityCatalogVersion: catalog.version,
    capabilityCatalogSourceRefs: catalog.sourceRefs,
    capabilityCatalogCreatedAt: catalog.createdAt,
    executionSubjectType: "user" as const,
    executionSubjectId: "test-user",
    executionSubjectSource: "authenticated_user" as const,
    executionSubjectFrozenAt: new Date("2026-09-04T00:00:00.000Z"),
  };
}

function token(
  invocationId: string,
  tenantId = TENANT,
  runtimeRevisionId = "runtime-revision-test",
): string {
  return issueWorkloadToken({
    type: "gateway",
    tenantId,
    invocationId,
    runtimeRevisionId,
    audience: "gateway",
    expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
  });
}

function request(
  invocationId: string,
  action: unknown,
  producerSequenceStart = 1,
  tenantId = TENANT,
  runtimeRevisionId = "runtime-revision-test",
): Request {
  return new Request("http://localhost/gateway/v1/capability-actions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token(invocationId, tenantId, runtimeRevisionId)}`,
      "content-type": "application/json",
      "idempotency-key": `${invocationId}:${(action as { actionId?: string })?.actionId ?? ""}`,
    },
    body: JSON.stringify({
      invocation_id: invocationId,
      producer_sequence_start: producerSequenceStart,
      action,
    }),
  });
}

describe("POST /gateway/v1/capability-actions", () => {
  it("External Runtime 通过 Gateway 回传事件与 user_action 请求，写入同一 Ingress/Authority", async () => {
    const seeded = await seedRunningTurn();
    const gatewayHeaders = {
      authorization: `Bearer ${token(seeded.invocationId)}`,
      "content-type": "application/json",
      "idempotency-key": `${seeded.invocationId}:runtime-events:1`,
    };
    const eventBody = {
      invocation_id: seeded.invocationId,
      producer_sequence_start: 1,
      events: [
        {
          producer_event_id: "external-user-action-1",
          producer_sequence: 1,
          type: "user_action.requested",
          schema_version: 1,
          payload: {
            request_type: "confirmation",
            purpose: "external_runtime_confirmation",
            prompt: "请确认继续",
          },
        },
      ],
    };
    const runtimeResponse = await runtimeEventsPOST(
      new Request("http://localhost/gateway/v1/runtime-events", {
        method: "POST",
        headers: gatewayHeaders,
        body: JSON.stringify(eventBody),
      }),
    );
    expect(runtimeResponse.status).toBe(200);
    expect(await db.select().from(userActionRequestTable)).toHaveLength(1);

    const second = await seedRunningTurn();
    const userActionResponse = await userActionRequestsPOST(
      new Request("http://localhost/gateway/v1/user-action-requests", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          authorization: `Bearer ${token(second.invocationId)}`,
          "idempotency-key": `${second.invocationId}:user-action:1`,
        },
        body: JSON.stringify({ ...eventBody, invocation_id: second.invocationId }),
      }),
    );
    expect(userActionResponse.status).toBe(200);
    expect(await db.select().from(userActionRequestTable)).toHaveLength(2);

    const completed = await seedRunningTurn();
    const completedResponse = await runtimeEventsPOST(
      new Request("http://localhost/gateway/v1/runtime-events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token(completed.invocationId)}`,
          "content-type": "application/json",
          "idempotency-key": `${completed.invocationId}:runtime-events:1`,
        },
        body: JSON.stringify({
          invocation_id: completed.invocationId,
          producer_sequence_start: 1,
          events: [
            {
              producer_event_id: "external-response-1",
              producer_sequence: 1,
              type: "response.completed",
              payload: { text: "外部 Runtime 已完成" },
            },
            {
              producer_event_id: "external-execution-2",
              producer_sequence: 2,
              type: "execution.completed",
              payload: { outcome: "success" },
            },
          ],
        }),
      }),
    );
    expect(completedResponse.status).toBe(200);
    expect(
      (
        await db
          .select()
          .from(invocationTable)
          .where(eq(invocationTable.id, completed.invocationId))
      )[0]?.executionState,
    ).toBe("completed");
  });

  it("knowledge.search 经同一 action schema 执行并持久化 proposed/started/completed", async () => {
    const seeded = await seedRunningTurn();
    const action = {
      actionId: "knowledge-1",
      stepNo: 1,
      actionType: "knowledge.search",
      purposeCode: "load_policy",
      shortPurpose: "检索年假制度",
      payload: { query: "年假制度", maxResults: 5 },
    };

    const response = await POST(request(seeded.invocationId, action));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      action_id: "knowledge-1",
      state: "completed",
      next_producer_sequence: 4,
      observation: { observationType: "knowledge", data: { status: "empty" } },
    });
    const events = await db
      .select({ type: threadEventTable.eventType })
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.invocationId, seeded.invocationId),
          like(threadEventTable.eventType, "harness.action.%"),
        ),
      );
    expect(events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "harness.action.completed",
    ]);
  });

  it("相同 actionId 重试返回既有 observation，不重复执行或写事件", async () => {
    const seeded = await seedRunningTurn();
    const action = {
      actionId: "knowledge-idempotent",
      stepNo: 1,
      actionType: "knowledge.search",
      purposeCode: "load_policy",
      shortPurpose: "检索年假制度",
      payload: { query: "年假制度" },
    };
    const first = await POST(request(seeded.invocationId, action));
    const second = await POST(request(seeded.invocationId, action));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const ingress = await db
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(eq(runtimeEventIngressTable.invocationId, seeded.invocationId));
    expect(ingress).toHaveLength(3);
  });

  it("使用 ExecutionBinding 冻结的 Governance 行动预算", async () => {
    const seeded = await seedRunningTurn(null, { maxLoopSteps: 1 });
    const first = await POST(
      request(seeded.invocationId, {
        actionId: "knowledge-1",
        stepNo: 1,
        actionType: "knowledge.search",
        purposeCode: "load_policy",
        shortPurpose: "首次检索",
        payload: { query: "年假制度" },
      }),
    );
    const second = await POST(
      request(
        seeded.invocationId,
        {
          actionId: "knowledge-2",
          stepNo: 2,
          actionType: "knowledge.search",
          purposeCode: "load_more",
          shortPurpose: "继续检索",
          payload: { query: "调休制度" },
        },
        4,
      ),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({
      error: { code: "HARNESS_LOOP_STEP_LIMIT_EXCEEDED" },
    });
  });

  it("agent.call 目标不等于 preferred Agent 时拒绝且零行动事件", async () => {
    const seeded = await seedRunningTurn("agent-allowed");
    const response = await POST(
      request(seeded.invocationId, {
        actionId: "agent-1",
        stepNo: 1,
        actionType: "agent.call",
        purposeCode: "query_balance",
        shortPurpose: "查询余额",
        payload: { agentId: "agent-other", task: "查询员工年假余额" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "AGENT_ACTION_NOT_ALLOWED" } });
    const ingress = await db
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(eq(runtimeEventIngressTable.invocationId, seeded.invocationId));
    expect(ingress).toHaveLength(0);
  });

  it("agent.call 通过统一执行器解析 Route，Route 不存在时稳定失败且不伪装成功", async () => {
    const seeded = await seedRunningTurn("agent-allowed");
    const response = await POST(
      request(seeded.invocationId, {
        actionId: "agent-committed",
        stepNo: 1,
        actionType: "agent.call",
        purposeCode: "query_balance",
        shortPurpose: "查询余额",
        payload: { agentId: "agent-allowed", task: "查询员工年假余额" },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AGENT_ROUTE_UNAVAILABLE" },
    });
    const events = await db
      .select({ type: runtimeEventIngressTable.candidateType })
      .from(runtimeEventIngressTable)
      .where(eq(runtimeEventIngressTable.invocationId, seeded.invocationId))
      .orderBy(asc(runtimeEventIngressTable.producerSequence));
    expect(events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
      "harness.action.failed",
    ]);
  });

  it("External Runtime 经 Gateway 复用统一 AgentActionExecutor 并返回 durable pending", async () => {
    const scenario = await seedAgentCallExecutionScenario({ providerScenario: "long_running" });
    agentScenarios.push(scenario);
    await db.delete(agentCallAttemptTable).where(eq(agentCallAttemptTable.callId, scenario.callId));
    await db.delete(agentCallBindingTable).where(eq(agentCallBindingTable.callId, scenario.callId));
    await db.delete(agentCallTable).where(eq(agentCallTable.id, scenario.callId));
    await db
      .delete(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId));
    scenario.provider.reset();
    scenario.provider.setScenario("long_running");
    const agentCandidate: CapabilityCatalogAgent = {
      agentId: scenario.agentId,
      agentRevisionId: scenario.agentRevisionId,
      routeRevisionId: scenario.binding.routeRevisionId,
      contractSnapshotId: scenario.agentContractSnapshotId,
      contractDigest: scenario.agentContractDigest,
      publicationRecordId: scenario.agentPublicationRecordId,
      displayName: "Execution Test Agent",
      description: "AgentCall execution scenario",
      scenarioDeclaration: "unspecified",
      applicableScenarios: [],
      excludedScenarios: [],
      contractSummary: "AgentCall execution contract",
      contextRequirements: ["execution_subject"],
    };
    await createExecutionBinding({
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      runtimeRevisionId: "external-runtime-revision-test",
      deploymentRouteId: "external-runtime-route-test",
      modelProvider: "test",
      modelId: "test-model",
      governanceConfigRevisionId: scenario.binding.governanceConfigRevisionId,
      governanceConfigDigest: scenario.binding.governanceConfigDigest,
      controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
      projectionVersionNo: 1,
      capabilityCatalogFields: capabilityCatalogFields(
        scenario.parentInvocationId,
        scenario.agentId,
        agentCandidate,
      ),
    });
    const action = {
      actionId: "agent-external-pending",
      stepNo: 1,
      actionType: "agent.call",
      purposeCode: "query_balance",
      shortPurpose: "查询余额",
      payload: {
        agentId: scenario.agentId,
        task: "只查询当前员工的年假余额",
        contextRefs: ["context:employee-subject"],
      },
    };

    const response = await POST(
      request(
        scenario.parentInvocationId,
        action,
        1,
        scenario.tenantId,
        "external-runtime-revision-test",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      action_id: action.actionId,
      state: "started",
      disposition: "pending",
      pending: { kind: "agent_call", state: "running" },
    });
    expect(scenario.provider.captured).toHaveLength(1);
    expect(scenario.provider.captured[0]?.text).toBe(action.payload.task);
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.parentInvocationId, scenario.parentInvocationId))
      .limit(1);
    expect(call).toMatchObject({
      sourceType: "harness_planned",
      sourceRef: action.actionId,
      logicalCallKey: `harness-action:${action.actionId}:agent:${scenario.agentId}`,
    });
    const events = await db
      .select({ type: runtimeEventIngressTable.candidateType })
      .from(runtimeEventIngressTable)
      .where(eq(runtimeEventIngressTable.invocationId, scenario.parentInvocationId))
      .orderBy(asc(runtimeEventIngressTable.producerSequence));
    expect(events.map((event) => event.type)).toEqual([
      "harness.action.proposed",
      "harness.action.started",
    ]);
  });
});
