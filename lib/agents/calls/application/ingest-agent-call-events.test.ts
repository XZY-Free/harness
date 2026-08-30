/**
 * ingestAgentCallEvents 应用服务集成测试 — 真实 MySQL。
 *
 * 覆盖 AgentCallEventIngress 原子应用子生命周期，绝不触碰 parent 生命周期。
 *
 * 应用 API：
 *   ingestAgentCallEvents({ tenantId, callId, events })
 * events 使用 AgentCallCandidateEvent 字段（transport/agent-transport.ts）：
 *   producer_event_id / producer_sequence / type / payload(task_id/context_id 关联、
 *   completed text/data、input_required prompt/schema)。
 *
 * 不变量：
 * - A2A taskId → AgentCall.externalTaskRef；A2A contextId → AgentSessionBinding.externalContextRef。
 * - completed/failed/lost/waiting_user/cancelled 绝不复用 parent 生命周期：
 *   不写 parent Invocation / RuntimeSessionBinding / RuntimeEventIngress / Turn / ThreadItems。
 * - Thread 关联只来自可信 parent Invocation.threadId；parent 无 thread（Job）则不建会话。
 * - canonical hash 含事件 TYPE（非仅 payload）与 data。
 */
import { randomUUID } from "node:crypto";
import { ingestAgentCallEvents } from "@/lib/agents/calls/application/ingest-agent-call-events";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { seedTenant } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import type { AgentCallCandidateEvent } from "@/lib/agents/calls/transport/agent-transport";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallEventIngressTable,
  agentCallTable,
  agentSessionBindingTable,
} from "@/lib/persistence/schema/agent-calls";
import { invocationTable, runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");
const scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(async () => {
  for (const scenario of scenarios.splice(0)) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.server.close();
  }
});

/** Invocation.threadId 为逻辑非 FK 列（无 references），可安全写入任意 UUID。 */
async function seedRunningCall(threadId?: string) {
  const scenario = await seedAgentCallExecutionScenario();
  scenarios.push(scenario);
  const tenantId = scenario.tenantId;
  const parentId = scenario.parentInvocationId;
  await db
    .update(invocationTable)
    .set({ threadId: threadId ?? null, executionState: "running", runtimeExecutionRef: null })
    .where(eq(invocationTable.id, parentId));
  const call = await mysqlAgentCallStore.getById({ callId: scenario.callId, tenantId });
  if (!call) throw new Error("测试 AgentCall 缺失");
  await mysqlAgentCallStore.updateState({
    callId: call.id,
    tenantId,
    from: "queued",
    to: "running",
    now: NOW,
    lifecycle: { startedAt: NOW },
  });
  return { tenantId, parentId, call };
}

function ev(
  o: Partial<AgentCallCandidateEvent> & { type: AgentCallCandidateEvent["type"] },
): AgentCallCandidateEvent {
  return {
    producer_event_id: o.producer_event_id ?? `evt-${randomUUID()}`,
    producer_sequence: o.producer_sequence ?? 1,
    payload: o.payload ?? {},
    ...o,
  };
}

/** 吞掉拒绝类异常：期望 reject 的调用返回 true，否则 false（不强制创建/不测返回值）。 */
async function rejects(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch {
    return true;
  }
}

