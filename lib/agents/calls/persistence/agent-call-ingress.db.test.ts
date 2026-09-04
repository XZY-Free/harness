import { ingestAgentCallEvents } from "@/lib/agents/calls/application/ingest-agent-call-events";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentCallEventIngressTable, agentCallTable } from "@/lib/persistence/schema/agent-calls";
import { asc, eq } from "drizzle-orm";
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

describe("AgentCall 单事件事务 Ingress", () => {
  it.each([
    [{ task_id: "task-1" }, "started_refs_incomplete"],
    [{ context_id: "context-1" }, "started_refs_incomplete"],
    [{}, "started_refs_incomplete"],
  ] as const)("started 标识不完整时提交 rejected", async (payload, reasonCode) => {
    const scenario = await seed();
    const result = await ingestAgentCallEvents({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      events: [
        {
          producer_event_id: `invalid-${Object.keys(payload).join("-") || "none"}`,
          producer_sequence: 1,
          type: "call.started",
          payload,
        },
      ],
    });
    expect(result.results[0]).toMatchObject({ outcome: "rejected", reasonCode });
    const [ingress] = await db.select().from(agentCallEventIngressTable);
    expect(ingress).toMatchObject({
      ingressState: "rejected",
      reasonCode,
      beforeVersionNo: 1,
      afterVersionNo: 1,
    });
  });

  it("批次按事件重载版本，保存每条处理前后版本", async () => {
    const scenario = await seed();
    const result = await ingestAgentCallEvents({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      events: [
        {
          producer_event_id: "batch-started",
          producer_sequence: 1,
          type: "call.started",
          payload: { task_id: "task-batch", context_id: "context-batch" },
        },
        {
          producer_event_id: "batch-completed",
          producer_sequence: 2,
          type: "call.completed",
          payload: {
            task_id: "task-batch",
            context_id: "context-batch",
            text: "complete",
          },
        },
      ],
    });
    expect(result.results).toMatchObject([
      { outcome: "applied", beforeVersionNo: 1, afterVersionNo: 2 },
      { outcome: "applied", beforeVersionNo: 2, afterVersionNo: 3 },
    ]);
    const rows = await db
      .select()
      .from(agentCallEventIngressTable)
      .orderBy(asc(agentCallEventIngressTable.producerSequence));
    expect(rows.map((row) => [row.beforeVersionNo, row.afterVersionNo])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it("重复 eventId 返回首次结果且不增加版本", async () => {
    const scenario = await seed();
    const event = {
      producer_event_id: "same-event",
      producer_sequence: 1,
      type: "call.started" as const,
      payload: { task_id: "task-same", context_id: "context-same" },
    };
    const first = await ingestAgentCallEvents({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      events: [event],
    });
    const replay = await ingestAgentCallEvents({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      events: [event],
    });
    expect(replay.results[0]).toEqual(first.results[0]);
    expect(await db.select().from(agentCallEventIngressTable)).toHaveLength(1);
    const [call] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, scenario.callId));
    expect(call?.versionNo).toBe(2);
  });

  it("供应方 eventId 缺失时使用规范化摘要形成稳定账本键并拒绝协议输入", async () => {
    const scenario = await seed();
    const invalid = {
      producer_event_id: "",
      producer_sequence: 1,
      type: "call.started" as const,
      payload: { task_id: "task-derived", context_id: "context-derived" },
    };
    await ingestAgentCallEvents({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      events: [invalid],
    });
    await ingestAgentCallEvents({
      tenantId: scenario.tenantId,
      callId: scenario.callId,
      events: [invalid],
    });
    const rows = await db.select().from(agentCallEventIngressTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ingressState: "rejected",
      reasonCode: "producer_event_id_invalid",
    });
    expect(rows[0]?.producerEventId).toMatch(/^derived:[0-9a-f]{64}$/);
  });
});
