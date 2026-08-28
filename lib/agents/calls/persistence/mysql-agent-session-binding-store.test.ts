/**
 * mysqlAgentSessionBindingStore 集成测试 — 真实 MySQL。
 *
 * 目标不变量：
 * 1. A2A contextId 属于 AgentSessionBinding.externalContextRef（冻结映射）。
 * 2. create 幂等：UNIQUE(agentRevisionId, routeRevisionId, externalContextRef) 冲突返回已存在。
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

  it("create 幂等：UNIQUE(agentRevisionId, routeRevisionId, externalContextRef) 返回已存在", async () => {
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

  it("同 Agent 不同 RouteRevision 各自独立会话（隔离匹配维度）", async () => {
    const tenantId = await seedTenant();
    const a = await mysqlAgentSessionBindingStore.create(
      inputFor(tenantId, { externalContextRef: "ctx" }),
    );
    const b = await mysqlAgentSessionBindingStore.create({
      ...inputFor(tenantId, { externalContextRef: "ctx" }),
      routeRevisionId: "route-rev-2",
    });
    expect(a.id).not.toBe(b.id);
  });
});
