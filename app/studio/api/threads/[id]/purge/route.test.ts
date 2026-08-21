import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1(08-P1-2):admin 彻底删除 thread API 测试。
 * 覆盖:仅 admin 可调(member 403)、二次确认、thread 不存在 404、成功物理删+审计。
 */

const studioAccess = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  getThreadByIdIncludingDeleted: vi.fn(),
  deleteThreadRecursive: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studioAccess.requireStudioAction,
  hasStudioAction: studioAccess.hasStudioAction,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadByIdIncludingDeleted: queries.getThreadByIdIncludingDeleted,
  deleteThreadRecursive: queries.deleteThreadRecursive,
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: audit.recordAdminAudit }));

import { DELETE } from "@/app/studio/api/threads/[id]/purge/route";
import { NextRequest } from "next/server";

/** requireStudioAction 返回的 Principal：路由读取 userIdentityId 作 actorUserId。 */
const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
};

function delReq(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studioAccess.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studioAccess.hasStudioAction.mockResolvedValue(true); // 默认 admin
  queries.getThreadByIdIncludingDeleted.mockResolvedValue({
    id: "t1",
    title: "测试会话",
    status: "cancelled",
  });
  queries.deleteThreadRecursive.mockResolvedValue(undefined);
  audit.recordAdminAudit.mockResolvedValue(undefined);
});

describe("DELETE /studio/api/threads/[id]/purge (admin 彻底删除)", () => {
  it("admin + confirm:true → 200 + 调 deleteThreadRecursive + 审计", async () => {
    const res = await DELETE(
      delReq("http://localhost/studio/api/threads/t1/purge", { confirm: true }),
      {
        params: Promise.resolve({ id: "t1" }),
      },
    );
    expect(res.status).toBe(200);
    expect(queries.deleteThreadRecursive).toHaveBeenCalledWith("t1");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "u1",
        action: "thread.purged",
        targetType: "thread",
        targetId: "t1",
      }),
    );
  });

  it("非 admin(member) → 403,不物理删", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(false);
    const res = await DELETE(
      delReq("http://localhost/studio/api/threads/t1/purge", { confirm: true }),
      {
        params: Promise.resolve({ id: "t1" }),
      },
    );
    expect(res.status).toBe(403);
    expect(queries.deleteThreadRecursive).not.toHaveBeenCalled();
  });

  it("缺 confirm → 400,不物理删", async () => {
    const res = await DELETE(delReq("http://localhost/studio/api/threads/t1/purge"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(400);
    expect(queries.deleteThreadRecursive).not.toHaveBeenCalled();
  });

  it("confirm:false → 400", async () => {
    const res = await DELETE(
      delReq("http://localhost/studio/api/threads/t1/purge", { confirm: false }),
      {
        params: Promise.resolve({ id: "t1" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("thread 不存在 → 404", async () => {
    queries.getThreadByIdIncludingDeleted.mockResolvedValue(null);
    const res = await DELETE(
      delReq("http://localhost/studio/api/threads/t1/purge", { confirm: true }),
      {
        params: Promise.resolve({ id: "t1" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("deleteThreadRecursive 抛错 → 500(异常冒泡,不吞)", async () => {
    queries.deleteThreadRecursive.mockRejectedValue(new Error("connection lost"));
    const res = await DELETE(
      delReq("http://localhost/studio/api/threads/t1/purge", { confirm: true }),
      {
        params: Promise.resolve({ id: "t1" }),
      },
    );
    expect(res.status).toBe(500);
  });
});
