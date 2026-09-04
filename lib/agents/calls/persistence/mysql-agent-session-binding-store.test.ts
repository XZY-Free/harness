/**
 * mysqlAgentSessionBindingStore 集成测试 — 真实 MySQL。
 *
 * 目标不变量：
 * 1. A2A contextId 属于 AgentSessionBinding.externalContextRef（冻结映射）。
 * 2. create 幂等：UNIQUE(tenantId, externalContextRef) 且完整 Authority 一致时返回已存在。
 * 3. getByContext 按 (tenantId, agentId, externalContextRef) 精确查找，跨租户隔离。
 * 4. close 仅 active→closed；markLost 仅 active→lost；非 active 抛 AgentSessionBindingStateError。
 */
import { randomUUID } from "node:crypto";
import {
  AgentSessionBindingStateError,
  mysqlAgentSessionBindingStore,
} from "@/lib/agents/calls/persistence/mysql-agent-session-binding-store";
import { seedTenant } from "@/lib/agents/calls/test/agent-call-test-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentSessionBindingTable } from "@/lib/persistence/schema/agent-calls";
import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = new Date("2026-08-28T00:00:00.000Z");

beforeEach(async () => {
  await resetDatabase(db);
});

function inputFor(
  tenantId: string,
  overrides: Partial<{ id: string; externalContextRef: string }> = {},
) {
  return {
    id: overrides.id ?? randomUUID(),
    tenantId,
    threadId: "thread-1",
    agentId: "agent-1",
    agentRevisionId: "agent-rev-1",
    deploymentRouteId: "route-1",
    routeRevisionId: "route-rev-1",
    externalContextRef: overrides.externalContextRef ?? "a2a-context-1",
    now: NOW,
  };
}

