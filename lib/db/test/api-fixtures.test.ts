import { db } from "@/lib/db/client";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { agentTable } from "@/lib/persistence/schema/agents";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUDIENCE_PREFIX,
  assertCrossTenantHidden,
  assertIdempotencyConflict,
  buildApiRequest,
  withRollback,
} from "./api-fixtures";
import { resetDatabase } from "./mysql-harness";

describe("api-fixtures: buildApiRequest", () => {
  it("为四类 audience 生成正确路径前缀与 X-Request-ID", () => {
    const cases = [
      { audience: "employee" as const, prefix: "/api/v1" },
      { audience: "runtime" as const, prefix: "/runtime/v1" },
      { audience: "gateway" as const, prefix: "/gateway/v1" },
      { audience: "admin" as const, prefix: "/admin/api/v1" },
    ];
    for (const { audience, prefix } of cases) {
      const req = buildApiRequest({ audience, method: "GET", path: "/threads" });
      expect(req.url).toBe(`https://snow.test${prefix}/threads`);
      expect(req.headers.get("x-request-id")).toMatch(/^req_/);
    }
  });

  it("POST 携带 Idempotency-Key 与 body；PUT/PATCH 携带 If-Match", async () => {
    const post = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "idem_1",
      body: { agent_id: "a1" },
    });
    expect(post.headers.get("idempotency-key")).toBe("idem_1");
    expect(await post.json()).toEqual({ agent_id: "a1" });

    const patch = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: "/threads/thr_1/settings",
      ifMatch: "etag_v3",
      body: { title: "x" },
    });
    expect(patch.headers.get("if-match")).toBe('"etag_v3"');
  });

  it("显式 requestId 透传；缺失时生成", () => {
    const a = buildApiRequest({
      audience: "admin",
      method: "GET",
      path: "/agents",
      requestId: "req_explicit",
    });
    expect(a.headers.get("x-request-id")).toBe("req_explicit");
    const b = buildApiRequest({ audience: "admin", method: "GET", path: "/agents" });
    expect(b.headers.get("x-request-id")).not.toBe("req_explicit");
  });

  it("AUDIENCE_PREFIX 与四类 audience 一致", () => {
    expect(AUDIENCE_PREFIX).toEqual({
      employee: "/api/v1",
      runtime: "/runtime/v1",
      gateway: "/gateway/v1",
      admin: "/admin/api/v1",
    });
  });
});

describe("api-fixtures: withRollback", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("事务回滚不污染共享 DB", async () => {
    const tenant = await ensureDefaultTenant();
    await withRollback(db, async (tx) => {
      await tx.insert(agentTable).values({
        id: "rollback-agent-1",
        tenantId: tenant.id,
        agentKey: "rollback-agent",
        displayName: "Rollback Agent",
        ownerUserId: "rollback-owner",
        lifecycleState: "enabled",
      });
    });
    const [rows] = (await db.execute(
      sql`SELECT COUNT(*) AS c FROM Agent WHERE id = 'rollback-agent-1'`,
    )) as unknown as [Array<{ c: number }>];
    expect(rows[0]?.c).toBe(0);
  });

  it("返回 fn 的结果", async () => {
    const value = await withRollback(db, async () => "result_42");
    expect(value).toBe("result_42");
  });

  it("fn 抛出真实错误时原样向上抛", async () => {
    await expect(
      withRollback(db, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("api-fixtures: 断言夹具", () => {
  it("assertIdempotencyConflict 校验 409 + IDEMPOTENCY_CONFLICT", async () => {
    const res = Response.json(
      {
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "x",
          request_id: "req_9",
          retryable: false,
        },
      },
      { status: 409 },
    );
    await expect(assertIdempotencyConflict(res, "req_9")).resolves.toBeUndefined();
  });

  it("assertIdempotencyConflict 对非 409 失败", async () => {
    const res = Response.json(
      {
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "x",
          request_id: "req_9",
          retryable: false,
        },
      },
      { status: 200 },
    );
    await expect(assertIdempotencyConflict(res, "req_9")).rejects.toThrow();
  });

  it("assertCrossTenantHidden 校验隐藏式 404 + RESOURCE_NOT_FOUND", async () => {
    const res = Response.json(
      {
        error: { code: "RESOURCE_NOT_FOUND", message: "x", request_id: "req_7", retryable: false },
      },
      { status: 404 },
    );
    await expect(assertCrossTenantHidden(res, "req_7")).resolves.toBeUndefined();
  });
});
