import { randomUUID } from "node:crypto";
import { transitionAgentCall } from "@/lib/agents/calls/application/agent-call-transition";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import type { AgentCallCandidateEvent } from "@/lib/agents/calls/transport/agent-transport";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallAttemptTable, agentCallTable } from "@/lib/persistence/schema/agent-calls";
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

function event(
  type: "call.started" | "call.input_required" | "call.completed" | "call.failed",
): AgentCallCandidateEvent {
  return {
    producer_event_id: randomUUID(),
    producer_sequence: type === "call.started" ? 1 : 2,
    type,
    payload:
      type === "call.started"
        ? { task_id: "task-1", context_id: "context-1" }
        : type === "call.completed"
          ? { task_id: "task-1", context_id: "context-1", text: "done" }
          : type === "call.failed"
            ? {
                task_id: "task-1",
                context_id: "context-1",
                error: { code: "REMOTE_FAILED", message: "failed" },
              }
            : { task_id: "task-1", context_id: "context-1", prompt: "need input" },
  };
}

describe("AgentCall 状态转换事务", () => {
  it("真实转换逐次 +1，拒绝与幂等不增加版本", async () => {
    const scenario = await seed();
    const started = event("call.started");
    const first = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: started.type,
      authority: "agent_event",
      event: started,
    });
    expect(first).toMatchObject({ outcome: "applied", beforeVersionNo: 1, afterVersionNo: 2 });
    const replay = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: started.type,
      authority: "agent_event",
      event: started,
    });
    expect(replay).toMatchObject({ outcome: "applied", beforeVersionNo: 1, afterVersionNo: 2 });

    const rejectedEvent = event("call.started");
    rejectedEvent.producer_sequence = 3;
    rejectedEvent.payload = { task_id: "other", context_id: "context-1" };
    const rejected = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: rejectedEvent.type,
      authority: "agent_event",
      event: rejectedEvent,
    });
    expect(rejected).toMatchObject({ outcome: "rejected", beforeVersionNo: 2, afterVersionNo: 2 });
    const [row] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, scenario.callId));
    expect(row?.versionNo).toBe(2);
  });

  it.each(["call.completed", "call.failed"] as const)("queued 直接 %s 持久拒绝", async (type) => {
    const scenario = await seed();
    const terminal = event(type);
    const result = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: type,
      authority: "agent_event",
      event: terminal,
    });
    expect(result).toMatchObject({
      outcome: "rejected",
      reasonCode: "state_transition_not_allowed",
      beforeVersionNo: 1,
      afterVersionNo: 1,
    });
  });

  it("waiting_user 只接受正式用户回答恢复，冲突终态不覆盖", async () => {
    const scenario = await seed();
    for (const e of [event("call.started"), event("call.input_required")]) {
      await transitionAgentCall({
        tenantId: scenario.tenantId,
        callId: scenario.callId,
        input: e.type,
        authority: "agent_event",
        event: e,
      });
    }
    const resumed = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: "user_response_accepted",
      authority: "user_response",
    });
    expect(resumed).toMatchObject({ outcome: "applied", finalState: "running", afterVersionNo: 4 });

    const completed = event("call.completed");
    completed.producer_sequence = 3;
    await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: completed.type,
      authority: "agent_event",
      event: completed,
    });
    const failed = event("call.failed");
    failed.producer_sequence = 4;
    const conflict = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: failed.type,
      authority: "agent_event",
      event: failed,
    });
    expect(conflict).toMatchObject({ outcome: "rejected", reasonCode: "terminal_state_conflict" });
  });

  it("并发不同终态只有一个成功，另一条按终态冲突拒绝", async () => {
    const scenario = await seed();
    const started = event("call.started");
    await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: started.type,
      authority: "agent_event",
      event: started,
    });
    const completed = event("call.completed");
    completed.producer_sequence = 2;
    const failed = event("call.failed");
    failed.producer_sequence = 3;
    const results = await Promise.all([
      transitionAgentCall({
        tenantId: scenario.tenantId,
        callId: scenario.callId,
        input: completed.type,
        authority: "agent_event",
        event: completed,
      }),
      transitionAgentCall({
        tenantId: scenario.tenantId,
        callId: scenario.callId,
        input: failed.type,
        authority: "agent_event",
        event: failed,
      }),
    ]);
    expect(results.filter((result) => result.outcome === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.outcome === "rejected")?.reasonCode).toBe(
      "terminal_state_conflict",
    );
  });

  it("running 补全映射记 applied 但不增加 AgentCall 版本", async () => {
    const scenario = await seed();
    await db
      .update(agentCallTable)
      .set({ state: "running", startedAt: new Date(), versionNo: 2 })
      .where(eq(agentCallTable.id, scenario.callId));
    const started = event("call.started");
    const result = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: started.type,
      authority: "agent_event",
      event: started,
    });
    expect(result).toMatchObject({
      outcome: "applied",
      beforeVersionNo: 2,
      afterVersionNo: 2,
      finalState: "running",
    });
  });

  it("started 前的本地失败同时结束 Call 与 Attempt，避免无主 queued", async () => {
    const scenario = await seed();
    const result = await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: "call.failed",
      authority: "local_failure",
      errorCode: "AGENT_TRANSPORT_ENDPOINT_AUTH",
      errorSummary: "transport failed",
    });
    expect(result).toMatchObject({
      outcome: "applied",
      reasonCode: "call_failure_recorded",
      finalState: "failed",
      beforeVersionNo: 1,
      afterVersionNo: 2,
    });
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, scenario.callId));
    expect(attempt?.attemptState).toBe("failed");
  });
});
