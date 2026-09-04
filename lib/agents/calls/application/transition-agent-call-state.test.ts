/**
 * transitionAgentCallState 应用服务集成测试 — 真实 MySQL。
 *
 * 目标不变量：
 * 1. 先由 domain 状态机校验（fail-closed：非法转移直接抛，不落库）。
 * 2. 合法转移经 Store CAS 持久化。
 * 3. 进入终态填 finishedAt；waiting_user 填 waitingAt；running 填 startedAt。
 * 4. AgentCall 状态独立于 parent Invocation（completed/failed 不触碰 parent）。
 */
import { createTransitionAgentCallState } from "@/lib/agents/calls/application/transition-agent-call-state";
import { AgentCallStateTransitionError } from "@/lib/agents/calls/domain/agent-call";
import { mysqlAgentCallStore } from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");
const transition = createTransitionAgentCallState({ store: mysqlAgentCallStore, now: () => NOW });
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

async function seedCall() {
  const scenario = await seedAgentCallExecutionScenario();
  scenarios.push(scenario);
  const call = await mysqlAgentCallStore.getById({
    callId: scenario.callId,
    tenantId: scenario.tenantId,
  });
  if (!call) throw new Error("测试 AgentCall 缺失");
  return { tenantId: scenario.tenantId, parentId: scenario.parentInvocationId, call };
}

describe("transitionAgentCallState 应用服务", () => {
  it("非法转移（queued→completed）fail-closed，不落库", async () => {
    const { tenantId, call } = await seedCall();
    await expect(
      transition({ callId: call.id, tenantId, from: "queued", to: "completed", now: NOW }),
    ).rejects.toBeInstanceOf(AgentCallStateTransitionError);
    const [row] = await db.select().from(invocationTable); // 仅确保无副作用
    expect(row).toBeTruthy();
  });

  it("进入终态自动填 finishedAt；running 自动填 startedAt", async () => {
    const { tenantId, call } = await seedCall();

    const running = await transition({
      callId: call.id,
      tenantId,
      from: "queued",
      to: "running",
      now: NOW,
    });
    expect(running.state).toBe("running");
    expect(running.startedAt).toBeTruthy();
    expect(running.currentAttempt?.externalTaskRef).toBeNull();

    const completed = await transition({
      callId: call.id,
      tenantId,
      from: "running",
      to: "completed",
      now: NOW,
    });
    expect(completed.state).toBe("completed");
    expect(completed.finishedAt).toBeTruthy();
  });

  it("waiting_user 自动填 waitingAt，可 resume 回 running", async () => {
    const { tenantId, call } = await seedCall();
    await transition({ callId: call.id, tenantId, from: "queued", to: "running", now: NOW });
    const waiting = await transition({
      callId: call.id,
      tenantId,
      from: "running",
      to: "waiting_user",
      now: NOW,
    });
    expect(waiting.waitingAt).toBeTruthy();
    const resumed = await transition({
      callId: call.id,
      tenantId,
      from: "waiting_user",
      to: "running",
      now: NOW,
    });
    expect(resumed.state).toBe("running");
  });

  it("AgentCall failed 不自动修改 parent Invocation", async () => {
    const { tenantId, parentId, call } = await seedCall();
    await transition({ callId: call.id, tenantId, from: "queued", to: "running", now: NOW });
    await transition({
      callId: call.id,
      tenantId,
      from: "running",
      to: "failed",
      errorCode: "E1",
      now: NOW,
    });

    const [parentRow] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, parentId))
      .limit(1);
    expect(parentRow?.executionState).toBe("running");
    expect(parentRow?.finishedAt).toBeNull();
  });

  it("failed 携带 errorCode/errorSummary", async () => {
    const { tenantId, call } = await seedCall();
    await transition({ callId: call.id, tenantId, from: "queued", to: "running", now: NOW });
    const failed = await transition({
      callId: call.id,
      tenantId,
      from: "running",
      to: "failed",
      errorCode: "E2",
      errorSummary: "boom",
      now: NOW,
    });
    expect(failed.errorCode).toBe("E2");
    expect(failed.errorSummary).toBe("boom");
  });
});