describe("ingestAgentCallEvents 原子应用与生命周期边界", () => {
  it("started+completed 原子绑定 task/context/session，结果 text+data+digest，attempt 终态，ingress 全 mapped，parent/runtime 不变", async () => {
    const { tenantId, parentId, call } = await seedRunningCall("thread-1");
    await ingestAgentCallEvents({
      tenantId,
      callId: call.id,
      events: [
        ev({
          type: "call.started",
          producer_event_id: "evt-start",
          producer_sequence: 1,
          payload: { task_id: "task-1", context_id: "ctx-1" },
        }),
        ev({
          type: "call.completed",
          producer_event_id: "evt-done",
          producer_sequence: 2,
          payload: { task_id: "task-1", context_id: "ctx-1", text: "done", data: { n: 1 } },
        }),
      ],
    });
    const [callRow] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(callRow?.state).toBe("completed");
    expect(callRow?.externalTaskRef).toBe("task-1");
    expect(callRow?.externalContextRef).toBe("ctx-1");
    expect(callRow?.resultText).toBe("done");
    expect(callRow?.resultJson).toEqual({ n: 1 });
    expect(callRow?.resultDigest).toMatch(/^sha256:/);
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, call.id));
    expect(attempt?.attemptState).toBe("completed");
    const [session] = await db.select().from(agentSessionBindingTable);
    expect(session?.externalContextRef).toBe("ctx-1");
    expect(session?.tenantId).toBe(tenantId);
    expect(session?.threadId).toBe("thread-1");
    const ingress = await db.select().from(agentCallEventIngressTable);
    expect(ingress).toHaveLength(2);
    for (const r of ingress) expect(r.ingressState).toBe("mapped");
    const [parentRow] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, parentId));
    expect(parentRow?.executionState).toBe("running");
    expect(parentRow?.finishedAt).toBeNull();
    expect(parentRow?.runtimeExecutionRef).toBeNull();
    expect(await db.select().from(runtimeEventIngressTable)).toHaveLength(0);
  });

  it("input_required/failed/cancelled/lost 各自仅子状态，input prompt/schema 保留，parent 不变", async () => {
    for (const [type, state, terminal] of [
      ["call.input_required", "waiting_user", false],
      ["call.failed", "failed", true],
      ["call.cancelled", "cancelled", true],
      ["call.lost", "lost", true],
    ] as const) {
      // 每次迭代用唯一 threadId，避免 (threadId, invocationSequence) 唯一索引在循环内撞键。
      const { tenantId, parentId, call } = await seedRunningCall(`thread-${type}`);
      const payload =
        type === "call.input_required"
          ? { task_id: "t", context_id: "c", prompt: "need more", schema: { kind: "form" } }
          : { task_id: "t", context_id: "c" };
      await ingestAgentCallEvents({
        tenantId,
        callId: call.id,
        events: [ev({ type, producer_event_id: `evt-${type}`, producer_sequence: 1, payload })],
      });
      const [callRow] = await db
        .select()
        .from(agentCallTable)
        .where(eq(agentCallTable.id, call.id));
      expect(callRow?.state).toBe(state);
      if (terminal) expect(callRow?.finishedAt).toBeTruthy();
      else expect(callRow?.waitingAt).toBeTruthy();
      const [ing] = await db
        .select()
        .from(agentCallEventIngressTable)
        .where(eq(agentCallEventIngressTable.producerEventId, `evt-${type}`));
      if (type === "call.input_required")
        expect(ing?.payloadJson).toMatchObject({ prompt: "need more", schema: { kind: "form" } });
      const [parentRow] = await db
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, parentId));
      expect(parentRow?.executionState).toBe("running");
      expect(parentRow?.finishedAt).toBeNull();
    }
  });

  it("重复回放幂等；同 key 改 payload/type 冲突且无状态变更；异租户同 key 不透出", async () => {
    const { tenantId, call } = await seedRunningCall("thread-1");
    const otherTenant = await seedTenant();
    const batch = {
      tenantId,
      callId: call.id,
      events: [
        ev({
          type: "call.completed",
          producer_event_id: "evt-done",
          producer_sequence: 1,
          payload: { text: "x" },
        }),
      ],
    };
    await ingestAgentCallEvents(batch);
    await ingestAgentCallEvents(batch); // 重复回放
    expect(await db.select().from(agentCallEventIngressTable)).toHaveLength(1);
    const [callRow] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(callRow?.versionNo).toBe(3);
    const first = batch.events[0]!;
    expect(
      await rejects(() =>
        ingestAgentCallEvents({ ...batch, events: [{ ...first, payload: { text: "DIFFERENT" } }] }),
      ),
    ).toBe(true);
    expect(
      await rejects(() =>
        ingestAgentCallEvents({ ...batch, events: [{ ...first, type: "call.failed" }] }),
      ),
    ).toBe(true);
    expect(
      await rejects(() =>
        ingestAgentCallEvents({ tenantId: otherTenant, callId: call.id, events: batch.events }),
      ),
    ).toBe(true);
    const rows = await db.select().from(agentCallEventIngressTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantId);
    const [after] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(after?.state).toBe("completed");
    expect(after?.resultText).toBe("x");
  });

  it("task/context 关联不匹配、中途非法事件 -> call/session/ingress/attempt 整批回滚", async () => {
    const { tenantId, call } = await seedRunningCall("thread-1");
    // 关联不匹配：started 绑 task-1，completed 报 task-9。
    expect(
      await rejects(() =>
        ingestAgentCallEvents({
          tenantId,
          callId: call.id,
          events: [
            ev({
              type: "call.started",
              producer_event_id: "e1",
              producer_sequence: 1,
              payload: { task_id: "task-1", context_id: "c" },
            }),
            ev({
              type: "call.completed",
              producer_event_id: "e2",
              producer_sequence: 2,
              payload: { task_id: "task-9", context_id: "c", text: "x" },
            }),
          ],
        }),
      ),
    ).toBe(true);
    let [callRow] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(callRow?.state).toBe("running");
    expect(callRow?.externalTaskRef).toBeNull();
    // 中途非法事件：合法 started 后跟不支持类型。
    expect(
      await rejects(() =>
        ingestAgentCallEvents({
          tenantId,
          callId: call.id,
          events: [
            ev({
              type: "call.started",
              producer_event_id: "e3",
              producer_sequence: 3,
              payload: { task_id: "t", context_id: "c" },
            }),
            ev({
              type: "call.unsupported" as AgentCallCandidateEvent["type"],
              producer_event_id: "e4",
              producer_sequence: 4,
              payload: {},
            }),
          ],
        }),
      ),
    ).toBe(true);
    [callRow] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(callRow?.state).toBe("running");
    expect(callRow?.externalTaskRef).toBeNull();
    expect(await db.select().from(agentSessionBindingTable)).toHaveLength(0);
    expect(await db.select().from(agentCallEventIngressTable)).toHaveLength(0);
    const [attempt] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, call.id));
    expect(attempt?.attemptState).toBe("queued");
  });

  it("session thread 只来自 parent；parent 无 thread 不建会话；同 refs 异 owner 拒绝", async () => {
    const { tenantId, call } = await seedRunningCall();
    await ingestAgentCallEvents({
      tenantId,
      callId: call.id,
      events: [
        ev({
          type: "call.started",
          producer_event_id: "e1",
          producer_sequence: 1,
          payload: { task_id: "task-job", context_id: "ctx-job" },
        }),
      ],
    });
    const [callRow] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(callRow?.externalTaskRef).toBe("task-job");
    expect(await db.select().from(agentSessionBindingTable)).toHaveLength(0); // Job 无 thread 不建会话
    // 同 task/context refs 但不同 owner（异租户）拒绝，不建跨租户会话。
    const otherTenant = await seedTenant();
    const { call: call2 } = await seedRunningCall("thread-x");
    expect(
      await rejects(() =>
        ingestAgentCallEvents({
          tenantId: otherTenant,
          callId: call2.id,
          events: [
            ev({
              type: "call.started",
              producer_event_id: "e9",
              producer_sequence: 1,
              payload: { task_id: "task-job", context_id: "ctx-job" },
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("终态后迟到事件不可改状态/结果", async () => {
    const { tenantId, call } = await seedRunningCall("thread-1");
    await ingestAgentCallEvents({
      tenantId,
      callId: call.id,
      events: [
        ev({
          type: "call.completed",
          producer_event_id: "evt-done",
          producer_sequence: 1,
          payload: { text: "final" },
        }),
      ],
    });
    expect(
      await rejects(() =>
        ingestAgentCallEvents({
          tenantId,
          callId: call.id,
          events: [
            ev({
              type: "call.failed",
              producer_event_id: "evt-late",
              producer_sequence: 2,
              payload: { error: "late" },
            }),
          ],
        }),
      ),
    ).toBe(true);
    const [callRow] = await db.select().from(agentCallTable).where(eq(agentCallTable.id, call.id));
    expect(callRow?.state).toBe("completed");
    expect(callRow?.resultText).toBe("final");
    expect(callRow?.errorCode).toBeNull();
  });
});