describe("mysqlAgentSessionBindingStore", () => {
  it("create 建 active 会话，externalContextRef 持 A2A contextId", async () => {
    const tenantId = await seedTenant();
    const s = await mysqlAgentSessionBindingStore.create(inputFor(tenantId));
    expect(s.bindingState).toBe("active");
    expect(s.externalContextRef).toBe("a2a-context-1");
    expect(s.closedAt).toBeNull();
  });

  it("create 幂等：同 tenant/context 且完整 Authority 一致时返回已存在", async () => {
    const tenantId = await seedTenant();
    const a = await mysqlAgentSessionBindingStore.create(inputFor(tenantId));
    const b = await mysqlAgentSessionBindingStore.create(inputFor(tenantId));
    expect(b.id).toBe(a.id);
    const [cnt] = await db.select({ c: count() }).from(agentSessionBindingTable);
    expect(cnt).toBeTruthy();
    expect(cnt!.c).toBe(1);
  });

  it("create 非幂等：不同 externalContextRef 建不同会话", async () => {
    const tenantId = await seedTenant();
    const a = await mysqlAgentSessionBindingStore.create(
      inputFor(tenantId, { externalContextRef: "ctx-1" }),
    );
    const b = await mysqlAgentSessionBindingStore.create(
      inputFor(tenantId, { externalContextRef: "ctx-2" }),
    );
    expect(a.id).not.toBe(b.id);
  });

  it("getByContext 精确命中，跨租户隔离", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const s = await mysqlAgentSessionBindingStore.create(
      inputFor(tenantA, { externalContextRef: "ctx-x" }),
    );

    expect(
      (
        await mysqlAgentSessionBindingStore.getByContext({
          tenantId: tenantA,
          agentId: "agent-1",
          externalContextRef: "ctx-x",
        })
      )?.id,
    ).toBe(s.id);
    expect(
      await mysqlAgentSessionBindingStore.getByContext({
        tenantId: tenantB,
        agentId: "agent-1",
        externalContextRef: "ctx-x",
      }),
    ).toBeNull();
    expect(
      await mysqlAgentSessionBindingStore.getByContext({
        tenantId: tenantA,
        agentId: "agent-other",
        externalContextRef: "ctx-x",
      }),
    ).toBeNull();
  });

  it("close 仅 active→closed", async () => {
    const tenantId = await seedTenant();
    const s = await mysqlAgentSessionBindingStore.create(inputFor(tenantId));
    const closed = await mysqlAgentSessionBindingStore.close({ id: s.id, tenantId, now: NOW });
    expect(closed.bindingState).toBe("closed");
    expect(closed.closedAt).toBeTruthy();

    // 已 closed 再 close → 抛错。
    await expect(
      mysqlAgentSessionBindingStore.close({ id: s.id, tenantId, now: NOW }),
    ).rejects.toBeInstanceOf(AgentSessionBindingStateError);
  });

  it("markLost 仅 active→lost", async () => {
    const tenantId = await seedTenant();
    const s = await mysqlAgentSessionBindingStore.create(inputFor(tenantId));
    const lost = await mysqlAgentSessionBindingStore.markLost({ id: s.id, tenantId, now: NOW });
    expect(lost.bindingState).toBe("lost");
    expect(lost.closedAt).toBeTruthy();
  });

  it("close / markLost 跨租户不可见（找不到 → 抛错）", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const s = await mysqlAgentSessionBindingStore.create(inputFor(tenantA));
    await expect(
      mysqlAgentSessionBindingStore.close({ id: s.id, tenantId: tenantB, now: NOW }),
    ).rejects.toBeInstanceOf(AgentSessionBindingStateError);
  });

  it("同 tenant/context 不同 RouteRevision 稳定拒绝关联冲突", async () => {
    const tenantId = await seedTenant();
    const a = await mysqlAgentSessionBindingStore.create(
      inputFor(tenantId, { externalContextRef: "ctx" }),
    );
    await expect(
      mysqlAgentSessionBindingStore.create({
        ...inputFor(tenantId, { externalContextRef: "ctx" }),
        routeRevisionId: "route-rev-2",
      }),
    ).rejects.toThrow("AgentSessionBinding 关联冲突");
    expect(
      await db
        .select()
        .from(agentSessionBindingTable)
        .where(eq(agentSessionBindingTable.tenantId, tenantId)),
    ).toHaveLength(1);
    expect(a.routeRevisionId).toBe("route-rev-1");
  });

  it("跨租户 create：异租户同 (agentRevision, routeRevision, externalContextRef) 不得复用已有会话", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const a = await mysqlAgentSessionBindingStore.create(
      inputFor(tenantA, { externalContextRef: "ctx-shared" }),
    );
    // 租户 B 用同一 agentRevision/routeRevision/externalContextRef 建会话。
    // 期望：fail-closed（首选，同一 externalContextRef 不能属于第二个 owner）或返回独立行；
    // 但绝不返回租户 A 的会话。
    // 当前实现：UNIQUE 不含 tenant → B 命中唯一键 → 回查未按 tenant 过滤 → 返回 A 的会话（RED）。
    const outcome = await captureCreate(() =>
      mysqlAgentSessionBindingStore.create(inputFor(tenantB, { externalContextRef: "ctx-shared" })),
    );
    if (outcome.ok) {
      expect(outcome.value.id).not.toBe(a.id);
      expect(outcome.value.tenantId).toBe(tenantB);
    }
    // 若 fail-closed（抛错）则通过；未抛错时必须不是 A 的会话。当前实现抛不出错 → 落入上面断言 → RED。
  });

  it("同上下文不同 thread 不得复用会话（thread 是隔离匹配维度）", async () => {
    const tenantId = await seedTenant();
    const a = await mysqlAgentSessionBindingStore.create({
      ...inputFor(tenantId, { externalContextRef: "ctx-thread" }),
      threadId: "thread-1",
    });
    // 同 tenant、同 agentRevision/routeRevision/context，但 thread 不同。
    // 期望：fail-closed（抛错）或返回 thread-2 独立行；绝不返回 thread-1 会话。
    // 当前实现：UNIQUE(agentRevision, routeRevision, context) 不含 thread → 返回 thread-1 会话（RED）。
    const outcome = await captureCreate(() =>
      mysqlAgentSessionBindingStore.create({
        ...inputFor(tenantId, { externalContextRef: "ctx-thread" }),
        threadId: "thread-2",
      }),
    );
    if (outcome.ok) {
      expect(outcome.value.id).not.toBe(a.id);
      expect(outcome.value.threadId).toBe("thread-2");
    }
  });
});

/** 尝试 create 并捕获结果：返回 { ok, value } 或 { ok:false }（失败即 fail-closed，可接受）。 */
async function captureCreate<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}
