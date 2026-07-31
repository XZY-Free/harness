import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.2 Stage E：后台任务列表 API 守卫。
 * 权限路径覆盖 200 / 401 / 403 / 404，与既有 context route 测试风格一致。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
}));
const registry = vi.hoisted(() => ({ listByThread: vi.fn() }));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
}));
vi.mock("@/lib/runtime/background-task-registry", () => ({
  listByThread: registry.listByThread,
}));

import { GET } from "@/app/studio/api/threads/[id]/tasks/route";
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
  registry.listByThread.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/tasks (Stage E)", () => {
  it("owner → 200 + { threadId, tasks }", async () => {
    registry.listByThread.mockResolvedValue([
      {
        id: "bt1",
        kind: "dev-server",
        command: "npm run dev",
        runtimeType: "host",
        status: "running",
        pid: 123,
        containerName: null,
        port: 41000,
        exitCode: null,
        startedAt: new Date(),
        finishedAt: null,
        lastActivityAt: new Date(),
      },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/tasks"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.threadId).toBe("t1");
    expect(body.data.tasks).toHaveLength(1);
    expect(body.data.tasks[0]).toMatchObject({ id: "bt1", kind: "dev-server", status: "running" });
    expect(registry.listByThread).toHaveBeenCalledWith("t1");
  });

  it("无任务 → 200 + 空数组", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/tasks"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.tasks).toEqual([]);
  });

  it("非 owner → 404，不调 listByThread", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/tasks"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(registry.listByThread).not.toHaveBeenCalled();
  });

  it("无 studio.access → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/tasks"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("未登录 → 401", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/tasks"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("admin(thread.read.all) → getThreadById 可访问任意 thread", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    registry.listByThread.mockResolvedValue([]);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/tasks"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("admin 但 thread 不存在 → 404", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/ghost/tasks"), {
      params: Promise.resolve({ id: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});
