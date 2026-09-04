import { transitionAgentCall } from "@/lib/agents/calls/application/agent-call-transition";
import { applyAgentCallTransition } from "@/lib/agents/calls/persistence/apply-agent-call-transition";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { controlPlaneEventDelivery } from "@/lib/control-plane/events/control-plane-event-delivery";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
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
      producer_event_id: "continuation-started",
      producer_sequence: 1,
      type: "call.started",
      payload: { task_id: "task-cont", context_id: "context-cont" },
    },
  });
}

describe("AgentCall Continuation 可靠产生端", () => {
  it("需要恢复父流程的转换在同事务创建唯一 outbox 与 pending delivery", async () => {
    const scenario = await seed();
    await start(scenario);
    const completed = {
      producer_event_id: "continuation-completed",
      producer_sequence: 2,
      type: "call.completed" as const,
      payload: { task_id: "task-cont", context_id: "context-cont", text: "done" },
    };
    await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: completed.type,
      authority: "agent_event",
      event: completed,
    });
    await transitionAgentCall({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      input: completed.type,
      authority: "agent_event",
      event: completed,
    });
    const outbox = (await db.select().from(controlPlaneOutboxEvent)).filter(
      (row) => row.eventType === "agent_call.continuation.requested",
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "agent_call.continuation.requested",
      aggregateId: scenario.callId,
      aggregateVersion: 3,
    });
    expect(outbox[0]?.eventKey).toContain("version:3");
    expect(outbox[0]?.payloadJson).toEqual({
      parent_invocation_id: scenario.parentInvocationId,
      agent_call_id: scenario.callId,
      source_version: 3,
      kind: "resume_parent",
    });
    const delivery = (await db.select().from(controlPlaneEventDelivery)).filter(
      (row) => row.eventId === outbox[0]?.id,
    );
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({
      consumerName: "invocation_continuation",
      state: "pending",
    });
  });

  it("事务失败时状态与 Continuation 一起回滚", async () => {
    const scenario = await seed();
    await start(scenario);
    await expect(
      db.transaction(async (tx) => {
        await applyAgentCallTransition(tx, {
          tenantId: scenario.tenantId,
          callId: scenario.callId,
          input: "call.completed",
          authority: "agent_event",
          event: {
            producer_event_id: "rollback-completed",
            producer_sequence: 2,
            type: "call.completed",
            payload: { task_id: "task-cont", context_id: "context-cont", text: "done" },
          },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(
      (await db.select().from(controlPlaneOutboxEvent)).filter(
        (row) => row.eventType === "agent_call.continuation.requested",
      ),
    ).toHaveLength(0);
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, scenario.callId));
    expect(call).toMatchObject({ state: "running", versionNo: 2 });
  });
});
