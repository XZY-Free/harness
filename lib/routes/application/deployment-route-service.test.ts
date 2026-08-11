/**
 * DeploymentRoute 查询与 RouteSet 标识创建集成测试（真实 MySQL 8）。
 *
 * Route 写入只由 ActivateRouteSet 与 DisableRoute 各自的测试覆盖。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRouteSet,
  getRouteById,
  getRouteSetByAgentScope,
  getRouteSetById,
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
  it("创建 RouteSet 后可按 ID 与 agent scope 精确读取", async () => {
    const fixture = await seedAgent();
    const routeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });

    expect(routeSet.versionNo).toBe(1);
    expect(await getRouteSetById(fixture.tenantId, routeSet.id)).toEqual(routeSet);
    expect(await getRouteSetByAgentScope(fixture.tenantId, fixture.agentId, "prod")).toEqual(
      routeSet,
    );
  });

  it("tenant 不一致时隐藏 RouteSet", async () => {
    const fixture = await seedAgent();
    const routeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    });

    expect(await getRouteSetById("11111111-1111-4111-8111-111111111111", routeSet.id)).toBeNull();
    expect(
      await getRouteSetByAgentScope(
        "11111111-1111-4111-8111-111111111111",
        fixture.agentId,
        "prod",
      ),
    ).toBeNull();
  });

  it("同 tenant、agent、scope 不能创建重复 RouteSet", async () => {
    const fixture = await seedAgent();
    const command = {
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    };
    await createRouteSet(command);
    await expect(createRouteSet(command)).rejects.toThrow();
  });

  it("未激活 Route 时查询为空", async () => {
    const fixture = await seedAgent();
    const routeSet = await createRouteSet({
      tenantId: fixture.tenantId,
      agentId: fixture.agentId,
      routeScopeKey: "prod",
      routeScopeJson: {},
    });

    expect(await listRoutesBySet(routeSet.id)).toEqual([]);
    expect(await getRouteById(fixture.tenantId, "missing-route")).toBeNull();
  });
});
