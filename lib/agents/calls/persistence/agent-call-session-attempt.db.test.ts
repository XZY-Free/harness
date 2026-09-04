import { randomUUID } from "node:crypto";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { mysqlAgentSessionBindingStore } from "@/lib/agents/calls/persistence/mysql-agent-session-binding-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let scenario: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>> | null = null;

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  if (!scenario) return;
  delete process.env[scenario.credentialEnvVar];
  await scenario.provider.server.close();
  scenario = null;
});

describe("AgentSessionBinding 与 AgentCallAttempt Authority", () => {
  it("相同 context 映射幂等，归属冲突时拒绝", async () => {
    scenario = await seedAgentCallExecutionScenario();
    const input = {
      id: randomUUID(),
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      agentId: scenario.agentId,
      agentRevisionId: scenario.agentRevisionId,
      deploymentRouteId: scenario.binding.deploymentRouteId,
      routeRevisionId: scenario.binding.routeRevisionId,
      externalContextRef: `context-${randomUUID()}`,
      now: new Date("2026-08-29T00:00:00.000Z"),
    };
    const first = await mysqlAgentSessionBindingStore.create(input);
    const replay = await mysqlAgentSessionBindingStore.create({ ...input, id: randomUUID() });
    expect(replay.id).toBe(first.id);

    await expect(
      mysqlAgentSessionBindingStore.create({
        ...input,
        id: randomUUID(),
        threadId: randomUUID(),
        agentId: randomUUID(),
        agentRevisionId: randomUUID(),
        routeRevisionId: randomUUID(),
      }),
    ).rejects.toThrow(/关联冲突/);
  });

  it("task 只绑定 Attempt，当前 Attempt 选择活动的 Attempt 2", async () => {
    scenario = await seedAgentCallExecutionScenario();
    await mysqlAgentCallStore.finishAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      attemptNo: 1,
      to: "failed",
      errorCode: "RETRYABLE",
      errorSummary: "retry",
      now: new Date("2026-08-29T00:00:30.000Z"),
    });
    const attempt2 = await mysqlAgentCallStore.createAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      retryReasonCode: "transport_retry",
      transportChannel: "gateway",
      now: new Date("2026-08-29T00:01:00.000Z"),
    });
    const bound = await mysqlAgentCallStore.bindAttemptTask({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      attemptNo: 2,
      externalTaskRef: `task-${randomUUID()}`,
      now: new Date("2026-08-29T00:01:10.000Z"),
    });
    const current = await mysqlAgentCallStore.getCurrentAttempt({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
    });
    const byTask = await mysqlAgentCallStore.getAttemptByTaskRef({
      tenantId: scenario.tenantId,
      externalTaskRef: bound.externalTaskRef!,
    });

    expect(attempt2.attemptNo).toBe(2);
    expect(current?.id).toBe(attempt2.id);
    expect(current?.externalTaskRef).toBe(bound.externalTaskRef);
    expect(current?.transportChannel).toBe("gateway");
    expect(byTask?.id).toBe(attempt2.id);
  });
});
