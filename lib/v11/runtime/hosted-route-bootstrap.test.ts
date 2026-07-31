import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createAgent } from "@/lib/v11/control-plane/agent-queries";
import { getEffectiveRoutes } from "@/lib/v11/control-plane/deployment-route-queries";
import { ensureHostedRouteForAgent } from "@/lib/v11/runtime/hosted-route-bootstrap";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态
});

describe("ensureHostedRouteForAgent", () => {
  it("为启用助手创建可调度的内置 Hosted Runtime 路由，重复调用不重复创建", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "hosted-route-owner",
      email: "hosted-route-owner@example.com",
      displayName: "Hosted Route Owner",
    });
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: "default",
      displayName: "默认助手",
      ownerUserId: owner.id,
      lifecycleState: "enabled",
    });

    const first = await ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id });
    const second = await ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id });
    const routes = await getEffectiveRoutes(tenant.id, agent.id, "default");

    expect(first.agentRevisionId).toBeTruthy();
    expect(first.runtimeRevisionId).toBeTruthy();
    expect(second.routeId).toBe(first.routeId);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: first.routeId,
      agentRevisionId: first.agentRevisionId,
      runtimeRevisionId: first.runtimeRevisionId,
      routeState: "enabled",
    });
  });
});
