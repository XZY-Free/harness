import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 C Stage D：GET /studio/api/audit 守卫与查询测试。
 * 断言：
 * - 无 audit.read → 403，不查 DB。
 * - 合法 query 调 listAdminAuditLogs 并返回 { logs }。
 * - 非法 limit 被钳制（不报错）。
 * - 未知 action → 400 invalid_action。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const queries = vi.hoisted(() => ({ listAdminAuditLogs: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/db/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/queries")>();
  return { ...actual, listAdminAuditLogs: queries.listAdminAuditLogs };
});

import { GET } from "@/app/studio/api/audit/route";
import { NextRequest } from "next/server";

const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
} as const;

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  queries.listAdminAuditLogs.mockResolvedValue([
    {
      id: "a1",
      actorUserId: "u1",
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: { keys: ["protectedPaths"], changedKeys: ["protectedPaths"] },
      createdAt: new Date(),
    },
  ]);
});

describe("GET /studio/api/audit (切片 C)", () => {
  it("audit.read 通过 → 200 + { logs }，调 listAdminAuditLogs", async () => {
    const res = await GET(req("http://localhost/studio/api/audit?limit=50"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.logs).toHaveLength(1);
    expect(body.data.logs[0].action).toBe("policies.updated");
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "audit.read");
    expect(queries.listAdminAuditLogs).toHaveBeenCalledTimes(1);
  });

  it("传递 actor/action/target 过滤参数", async () => {
    await GET(
      req(
        "http://localhost/studio/api/audit?actorUserId=u2&action=skills.published&targetType=skill&targetId=s1",
      ),
    );
    const arg = queries.listAdminAuditLogs.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      actorUserId: "u2",
      action: "skills.published",
      targetType: "skill",
      targetId: "s1",
    });
  });

  it("非法 limit（非数字）→ 透传 undefined，钳制由查询层负责，不报错", async () => {
    const res = await GET(req("http://localhost/studio/api/audit?limit=abc"));
    expect(res.status).toBe(200);
    expect(queries.listAdminAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it("未知 action → 400 invalid_action，不查 DB", async () => {
    const res = await GET(req("http://localhost/studio/api/audit?action=evil.action"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_action");
    expect(queries.listAdminAuditLogs).not.toHaveBeenCalled();
  });

  it("无 audit.read → 403，不查 DB", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/audit"));
    expect(res.status).toBe(403);
    expect(queries.listAdminAuditLogs).not.toHaveBeenCalled();
  });
});
