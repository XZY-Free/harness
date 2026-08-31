import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 C Stage D：GET /studio/api/audit 守卫与查询测试。
 * 断言：
 * - 无 audit.read → 403，不查 DB。
 * - 合法 query 调 listStudioAuditEvents 并返回 { logs }。
 * - 非法 limit 被钳制（不报错）。
 * - 未知 action → 400 invalid_action。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const audit = vi.hoisted(() => ({ listStudioAuditEvents: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/studio/admin-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio/admin-audit")>();
  return { ...actual, listStudioAuditEvents: audit.listStudioAuditEvents };
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
  audit.listStudioAuditEvents.mockResolvedValue([
    {
      id: "a1",
      actorId: "u1",
      actionType: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadataRedacted: { keys: ["protectedPaths"], changedKeys: ["protectedPaths"] },
      occurredAt: new Date(),
    },
  ]);
});

describe("GET /studio/api/audit (切片 C)", () => {
  it("audit.read 通过 → 200 + { logs }，调 listStudioAuditEvents", async () => {
    const res = await GET(req("http://localhost/studio/api/audit?limit=50"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.logs).toHaveLength(1);
    expect(body.data.logs[0].actionType).toBe("policies.updated");
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "audit.read");
    expect(audit.listStudioAuditEvents).toHaveBeenCalledTimes(1);
  });

  it("传递 actor/action/target 过滤参数", async () => {
    await GET(
      req(
        "http://localhost/studio/api/audit?actorUserId=u2&action=skills.published&targetType=skill&targetId=s1",
      ),
    );
    const arg = audit.listStudioAuditEvents.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      tenantId: "t1",
      actorUserId: "u2",
      action: "skills.published",
      targetType: "skill",
      targetId: "s1",
    });
  });

  it("非法 limit（非数字）→ 透传 undefined，钳制由查询层负责，不报错", async () => {
    const res = await GET(req("http://localhost/studio/api/audit?limit=abc"));
    expect(res.status).toBe(200);
    expect(audit.listStudioAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it("未知 action → 400 invalid_action，不查 DB", async () => {
    const res = await GET(req("http://localhost/studio/api/audit?action=evil.action"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_action");
    expect(audit.listStudioAuditEvents).not.toHaveBeenCalled();
  });

  it("无 audit.read → 403，不查 DB", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/audit"));
    expect(res.status).toBe(403);
    expect(audit.listStudioAuditEvents).not.toHaveBeenCalled();
  });
});
