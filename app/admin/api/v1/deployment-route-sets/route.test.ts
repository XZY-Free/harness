import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { deploymentRouteSetTable } from "@/lib/persistence/schema/routes";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
/**
 * POST /admin/api/v1/deployment-route-sets — RouteSet 登记（create-or-reuse）集成测试。
 *
 * 冻结架构：ensure 请求体必须是判别 target 形状
 *   { target: {kind:"runtime"} | {kind:"agent", agent_id}, route_scope_key, route_scope }
 * 旧扁平 { agent_id, route_scope_key, route_scope } 一律 400 且零落库。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 MySQL 8 Testcontainers。
 */
import { POST } from "./route";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

/** seed 管理员 + 授予 route.update（全 Agent wildcard）+ 一个 draft Agent。 */
async function seedAdminAndAgent() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "route.update",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "route.update",
    resourceScope: { type: "environment", wildcard: true },
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "ensure-route-agent",
    displayName: "Ensure Route Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });
  return { tenantId: tenant.id, agentId: agent.id };
}

describe("POST /admin/api/v1/deployment-route-sets（ensure RouteSet exact payload）", () => {
  it("判别 target（runtime）成功登记且不携带 Agent identity", async () => {
    const { tenantId } = await seedAdminAndAgent();

    const response = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/deployment-route-sets",
        idempotencyKey: "idem-ensure-runtime-001",
        body: {
          target: { kind: "runtime" },
          route_scope_key: "prod",
          route_scope: {},
        },
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.target).toEqual({ kind: "runtime" });

    const [routeSet] = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.tenantId, tenantId));
    expect(routeSet?.targetKind).toBe("runtime");
    expect(routeSet?.targetIdentity).toBe("runtime");
    expect(routeSet?.agentId).toBeNull();
  });

  it("判别 target（nested agent）成功登记 → 201 且 RouteSet 以 agent target 落库", async () => {
    const { tenantId, agentId } = await seedAdminAndAgent();

    const response = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/deployment-route-sets",
        idempotencyKey: "idem-ensure-nested-001",
        body: {
          target: { kind: "agent", agent_id: agentId },
          route_scope_key: "prod",
          route_scope: {},
        },
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.target).toEqual({ kind: "agent", agent_id: agentId });

    const [routeSet] = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.tenantId, tenantId));
    expect(routeSet).toBeDefined();
    expect(routeSet?.targetKind).toBe("agent");
    expect(routeSet?.agentId).toBe(agentId);
    expect(routeSet?.routeScopeKey).toBe("prod");
  });

  it("旧扁平 agent_id ensure → 400 且零落库（冻结架构拒绝 flat 双轨）", async () => {
    const { tenantId, agentId } = await seedAdminAndAgent();

    const response = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/deployment-route-sets",
        idempotencyKey: "idem-ensure-flat-001",
        body: {
          agent_id: agentId,
          route_scope_key: "prod",
          route_scope: {},
        },
      }),
    );
    expect(response.status).toBe(400);

    expect(
      await db
        .select()
        .from(deploymentRouteSetTable)
        .where(eq(deploymentRouteSetTable.tenantId, tenantId)),
    ).toHaveLength(0);
  });
});
