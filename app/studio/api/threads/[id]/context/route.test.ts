import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.0 Stage E：context snapshot 只读 API 守卫。
 * 权限路径覆盖 200 / 401 / 403 / 404，与既有 workspace route 测试风格一致。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  listContextSnapshotsForThread: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  listContextSnapshotsForThread: queries.listContextSnapshotsForThread,
}));

import { GET } from "@/app/studio/api/threads/[id]/context/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  // 默认 member：无 thread.read.all
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  queries.listContextSnapshotsForThread.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/context (Stage E)", () => {
  it("owner → 200 + { threadId, snapshots }", async () => {
    queries.listContextSnapshotsForThread.mockResolvedValue([
      { id: "s1", threadId: "t1", model: "m", estimatedTokens: 42 },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/context"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.threadId).toBe("t1");
    expect(body.data.snapshots).toHaveLength(1);
    expect(queries.listContextSnapshotsForThread).toHaveBeenCalledWith("t1", 5);
  });

  it("无 snapshot → 200 + 空数组（前端展示空状态）", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/context"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.snapshots).toEqual([]);
  });

  it("非 owner → 404，不调 list（先于查询）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/context"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.listContextSnapshotsForThread).not.toHaveBeenCalled();
  });

  it("无 studio.access → 403（requirePermission 守卫）", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/context"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("未登录 → 401（requirePermission 认证失败）", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/context"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("admin(thread.read.all) → getThreadById 可访问任意 thread", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    queries.listContextSnapshotsForThread.mockResolvedValue([]);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/context"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("admin 但 thread 不存在 → 404", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/ghost/context"), {
      params: Promise.resolve({ id: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});
