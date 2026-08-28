/**
 * POST /admin/api/v1/deployment-route-sets — RouteSet 登记（create-or-reuse）RED 测试。
 *
 * 目标行为：授权管理员只需给出 agent_id + route_scope_key + route_scope，即可
 * 创建或复用该 Agent+Scope 的正式 RouteSet，无需知道/粘贴 RouteSet id。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID），
 * 真实 MySQL 8 Testcontainers，真实路由 handler 动态 import，不使用 mock。
 */
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 目标路由模块（尚未存在）。用动态 import 加载，使"路由缺失"的 RED 只落在
 * 本文件用例上。
 */
async function loadCreateRouteSetRoute() {
  return await import("@/app/admin/api/v1/deployment-route-sets/route");
}

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed admin（可含/不含 route.update 授权） ────────

async function seedAdmin(options?: { withRouteUpdate?: boolean }) {
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
  if (options?.withRouteUpdate !== false) {
    await grantActionBinding({
      tenantId: tenant.id,
      principalBindingId: binding.id,
      actionCode: "route.update",
      resourceScope: { type: "agent", wildcard: true },
    });
  }
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

async function seedAgent(tenantId: string, userIdentityId: string, agentKey: string) {
  return await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: userIdentityId,
    lifecycleState: "enabled",
  });
}

async function countRouteSets(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(deploymentRouteSetTable);
  return Number(row?.n ?? 0);
}

async function countRoutes(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(deploymentRouteTable);
  return Number(row?.n ?? 0);
}

function buildCreateRequest(body: unknown, idempotencyKey: string, token?: string) {
  return buildApiRequest({
    audience: "admin",
    method: "POST",
    path: "/deployment-route-sets",
    idempotencyKey,
    ...(token !== undefined ? { token } : {}),
    body,
  });
}

interface RouteSetProjection {
  id: string;
  agent_id: string;
  route_scope_key: string;
  route_scope: unknown;
  version_no: number;
  created_at: string;
  updated_at: string;
  created: boolean;
}

