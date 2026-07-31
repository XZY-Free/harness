import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.0 Stage E：plan/todo 只读 API 守卫。权限路径覆盖 200 / 401 / 403 / 404，
 * 以及无 plan 空状态。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  getActiveThreadPlan: vi.fn(),
  listThreadPlanItems: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  getActiveThreadPlan: queries.getActiveThreadPlan,
  listThreadPlanItems: queries.listThreadPlanItems,
}));

import { GET } from "@/app/studio/api/threads/[id]/plan/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  queries.getActiveThreadPlan.mockResolvedValue(null);
  queries.listThreadPlanItems.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/plan (Stage E)", () => {
  it("owner + 无 plan → 200 + { plan: null, items: [] }（空状态）", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/plan"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.plan).toBeNull();
    expect(body.data.items).toEqual([]);
    // 无 plan 时不查 items
    expect(queries.listThreadPlanItems).not.toHaveBeenCalled();
  });

  it("owner + 有 plan → 200 + plan + items", async () => {
    queries.getActiveThreadPlan.mockResolvedValue({
      id: "p1",
      threadId: "t1",
      title: "demo",
      status: "active",
    });
    queries.listThreadPlanItems.mockResolvedValue([
      { id: "i1", position: 0, title: "步骤一", status: "pending" },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/plan"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.plan.id).toBe("p1");
    expect(body.data.items).toHaveLength(1);
    expect(queries.listThreadPlanItems).toHaveBeenCalledWith("t1", "p1");
  });

  it("非 owner → 404，不查 plan", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/plan"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.getActiveThreadPlan).not.toHaveBeenCalled();
  });

  it("无 studio.access → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/plan"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/plan"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("admin(thread.read.all) → 可访问任意 thread", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    const res = await GET(req("http://localhost/studio/api/threads/tOther/plan"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
  });
});
