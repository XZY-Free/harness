import { transitionAgentCall } from "@/lib/agents/calls/application/agent-call-transition";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallAttemptTable } from "@/lib/persistence/schema/agent-calls";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];
beforeEach(() => resetDatabase(db));
afterEach(async () => {
  for (const scenario of scenarios.splice(0)) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.server.close();
  }
});
async function seed() {
  const scenario = await seedAgentCallExecutionScenario();
  scenarios.push(scenario);
  return scenario;
}
async function start(scenario: Awaited<ReturnType<typeof seed>>) {
  return transitionAgentCall({
    tenantId: scenario.tenantId,
    callId: scenario.callId,
    input: "call.started",
    authority: "agent_event",
    event: {
      producer_event_id: "mapping-started",
      producer_sequence: 1,
      type: "call.started",
      payload: { task_id: "task-old", context_id: "context-mapping" },
    },
  });
}

describe("AgentCall Attempt 与 Session 映射", () => {
  it("started 精确绑定当前 Attempt；task/context 冲突持久拒绝", async () => {
    const scenario = await seed();
    expect((await start(scenario)).outcome).toBe("applied");
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, scenario.callId));
    expect(attempt?.externalTaskRef).toBe("task-old");
    const conflict = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: "call.input_required",
      authority: "agent_event",
      event: {
        producer_event_id: "context-conflict",
        producer_sequence: 2,
        type: "call.input_required",
        payload: { task_id: "task-old", context_id: "other-context" },
      },
    });
    expect(conflict).toMatchObject({ outcome: "rejected", reasonCode: "context_mapping_conflict" });
  });

  it("无 taskId 仅在唯一活动 Attempt 且 context 精确匹配时推断", async () => {
    const scenario = await seed();
    await start(scenario);
    const result = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: "call.input_required",
      authority: "agent_event",
      event: {
        producer_event_id: "context-only",
        producer_sequence: 2,
        type: "call.input_required",
        payload: { context_id: "context-mapping", prompt: "more" },
      },
    });
    expect(result).toMatchObject({ outcome: "applied", finalState: "waiting_user" });
  });

  it("重试后旧 Attempt 的同终态迟到事件不覆盖当前 Call", async () => {
    const scenario = await seed();
    await start(scenario);
    await mysqlAgentCallStore.finishAttempt({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      attemptNo: 1,
      to: "completed",
      now: new Date(),
    });
    await mysqlAgentCallStore.createAttempt({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      retryReasonCode: "retry",
      transportChannel: "hosted",
      now: new Date(),
    });
    const late = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: "call.completed",
      authority: "agent_event",
      event: {
        producer_event_id: "late-old-attempt",
        producer_sequence: 2,
        type: "call.completed",
        payload: { task_id: "task-old", context_id: "context-mapping", text: "old" },
      },
    });
    expect(late).toMatchObject({ outcome: "idempotent", reasonCode: "late_attempt_event" });
    expect(late.finalState).toBe("running");
  });

  it("多个活动 Attempt 时拒绝，绝不默认 Attempt 1", async () => {
    const scenario = await seed();
    await db.insert(agentCallAttemptTable).values({
      callId: scenario.callId,
      tenantId: scenario.tenantId,
      attemptNo: 2,
      attemptState: "queued",
      dispatchAttemptCount: 0,
      transportChannel: "hosted",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await start(scenario);
    expect(result).toMatchObject({ outcome: "rejected", reasonCode: "active_attempt_ambiguous" });
    const attempts = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, scenario.callId));
    expect(attempts.every((attempt) => attempt.externalTaskRef === null)).toBe(true);
  });
});
