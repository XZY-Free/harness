import { randomUUID } from "node:crypto";
import { createAgentActionExecutor } from "@/lib/agents/calls/application/agent-action-executor";
import { resumeAgentCallFromUserAction } from "@/lib/agents/calls/application/resume-agent-call-from-user-action";
import {
  EXECUTION_FIXTURE_CONTRACT,
  seedAgentCallExecutionScenario,
  waitForCallTerminal,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { threadEventTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const resolveRoute = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });

describe("AgentActionExecutor", () => {
  let scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

  beforeEach(async () => {
    await resetDatabase(db);
    scenarios = [];
  });

  afterEach(async () => {
    for (const scenario of scenarios) {
      delete process.env[scenario.credentialEnvVar];
      await scenario.provider.close();
    }
  });

  async function seed(providerScenario: "completed" | "long_running" | "input_required") {
    const scenario = await seedAgentCallExecutionScenario({
      providerScenario,
      ...(providerScenario === "input_required"
        ? {
            contract: {
              ...EXECUTION_FIXTURE_CONTRACT,
              interaction: {
                ...EXECUTION_FIXTURE_CONTRACT.interaction,
                input_required: true,
                resume: true,
              },
            },
          }
        : {}),
    });
    scenarios.push(scenario);
    await db.delete(agentCallAttemptTable).where(eq(agentCallAttemptTable.callId, scenario.callId));
    await db.delete(agentCallBindingTable).where(eq(agentCallBindingTable.callId, scenario.callId));
    await db.delete(agentCallTable).where(eq(agentCallTable.id, scenario.callId));
    await db
      .delete(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId));
    scenario.provider.reset();
    scenario.provider.setScenario(providerScenario);
    return scenario;
  }

  it("使用 Harness task 创建 harness_planned AgentCall，并以 actionId 稳定幂等", async () => {
    const scenario = await seed("long_running");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-1",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "query_balance",
      shortPurpose: "查询年假余额",
      payload: {
        agentId: scenario.agentId,
        task: "只查询当前员工的年假余额",
        contextRefs: ["context:employee-subject"],
      },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"a".repeat(64)}`,
    };

    const first = await execute(action, context);
    const replay = await execute(action, context);

    expect(first).toMatchObject({
      pending: { kind: "agent_call", state: "running" },
    });
    expect(replay).toEqual(first);
    expect(scenario.provider.captured).toHaveLength(1);
    expect(scenario.provider.captured[0]?.text).toBe(action.payload.task);
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(
        and(
          eq(agentCallTable.parentInvocationId, scenario.parentInvocationId),
          eq(agentCallTable.sourceRef, action.actionId),
        ),
      )
      .limit(1);
    expect(call).toMatchObject({
      sourceType: "harness_planned",
      logicalCallKey: `harness-action:${action.actionId}:agent:${scenario.agentId}`,
    });
    const [capabilityUse] = await db
      .select()
      .from(capabilityUseTable)
      .where(eq(capabilityUseTable.invocationId, scenario.parentInvocationId))
      .limit(1);
    expect(capabilityUse).toMatchObject({
      capabilityType: "agent",
      capabilityId: scenario.agentId,
      revisionId: scenario.agentRevisionId,
      sourceType: "harness_planned",
      sourceRef: action.actionId,
    });
  });

  it("AgentCall 完成后只返回 Agent Observation", async () => {
    const scenario = await seed("completed");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-completed",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "query_balance",
      shortPurpose: "查询年假余额",
      payload: { agentId: scenario.agentId, task: "查询当前员工年假余额" },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"b".repeat(64)}`,
    };

    const started = await execute(action, context);
    if (started.pending) {
      await waitForCallTerminal(started.pending.callId, scenario.tenantId);
    }
    const result = started.pending ? await execute(action, context) : started;

    expect(result).toMatchObject({
      authorityRef: expect.stringMatching(/^agent-call:/),
      observation: {
        observationType: "agent",
        sourceRefs: [expect.stringMatching(/^agent-call:/)],
        data: { resultText: expect.any(String) },
      },
    });
    expect(result).not.toHaveProperty("pending");
    expect(scenario.provider.captured).toHaveLength(1);
  });

  it("相同 actionId 改写 task 时稳定返回幂等冲突且不重复出站", async () => {
    const scenario = await seed("long_running");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"c".repeat(64)}`,
    };
    const baseAction = {
      actionId: "action-agent-conflict",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "query_balance",
      shortPurpose: "查询年假余额",
      payload: { agentId: scenario.agentId, task: "查询当前员工年假余额" },
    };

    await execute(baseAction, context);
    await expect(
      execute(
        { ...baseAction, payload: { ...baseAction.payload, task: "改为查询其他员工年假余额" } },
        context,
      ),
    ).rejects.toMatchObject({ code: "AGENT_CALL_IDEMPOTENCY_CONFLICT" });
    expect(scenario.provider.captured).toHaveLength(1);
  });

  it("input-required 原子投影 Parent/Turn waiting_user 与关联同一 AgentCall 的 UAR，重放不重复", async () => {
    const scenario = await seed("input_required");
    const execute = createAgentActionExecutor({
      tenantId: scenario.tenantId,
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
      resolveRoute,
      transportChannel: "hosted",
    });
    const action = {
      actionId: "action-agent-input",
      stepNo: 1,
      actionType: "agent.call" as const,
      purposeCode: "collect_employee_id",
      shortPurpose: "补充员工编号",
      payload: { agentId: scenario.agentId, task: "查询当前员工年假余额" },
    };
    const context = {
      invocationId: scenario.parentInvocationId,
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      actionDigest: `sha256:${"d".repeat(64)}`,
    };

    const first = await execute(action, context);
    const callId = first.pending?.callId as string;
    let waitingCall: typeof agentCallTable.$inferSelect | undefined;
    let projectedRequest: typeof userActionRequestTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      [waitingCall] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, callId));
      const requests = await db.select().from(userActionRequestTable);
      projectedRequest = requests.find(
        (request) => (request.promptJson as Record<string, unknown>).agent_call_id === callId,
      );
      if (projectedRequest || waitingCall?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waitingCall).toMatchObject({ state: "waiting_user", errorCode: null });
    await createProductionInvocationContinuationWorker(
      "agent-action-executor-input-required-test",
    ).pollOnce();
    const requestsAfterContinuation = await db.select().from(userActionRequestTable);
    projectedRequest = requestsAfterContinuation.find(
      (request) => (request.promptJson as Record<string, unknown>).agent_call_id === callId,
    );
    expect(projectedRequest).toBeTruthy();
    const replay = await execute(action, context);

    expect(first).toMatchObject({
      pending: { kind: "agent_call", state: "waiting_user" },
    });
    expect(replay).toEqual(first);
    const requests = await db.select().from(userActionRequestTable);
    const request = requests.find(
      (row) => (row.promptJson as Record<string, unknown>).agent_call_id === callId,
    );
    expect(request).toMatchObject({
      tenantId: scenario.tenantId,
      invocationId: scenario.parentInvocationId,
      turnId: scenario.turnId,
      requestType: "input",
      purpose: "a2a_input_required",
      requestState: "pending",
    });
    expect(request?.promptJson).toMatchObject({
      agent_call_id: callId,
      agent_call_event_id: expect.any(String),
      task_id: expect.any(String),
      context_id: expect.any(String),
    });
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, scenario.parentInvocationId));
    const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, scenario.turnId));
    expect(invocation?.executionState).toBe("waiting_user");
    expect(turn?.turnState).toBe("waiting_user");
    expect(requests).toHaveLength(1);
    const requestedEvents = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.eventType, "user_action.requested"));
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]?.payloadJson).toMatchObject({
      request_id: request?.id,
      agent_call_id: callId,
      action_id: action.actionId,
      task_id: (request?.promptJson as Record<string, unknown>)?.task_id,
      context_id: (request?.promptJson as Record<string, unknown>)?.context_id,
    });

    const changedPreferredAgentId = randomUUID();
    await db
      .update(turnTable)
      .set({ preferredAgentId: changedPreferredAgentId })
      .where(eq(turnTable.id, scenario.turnId));
    const resolved = await resolveGenericUserAction({
      tenantId: scenario.tenantId,
      requestId: request?.id as string,
      resolution: "submit",
      resolvedBy: randomUUID(),
      responseRedactedJson: { text: "2026-09-01" },
    });
    const [resumedTurn] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, scenario.turnId));
    expect(resumedTurn?.turnState).toBe("running");
    expect(resolved.resumeCommand.commandPayloadJson).toMatchObject({
      agent_call_id: callId,
      action_id: action.actionId,
      task_id: (request?.promptJson as Record<string, unknown>)?.task_id,
      context_id: (request?.promptJson as Record<string, unknown>)?.context_id,
      resume_payload: { text: "2026-09-01" },
    });

    const resumed = await resumeAgentCallFromUserAction({
      tenantId: scenario.tenantId,
      request: resolved.request,
      responseRedactedJson: { text: "2026-09-01" },
      executionSubject: executionSubjectFromUserIdentity(scenario.tenantId, `user:${randomUUID()}`),
    });
    expect(resumed).toMatchObject({ resumed: true, callId, state: "completed" });
    expect(scenario.provider.captured).toHaveLength(2);
    expect(scenario.provider.captured[1]).toMatchObject({
      resume: true,
      taskId: (request?.promptJson as Record<string, unknown>)?.task_id,
      contextId: (request?.promptJson as Record<string, unknown>)?.context_id,
      text: "2026-09-01",
    });
    expect(await db.select().from(agentCallTable)).toHaveLength(1);
    expect(changedPreferredAgentId).not.toBe(scenario.agentId);
  });
});
