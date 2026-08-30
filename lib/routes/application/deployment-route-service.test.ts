/**
 * DeploymentRoute 查询与 RouteSet 标识创建集成测试（真实 MySQL 8）。
 *
 * Route 写入只由 ActivateRouteSet 与 DisableRoute 各自的测试覆盖。
 *
 * 专题01 冻结架构：RouteSet target 必须显式判别——
 * - runtime：{kind:"runtime"}，持久化 targetKind=runtime、targetIdentity=runtime、agentId=NULL。
 * - agent：{kind:"agent", agentId}，持久化 targetKind=agent、targetIdentity=agentId、agentId=agentId。
 * - UNIQUE(tenantId,targetKind,targetIdentity,routeScopeKey)，杜绝 runtime NULL 绕过唯一性。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { deploymentRouteSetTable } from "@/lib/persistence/schema/routes";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRouteSet,
  ensureRouteSetByTargetScope,
  getRouteById,
  getRouteSetById,
  getRouteSetByTargetScope,
  listRoutesBySet,
} from "./deployment-route-service";

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedAgent() {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "route-owner",
    email: "route-owner@example.com",
    displayName: "Route Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "route-agent",
    displayName: "Route Agent",
    ownerUserId: owner.id,
  });
  return { tenantId: tenant.id, agentId: agent.id };
}

describe("DeploymentRoute query service", () => {
  it("创建 RouteSet 后可按 ID 与 target scope 精确读取", async () => {
    const fixture = await seedAgent();
    const routeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "agent" as const, agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });

    expect(routeSet.versionNo).toBe(1);
    expect(routeSet.targetKind).toBe("agent");
    expect(routeSet.targetIdentity).toBe(fixture.agentId);
    expect(routeSet.agentId).toBe(fixture.agentId);
    expect(await getRouteSetById(fixture.tenantId, routeSet.id)).toEqual(routeSet);
    expect(
      await getRouteSetByTargetScope(
        fixture.tenantId,
        { kind: "agent", agentId: fixture.agentId },
        "prod",
      ),
    ).toEqual(routeSet);
  });

  it("tenant 不一致时隐藏 RouteSet", async () => {
    const fixture = await seedAgent();
    const routeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });

    expect(await getRouteSetById("11111111-1111-4111-8111-111111111111", routeSet.id)).toBeNull();
    expect(
      await getRouteSetByTargetScope(
        "11111111-1111-4111-8111-111111111111",
        { kind: "agent", agentId: fixture.agentId },
        "prod",
      ),
    ).toBeNull();
  });

  it("同 tenant、agent、scope 不能创建重复 RouteSet", async () => {
    const fixture = await seedAgent();
    const command = {
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: {},
    } as const;
    await createRouteSet(command);
    await expect(createRouteSet(command)).rejects.toThrow();
  });

  it("未激活 Route 时查询为空", async () => {
    const fixture = await seedAgent();
    const routeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });

    expect(await listRoutesBySet(routeSet.id)).toEqual([]);
    expect(await getRouteById(fixture.tenantId, "missing-route")).toBeNull();
  });

  it("runtime RouteSet 同 tenant/scope 重复创建被 UNIQUE 拒绝（NULL 不绕过）", async () => {
    const fixture = await seedAgent();
    const command = {
      tenantId: fixture.tenantId,
      target: { kind: "runtime" as const },
      routeScopeKey: "prod",
      routeScopeJson: {},
    };
    await createRouteSet(command);
    await expect(createRouteSet(command)).rejects.toThrow();
  });

  it("runtime 与 agent A 相同 tenant/scope 可共存（显式 target 判别）", async () => {
    const fixture = await seedAgent();
    const runtimeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "runtime" },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    const agentSet = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "agent" as const, agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });

    const rows = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(
        and(
          eq(deploymentRouteSetTable.tenantId, fixture.tenantId),
          eq(deploymentRouteSetTable.routeScopeKey, "prod"),
        ),
      )
      .orderBy(deploymentRouteSetTable.createdAt);
    expect(rows.map((r) => r.id)).toEqual([runtimeSet.id, agentSet.id]);
    // 显式判别：runtime 行 targetKind=runtime、targetIdentity=runtime、agentId 空；
    // agent 行 targetKind=agent、targetIdentity=agentId、agentId=agentId。
    expect(runtimeSet.targetKind).toBe("runtime");
    expect(runtimeSet.targetIdentity).toBe("runtime");
    expect(runtimeSet.agentId).toBeNull();
    expect(agentSet.targetKind).toBe("agent");
    expect(agentSet.targetIdentity).toBe(fixture.agentId);
    expect(agentSet.agentId).toBe(fixture.agentId);
  });
});

describe("专题01 显式 target API", () => {
  it("createRouteSet 接受显式 target:{kind:'runtime'} 并持久化 runtime 目标", async () => {
    const fixture = await seedAgent();
    const row = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "runtime" },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    expect(row.targetKind).toBe("runtime");
    expect(row.targetIdentity).toBe("runtime");
    expect(row.agentId).toBeNull();
  });

  it("createRouteSet 接受显式 target:{kind:'agent',agentId} 并持久化 agent 目标", async () => {
    const fixture = await seedAgent();
    const row = await createRouteSet({
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    expect(row.targetKind).toBe("agent");
    expect(row.targetIdentity).toBe(fixture.agentId);
    expect(row.agentId).toBe(fixture.agentId);
  });

  it("createRouteSet 无 nullable agentId：legacy agentId 形状必须被拒绝", async () => {
    const fixture = await seedAgent();
    const legacyArgs = {
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    } as unknown as Parameters<typeof createRouteSet>[0];
    await expect(createRouteSet(legacyArgs)).rejects.toThrow();
  });

  it("ensureRouteSetByTargetScope 并发竞争返回单行且 created 恰好一 true 一 false", async () => {
    const fixture = await seedAgent();
    const command = {
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: { zone: "cn-north" },
    } as const;
    const [a, b] = await Promise.all([
      ensureRouteSetByTargetScope(command),
      ensureRouteSetByTargetScope(command),
    ]);
    // 唯一性落败方回读复用同一 RouteSet → 两返回值持有相同 routeSet.id，Set 去重后恰一个。
    const routeSetIds = new Set([a.routeSet.id, b.routeSet.id]);
    const ids = [...routeSetIds].filter(Boolean);
    expect(ids.length).toBe(1);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it("ensureRouteSetByTargetScope 校验不可变 routeScopeJson（语义不一致 fail-closed）", async () => {
    const fixture = await seedAgent();
    await ensureRouteSetByTargetScope({
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: { zone: "cn-north" },
    });
    await expect(
      ensureRouteSetByTargetScope({
        tenantId: fixture.tenantId,
        target: { kind: "agent", agentId: fixture.agentId },
        routeScopeKey: "prod",
        routeScopeJson: { zone: "us-east" },
      }),
    ).rejects.toThrow(/scope/i);
  });

  it("getRouteSetByTargetScope 精确命中 runtime vs agent target", async () => {
    const fixture = await seedAgent();
    await ensureRouteSetByTargetScope({
      tenantId: fixture.tenantId,
      target: { kind: "runtime" },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    await ensureRouteSetByTargetScope({
      tenantId: fixture.tenantId,
      target: { kind: "agent", agentId: fixture.agentId },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    const runtime = await getRouteSetByTargetScope(fixture.tenantId, { kind: "runtime" }, "prod");
    const agent = await getRouteSetByTargetScope(
      fixture.tenantId,
      { kind: "agent", agentId: fixture.agentId },
      "prod",
    );
    expect(runtime).not.toBeNull();
    expect(agent).not.toBeNull();
    expect(runtime!.id).not.toBe(agent!.id);
  });

  it("getRouteSetByTargetScope 保持租户隔离（跨 tenant 隐藏）", async () => {
    const fixture = await seedAgent();
    await ensureRouteSetByTargetScope({
      tenantId: fixture.tenantId,
      target: { kind: "runtime" },
      routeScopeKey: "prod",
      routeScopeJson: {},
    });
    const other = await getRouteSetByTargetScope(
      "11111111-1111-4111-8111-111111111111",
      { kind: "runtime" },
      "prod",
    );
    expect(other).toBeNull();
  });

  it("空 agentId 在 DB 写入前被服务拒绝", async () => {
    const fixture = await seedAgent();
    await expect(
      createRouteSet({
        tenantId: fixture.tenantId,
        target: { kind: "agent", agentId: "" },
        routeScopeKey: "prod",
        routeScopeJson: {},
      }),
    ).rejects.toThrow();
  });

  it("空白 agentId 在 DB 写入前被服务拒绝", async () => {
    const fixture = await seedAgent();
    await expect(
      createRouteSet({
        tenantId: fixture.tenantId,
        target: { kind: "agent", agentId: "   " },
        routeScopeKey: "prod",
        routeScopeJson: {},
      }),
    ).rejects.toThrow();
  });

  it("缺失 target 在 DB 写入前被服务拒绝（legacy nullable 形状）", async () => {
    const fixture = await seedAgent();
    const malformed = {
      tenantId: fixture.tenantId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    } as unknown as Parameters<typeof createRouteSet>[0];
    await expect(createRouteSet(malformed)).rejects.toThrow();
  });

  it("空/空白 routeScopeKey 在 DB 写入前被服务拒绝", async () => {
    const fixture = await seedAgent();
    for (const bad of ["", "   "]) {
      await expect(
        createRouteSet({
          tenantId: fixture.tenantId,
          target: { kind: "runtime" },
          routeScopeKey: bad,
          routeScopeJson: {},
        }),
      ).rejects.toThrow();
    }
  });

  it("旧 ensureRouteSetByAgentScope / getRouteSetByAgentScope 导出必须移除（API shape）", async () => {
    const svc = (await import("./deployment-route-service")) as unknown as Record<string, unknown>;
    expect(svc.ensureRouteSetByAgentScope).toBeUndefined();
    expect(svc.getRouteSetByAgentScope).toBeUndefined();
  });
});