describe("POST /admin/api/v1/deployment-route-sets（RouteSet 登记 create-or-reuse）", () => {
  it("Happy：具体 Agent + route.update + 严格 body → 201 精确投影，仅一行 RouteSet，零 Route", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-1");

    const response = await POST(
      buildCreateRequest(
        { agent_id: agent.id, route_scope_key: "default", route_scope: {} },
        "idem-route-set-register-happy-001",
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as RouteSetProjection;
    expect(Object.keys(body).sort()).toEqual(
      [
        "id",
        "target_kind",
        "agent_id",
        "route_scope_key",
        "route_scope",
        "version_no",
        "created_at",
        "updated_at",
        "created",
      ].sort(),
    );
    expect(body.agent_id).toBe(agent.id);
    expect(body.route_scope_key).toBe("default");
    expect(body.route_scope).toEqual({});
    expect(body.version_no).toBe(1);
    expect(body.created).toBe(true);
    expect(typeof body.created_at).toBe("string");
    expect(typeof body.updated_at).toBe("string");

    expect(await countRouteSets()).toBe(1);
    expect(await countRoutes()).toBe(0);
  });

  it("自然键复用：不同 Idempotency-Key 同 body → 200 同 id created=false，仍只有一行", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-2");

    const first = await POST(
      buildCreateRequest(
        { agent_id: agent.id, route_scope_key: "default", route_scope: { zone: "internal" } },
        "idem-route-set-register-natural-a",
      ),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as RouteSetProjection;

    const second = await POST(
      buildCreateRequest(
        { agent_id: agent.id, route_scope_key: "default", route_scope: { zone: "internal" } },
        "idem-route-set-register-natural-b",
      ),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as RouteSetProjection;
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.created).toBe(false);
    expect(secondBody.route_scope).toEqual({ zone: "internal" });

    // agent_id 归一化：首尾空白 trim 后仍命中同一自然键
    const padded = await POST(
      buildCreateRequest(
        {
          agent_id: ` ${agent.id} `,
          route_scope_key: "default",
          route_scope: { zone: "internal" },
        },
        "idem-route-set-register-natural-c",
      ),
    );
    expect(padded.status).toBe(200);
    const paddedBody = (await padded.json()) as RouteSetProjection;
    expect(paddedBody.id).toBe(firstBody.id);

    expect(await countRouteSets()).toBe(1);
  });

  it("幂等重放：同 key 同 body → 精确重放首次响应；同 key 不同 body → 409 冲突", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-3");
    const body = { agent_id: agent.id, route_scope_key: "prod", route_scope: { zone: "dmz" } };

    const first = await POST(buildCreateRequest(body, "idem-route-set-register-replay-1"));
    expect(first.status).toBe(201);
    const firstText = await first.text();

    const replay = await POST(buildCreateRequest(body, "idem-route-set-register-replay-1"));
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);

    const conflict = await POST(
      buildCreateRequest(
        { ...body, route_scope: { zone: "internal" } },
        "idem-route-set-register-replay-1",
      ),
    );
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe("IDEMPOTENCY_CONFLICT");

    expect(await countRouteSets()).toBe(1);
  });

  it("非法 body：缺字段/null/空白/数组 route_scope/未知键 → 400 且零行", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-4");

    const invalidBodies: unknown[] = [
      { route_scope_key: "default", route_scope: {} }, // 缺 agent_id
      { agent_id: null, route_scope_key: "default", route_scope: {} },
      { agent_id: "   ", route_scope_key: "default", route_scope: {} },
      { agent_id: agent.id, route_scope: {} }, // 缺 route_scope_key
      { agent_id: agent.id, route_scope_key: null, route_scope: {} },
      { agent_id: agent.id, route_scope_key: "  ", route_scope: {} },
      { agent_id: agent.id, route_scope_key: "default" }, // 缺 route_scope
      { agent_id: agent.id, route_scope_key: "default", route_scope: null },
      { agent_id: agent.id, route_scope_key: "default", route_scope: [] }, // 数组
      { agent_id: agent.id, route_scope_key: "default", route_scope: "prod" }, // 标量
      { agent_id: agent.id, route_scope_key: "default", route_scope: {}, extra: 1 }, // 未知键
    ];

    for (const [index, body] of invalidBodies.entries()) {
      const response = await POST(
        buildCreateRequest(body, `idem-route-set-register-invalid-${index}`),
      );
      expect(response.status, `body #${index} 应 400`).toBe(400);
      const errorBody = (await response.json()) as { error: { code: string } };
      expect(errorBody.error.code).toBe("REQUEST_SCHEMA_INVALID");
    }

    // 缺 Idempotency-Key → 400
    const noKey = await POST(
      buildApiRequest({
        audience: "admin",
        method: "POST",
        path: "/deployment-route-sets",
        body: { agent_id: agent.id, route_scope_key: "default", route_scope: {} },
      }),
    );
    expect(noKey.status).toBe(400);

    expect(await countRouteSets()).toBe(0);
  });

  it("鉴权：无效 Bearer → 401；无 route.update 授权 → 403；均零行", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin({ withRouteUpdate: false });
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-5");
    const body = { agent_id: agent.id, route_scope_key: "default", route_scope: {} };

    const unauthorized = await POST(
      buildCreateRequest(body, "idem-route-set-register-unauth", "not-a-real-workload-token"),
    );
    expect(unauthorized.status).toBe(401);
    const unauthBody = (await unauthorized.json()) as { error: { code: string } };
    expect(unauthBody.error.code).toBe("AUTHENTICATION_REQUIRED");

    const forbidden = await POST(buildCreateRequest(body, "idem-route-set-register-forbidden"));
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as { error: { code: string } };
    expect(forbiddenBody.error.code).toBe("ACTION_SCOPE_DENIED");

    expect(await countRouteSets()).toBe(0);
  });

  it("隔离：不存在/他租户 Agent → 隐藏 404 且调用租户零行", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const caller = await seedAdmin();

    // 不存在的 Agent
    const missing = await POST(
      buildCreateRequest(
        {
          agent_id: "00000000-0000-4000-8000-000000000000",
          route_scope_key: "default",
          route_scope: {},
        },
        "idem-route-set-register-missing",
      ),
    );
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(missingBody.error.code).toBe("RESOURCE_NOT_FOUND");

    // 他租户 Agent（隐藏式 404，非 403）
    await db
      .insert(tenantTable)
      .values({ id: "tenant-other", key: "tenant-other", name: "tenant-other" });
    const otherAgent = await createAgent({
      tenantId: "tenant-other",
      agentKey: "other-tenant-agent",
      displayName: "Other Tenant Agent",
      ownerUserId: caller.userIdentityId,
      lifecycleState: "enabled",
    });
    const cross = await POST(
      buildCreateRequest(
        { agent_id: otherAgent.id, route_scope_key: "default", route_scope: {} },
        "idem-route-set-register-cross",
      ),
    );
    expect(cross.status).toBe(404);
    const crossBody = (await cross.json()) as { error: { code: string } };
    expect(crossBody.error.code).toBe("RESOURCE_NOT_FOUND");

    expect(await countRouteSets()).toBe(0);
  });

  it("scope 固定：同自然键不同 route_scope → 409 OPERATION_PAYLOAD_CONFLICT，原行不变", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-6");

    const first = await POST(
      buildCreateRequest(
        { agent_id: agent.id, route_scope_key: "default", route_scope: { zone: "internal" } },
        "idem-route-set-register-scope-1",
      ),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as RouteSetProjection;

    const mismatch = await POST(
      buildCreateRequest(
        { agent_id: agent.id, route_scope_key: "default", route_scope: { zone: "dmz" } },
        "idem-route-set-register-scope-2",
      ),
    );
    expect(mismatch.status).toBe(409);
    const mismatchBody = (await mismatch.json()) as { error: { code: string } };
    expect(mismatchBody.error.code).toBe("OPERATION_PAYLOAD_CONFLICT");

    expect(await countRouteSets()).toBe(1);
    const [row] = await db
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.id, firstBody.id))
      .limit(1);
    expect(row?.routeScopeJson).toEqual({ zone: "internal" });
  });

  it("并发：两个不同幂等键竞争同一自然键 → 均成功、同一 id、恰好一行", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-7");
    const body = { agent_id: agent.id, route_scope_key: "default", route_scope: {} };

    const [a, b] = await Promise.all([
      POST(buildCreateRequest(body, "idem-route-set-register-race-a")),
      POST(buildCreateRequest(body, "idem-route-set-register-race-b")),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const bodyA = (await a.json()) as RouteSetProjection;
    const bodyB = (await b.json()) as RouteSetProjection;
    expect(bodyA.id).toBe(bodyB.id);
    expect([bodyA.created, bodyB.created].sort()).toEqual([false, true]);

    expect(await countRouteSets()).toBe(1);
  });

  it("响应脱敏：不泄露 contract/AgentCard/endpoint/credential/secret/source 字段", async () => {
    const { POST } = await loadCreateRouteSetRoute();
    const { tenantId, userIdentityId } = await seedAdmin();
    const agent = await seedAgent(tenantId, userIdentityId, "route-set-register-agent-8");

    const response = await POST(
      buildCreateRequest(
        { agent_id: agent.id, route_scope_key: "default", route_scope: {} },
        "idem-route-set-register-redaction",
      ),
    );
    expect(response.status).toBe(201);
    const text = await response.text();
    for (const forbidden of [
      "contract",
      "agent_card",
      "agentcard",
      "endpoint",
      "credential",
      "secret",
      "source",
      "git",
      "provider",
      "runtime_revision",
    ]) {
      expect(text.toLowerCase(), `响应不得包含 ${forbidden}`).not.toContain(forbidden);
    }
  });
});
