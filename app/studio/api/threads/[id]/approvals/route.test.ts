import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.1 Stage E：approvals 列表 API 守卫。覆盖 200 / 401 / 403 / 404 / admin 跨 thread。
 */

const studioAccess = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  getPendingApprovalsByThread: vi.fn(),
  getResolvedApprovalsByThread: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studioAccess.requireStudioAction,
  hasStudioAction: studioAccess.hasStudioAction,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  getPendingApprovalsByThread: queries.getPendingApprovalsByThread,
  getResolvedApprovalsByThread: queries.getResolvedApprovalsByThread,
}));

import { GET } from "@/app/studio/api/threads/[id]/approvals/route";
import { NextRequest } from "next/server";

const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
};

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  studioAccess.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studioAccess.hasStudioAction.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  queries.getPendingApprovalsByThread.mockResolvedValue([]);
  queries.getResolvedApprovalsByThread.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/approvals (Stage E)", () => {
  it("owner + 空 → 200 + { pending: [], resolved: [] }", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/approvals"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pending).toEqual([]);
    expect(body.data.resolved).toEqual([]);
    expect(queries.getPendingApprovalsByThread).toHaveBeenCalledWith("t1");
  });

  it("owner + 有 pending → 200 + pending 列表", async () => {
    queries.getPendingApprovalsByThread.mockResolvedValue([
      {
        id: "a1",
        threadId: "t1",
        toolName: "deleteFile",
        permissionKey: "tool.deleteFile",
        argSummary: "path=x",
        status: "pending",
      },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/approvals"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pending).toHaveLength(1);
    expect(body.data.pending[0].toolName).toBe("deleteFile");
  });

  it("非 owner → 404，不查审批", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/approvals"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.getPendingApprovalsByThread).not.toHaveBeenCalled();
  });

  it("无 studio.access → 403", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/approvals"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/approvals"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("admin(thread.read.all) → 可访问任意 thread", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    const res = await GET(req("http://localhost/studio/api/threads/tOther/approvals"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
  });
});
