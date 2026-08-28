/**
 * mysqlAgentCallStore 集成测试 — 真实 MySQL。
 *
 * 目标不变量：
 * 1. createIdempotent 幂等：同一 (parentInvocationId, logicalCallKey) 不重复创建。
 * 2. cross-tenant fail-closed：parent Invocation 不存在/异租户 → AgentCallParentInvocationError。
 * 3. create 统一事务：AgentCall + AgentCallBinding + 初始 Attempt(1) 原子。
 * 4. AgentCallBinding 不可变：getBinding 返回冻结配置，create 后无 update 路径。
 * 5. updateState 状态机 CAS：合法转移成功；from 不匹配 → AgentCallStateConcurrencyError。
 * 6. Attempt UNIQUE(callId, attemptNo)：createAttempt 幂等；recordOutbound 递增。
 * 7. getById/getBinding 按 tenantId 隔离。
 * 8. AgentCall 不越权修改 parent Invocation：create/updateState 后 parent Invocation 不变。
 */
import { randomUUID } from "node:crypto";
import { AgentCallBindingAlreadyExistsError } from "@/lib/agents/calls/domain/agent-call-binding";
import {
  AgentCallStateConcurrencyError,
  mysqlAgentCallStore,
} from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  D,
  seedInvocation,
  seedTenant,
  validBindingConfig,
} from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  agentCallAttemptTable,
  agentCallBindingTable,
  agentCallTable,
} from "@/lib/persistence/schema/agent-calls";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");

beforeEach(async () => {
  await resetDatabase(db);
});

function seedInput(
  tenantId: string,
  parentInvocationId: string,
  opts: {
    id?: string;
    logicalCallKey?: string | null;
    binding?: ReturnType<typeof validBindingConfig>;
  } = {},
) {
  return {
    id: opts.id ?? randomUUID(),
    tenantId,
    parentInvocationId,
    agentId: "agent-1",
    agentRevisionId: "agent-rev-1",
    sourceType: "user_selected" as const,
    sourceRef: "turn-1",
    logicalCallKey:
      "logicalCallKey" in opts ? (opts.logicalCallKey ?? null) : "required-agent:turn-1:agent-1",
    binding: opts.binding ?? validBindingConfig(),
    bindingHash: `sha256:${"0".repeat(64)}`,
    createdAt: NOW,
  };
}

const inputFor = seedInput;

