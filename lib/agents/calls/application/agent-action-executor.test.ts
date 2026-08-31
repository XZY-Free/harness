import { randomUUID } from "node:crypto";
import { createAgentActionExecutor } from "@/lib/agents/calls/application/agent-action-executor";
import {
  seedAgentCallExecutionScenario,
  waitForCallTerminal,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { capabilityUseTable } from "@/lib/persistence/schema/capability-use";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
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

  async function seed(providerScenario: "completed" | "long_running") {
    const scenario = await seedAgentCallExecutionScenario({ providerScenario });
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
      logicalCallKey: `${scenario.parentInvocationId}:${action.actionId}:${scenario.agentId}`,
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
    expect(started).toMatchObject({ pending: { kind: "agent_call" } });
    await waitForCallTerminal(started.pending?.callId as string, scenario.tenantId);
    const result = await execute(action, context);

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
});
