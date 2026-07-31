import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.7 Stage E：delivery 只读 API 守卫。权限路径覆盖 200 / 401 / 403 / 404，
 * 空状态与有数据渲染。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  listThreadEvents: vi.fn(),
  listCheckpointsByThread: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  listThreadEvents: queries.listThreadEvents,
  listCheckpointsByThread: queries.listCheckpointsByThread,
}));

import { GET } from "@/app/studio/api/threads/[id]/delivery/route";
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
  queries.listThreadEvents.mockResolvedValue([]);
  queries.listCheckpointsByThread.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/delivery (Stage E)", () => {
  it("owner + 无交付 → 200 + { summary: null, checkpoints: [] }（空状态）", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/delivery"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toBeNull();
    expect(body.data.checkpoints).toEqual([]);
  });

  it("owner + 有交付摘要 + checkpoint → 200 + 数据", async () => {
    queries.listThreadEvents.mockResolvedValue([
      {
        id: "e1",
        threadId: "t1",
        sequence: 1,
        type: "delivery.succeeded",
        payload: {
          commitSha: "abc123",
          branch: "main",
          pushed: true,
          prUrl: "https://github.com/o/r/pull/1",
          filesChanged: [{ path: "a.ts", status: "modified" }],
          testResults: { passed: 2, failed: 0, summary: "" },
          blindCommit: false,
        },
        createdAt: new Date(),
      },
      {
        id: "e2",
        threadId: "t1",
        sequence: 2,
        type: "delivery.succeeded",
        payload: { commitSha: "def456", branch: "main", pushed: true },
        createdAt: new Date(),
      },
    ]);
    queries.listCheckpointsByThread.mockResolvedValue([
      {
        id: "cp1",
        threadId: "t1",
        tag: "snow-checkpoint-abcd1234",
        commitSha: "abc123",
        reason: "before push",
        restoredAt: null,
        createdAt: new Date(),
      },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/delivery"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 取最近一条 delivery.succeeded
    expect(body.data.summary.commitSha).toBe("def456");
    expect(body.data.checkpoints).toHaveLength(1);
    expect(body.data.checkpoints[0].tag).toBe("snow-checkpoint-abcd1234");
  });

  it("未登录 → 401", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("unauthorized", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/delivery"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("无 studio.access 权限 → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("forbidden", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/delivery"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("非 owner → 404，不查 delivery 数据", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/t1/delivery"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(404);
    expect(queries.listThreadEvents).not.toHaveBeenCalled();
    expect(queries.listCheckpointsByThread).not.toHaveBeenCalled();
  });

  it("thread.read.all → 可查他人 thread（admin）", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "t2", userId: "other" });
    queries.listThreadEvents.mockResolvedValue([]);
    const res = await GET(req("http://localhost/studio/api/threads/t2/delivery"), {
      params: Promise.resolve({ id: "t2" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("t2");
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });
});