describe("mysqlAgentCallStore", () => {
  it("createIdempotent 统一事务创建 AgentCall + Binding + Attempt(1)", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const result = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));

    expect(result.created).toBe(true);
    expect(result.call.parentInvocationId).toBe(parentId);
    expect(result.call.state).toBe("queued");
    expect(result.call.tenantId).toBe(tenantId);

    const binding = await mysqlAgentCallStore.getBinding({ callId: result.call.id, tenantId });
    expect(binding).toEqual(validBindingConfig());

    const [callRow] = await db
      .select()
      .from(agentCallTable)
      .where(eq(agentCallTable.id, result.call.id))
      .limit(1);
    expect(callRow).toBeTruthy();
    const [bindingRow] = await db
      .select()
      .from(agentCallBindingTable)
      .where(eq(agentCallBindingTable.callId, result.call.id))
      .limit(1);
    expect(bindingRow).toBeTruthy();
    const [attemptRow] = await db
      .select()
      .from(agentCallAttemptTable)
      .where(eq(agentCallAttemptTable.callId, result.call.id))
      .limit(1);
    expect(attemptRow?.attemptNo).toBe(1);
    expect(attemptRow?.dispatchAttemptCount).toBe(0);
  });

  it("createIdempotent 幂等：同 (parentInvocationId, logicalCallKey) 不重复创建", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const first = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));
    const second = await mysqlAgentCallStore.createIdempotent(
      inputFor(tenantId, parentId, { logicalCallKey: first.call.logicalCallKey }),
    );

    expect(second.created).toBe(false);
    expect(second.call.id).toBe(first.call.id);
    expect(second.binding).toEqual(first.binding);

    const count = await db.select({ c: agentCallTable.id }).from(agentCallTable);
    expect(count.length).toBe(1);
  });

  it("无 logicalCallKey 时不幂等（每次新建）", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    await mysqlAgentCallStore.createIdempotent(
      inputFor(tenantId, parentId, { logicalCallKey: null }),
    );
    await mysqlAgentCallStore.createIdempotent(
      inputFor(tenantId, parentId, { logicalCallKey: null }),
    );
    const count = await db.select({ c: agentCallTable.id }).from(agentCallTable);
    expect(count.length).toBe(2);
  });

  it("cross-tenant fail-closed：parent Invocation 不存在 → AgentCallParentInvocationError", async () => {
    const tenantId = await seedTenant();
    await expect(
      mysqlAgentCallStore.createIdempotent(inputFor(tenantId, "missing-invocation")),
    ).rejects.toThrow(/parent Invocation missing-invocation 不存在或不属于租户/);
    const count = await db.select({ c: agentCallTable.id }).from(agentCallTable);
    expect(count.length).toBe(0);
  });

  it("cross-tenant fail-closed：异租户 parent Invocation → 拒绝", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const parentA = await seedInvocation(tenantA);
    // 用 tenantB 的 AgentCall 指向 tenantA 的 Invocation。
    await expect(mysqlAgentCallStore.createIdempotent(inputFor(tenantB, parentA))).rejects.toThrow(
      /parent Invocation .* 不存在或不属于租户/,
    );
    const count = await db.select({ c: agentCallTable.id }).from(agentCallTable);
    expect(count.length).toBe(0);
  });

  it("getById / getBinding 按 tenantId 隔离", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const parentA = await seedInvocation(tenantA);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantA, parentA));

    // 异租户查询返回 null。
    expect(await mysqlAgentCallStore.getById({ callId: call.id, tenantId: tenantB })).toBeNull();
    expect(await mysqlAgentCallStore.getBinding({ callId: call.id, tenantId: tenantB })).toBeNull();
    // 同租户返回。
    expect((await mysqlAgentCallStore.getById({ callId: call.id, tenantId: tenantA }))?.id).toBe(
      call.id,
    );
    expect(await mysqlAgentCallStore.getBinding({ callId: call.id, tenantId: tenantA })).toEqual(
      validBindingConfig(),
    );
  });

  it("updateState 合法转移（queued→running→waiting_user→completed）", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));

    const running = await mysqlAgentCallStore.updateState({
      callId: call.id,
      tenantId,
      from: "queued",
      to: "running",
      now: NOW,
      externalTaskRef: "task-1",
    });
    expect(running.state).toBe("running");
    expect(running.externalTaskRef).toBe("task-1");
    expect(running.versionNo).toBe(2);

    const waiting = await mysqlAgentCallStore.updateState({
      callId: call.id,
      tenantId,
      from: "running",
      to: "waiting_user",
      now: NOW,
      lifecycle: { waitingAt: NOW },
    });
    expect(waiting.state).toBe("waiting_user");
    expect(waiting.waitingAt).toBeTruthy();

    const completed = await mysqlAgentCallStore.updateState({
      callId: call.id,
      tenantId,
      from: "waiting_user",
      to: "completed",
      now: NOW,
      lifecycle: { finishedAt: NOW },
      resultText: "ok",
    });
    expect(completed.state).toBe("completed");
    expect(completed.finishedAt).toBeTruthy();
    expect(completed.resultText).toBe("ok");
    expect(completed.versionNo).toBe(4);
  });

  it("updateState from 不匹配（并发冲突）→ AgentCallStateConcurrencyError", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));

    await expect(
      mysqlAgentCallStore.updateState({
        callId: call.id,
        tenantId,
        from: "running",
        to: "completed",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AgentCallStateConcurrencyError);
  });

  it("终态不可再转移（Store CAS 拒绝）", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));
    await mysqlAgentCallStore.updateState({
      callId: call.id,
      tenantId,
      from: "queued",
      to: "completed",
      now: NOW,
    });
    await expect(
      mysqlAgentCallStore.updateState({
        callId: call.id,
        tenantId,
        from: "completed",
        to: "running",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AgentCallStateConcurrencyError);
  });

  it("createAttempt UNIQUE(callId, attemptNo) 幂等：重复创建返回已存在", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));

    const a1 = await mysqlAgentCallStore.createAttempt({
      callId: call.id,
      tenantId,
      attemptNo: 1,
      now: NOW,
    });
    const a1again = await mysqlAgentCallStore.createAttempt({
      callId: call.id,
      tenantId,
      attemptNo: 1,
      now: NOW,
    });
    expect(a1again.attemptNo).toBe(1);
    expect(a1again.id).toBe(a1.id);

    const a2 = await mysqlAgentCallStore.createAttempt({
      callId: call.id,
      tenantId,
      attemptNo: 2,
      now: NOW,
    });
    expect(a2.attemptNo).toBe(2);
    expect(a2.id).not.toBe(a1.id);
  });

  it("recordOutbound 递增 dispatchAttemptCount", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));

    const one = await mysqlAgentCallStore.recordOutbound({
      callId: call.id,
      tenantId,
      attemptNo: 1,
    });
    expect(one.dispatchAttemptCount).toBe(1);
    const two = await mysqlAgentCallStore.recordOutbound({
      callId: call.id,
      tenantId,
      attemptNo: 1,
    });
    expect(two.dispatchAttemptCount).toBe(2);
  });

  it("AgentCall 不越权修改 parent Invocation：create/updateState 后 parent 不变", async () => {
    const tenantId = await seedTenant();
    const parentId = await seedInvocation(tenantId);
    const { call } = await mysqlAgentCallStore.createIdempotent(inputFor(tenantId, parentId));

    await mysqlAgentCallStore.updateState({
      callId: call.id,
      tenantId,
      from: "queued",
      to: "completed",
      now: NOW,
    });

    const [parentRow] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, parentId))
      .limit(1);
    expect(parentRow?.executionState).toBe("queued"); // 未被 AgentCall completed 触碰
    expect(parentRow?.finishedAt).toBeNull();
  });
});
