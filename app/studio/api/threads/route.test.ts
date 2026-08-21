import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 Stage D：Threads 只读 API 守卫与隔离。
 * mock studio-access + studio-queries + queries，断言：
 * - member → 只列自己；admin(thread.read.all) → 全部。
 * - member foreign thread → 404；admin 不存在 → 404；admin 看任意 → 200。
 * - 无 studio.access → 403。
 */

const studioAccess = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const studio = vi.hoisted(() => ({
  listThreadsForUser: vi.fn(),
  listAllThreads: vi.fn(),
  listEventsForThread: vi.fn(),
  listToolRunsForThread: vi.fn(),
  listArtifactsForThread: vi.fn(),
}));
const queries = vi.hoisted(() => ({ getThreadById: vi.fn(), requireThreadForUser: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studioAccess.requireStudioAction,
  hasStudioAction: studioAccess.hasStudioAction,
}));
vi.mock("@/lib/db/studio-queries", () => ({
  listThreadsForUser: studio.listThreadsForUser,
  listAllThreads: studio.listAllThreads,
  listEventsForThread: studio.listEventsForThread,
  listToolRunsForThread: studio.listToolRunsForThread,
  listArtifactsForThread: studio.listArtifactsForThread,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
}));

import { GET as getDetail } from "@/app/studio/api/threads/[id]/route";
import { GET as getList } from "@/app/studio/api/threads/route";
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

beforeEach(() => {
  vi.clearAllMocks();
  studioAccess.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studioAccess.hasStudioAction.mockResolvedValue(false); // 默认 member：无 thread.read.all
});

describe("GET /studio/api/threads (Stage D)", () => {
  it("member → 只列自己的", async () => {
    studio.listThreadsForUser.mockResolvedValue([{ id: "t1", userId: "u1" }]);
    const res = await getList(new NextRequest("http://localhost/studio/api/threads"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.canViewAll).toBe(false);
    expect(body.data.threads).toEqual([{ id: "t1", userId: "u1" }]);
    expect(studio.listThreadsForUser).toHaveBeenCalledWith("u1");
    expect(studio.listAllThreads).not.toHaveBeenCalled();
  });

  it("admin(thread.read.all) → 列全部", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(true);
    studio.listAllThreads.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    const res = await getList(new NextRequest("http://localhost/studio/api/threads"));
    expect(res.status).toBe(200);
    expect(studio.listAllThreads).toHaveBeenCalled();
    expect(studio.listThreadsForUser).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.canViewAll).toBe(true);
  });

  it("无 studio.access → 403", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await getList(new NextRequest("http://localhost/studio/api/threads"));
    expect(res.status).toBe(403);
    expect(studio.listThreadsForUser).not.toHaveBeenCalled();
  });
});

describe("GET /studio/api/threads/[id] (Stage D)", () => {
  it("member 看自己的 thread → 200 + events/toolRuns/artifacts", async () => {
    queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1", status: "executing" });
    studio.listEventsForThread.mockResolvedValue([{ id: "e1", type: "agent.started" }]);
    studio.listToolRunsForThread.mockResolvedValue([{ id: "r1", toolName: "writeFile" }]);
    studio.listArtifactsForThread.mockResolvedValue([]);
    const res = await getDetail(new NextRequest("http://localhost/studio/api/threads/t1"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.thread.id).toBe("t1");
    expect(body.data.events).toHaveLength(1);
    expect(queries.requireThreadForUser).toHaveBeenCalledWith("t1", "u1");
  });

  it("member 看foreign thread → 404，不返回详情", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await getDetail(new NextRequest("http://localhost/studio/api/threads/tOther"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(studio.listEventsForThread).not.toHaveBeenCalled();
  });

  it("admin 看任意 thread → 200（getThreadById）", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2", status: "failed" });
    studio.listEventsForThread.mockResolvedValue([]);
    studio.listToolRunsForThread.mockResolvedValue([]);
    studio.listArtifactsForThread.mockResolvedValue([]);
    const res = await getDetail(new NextRequest("http://localhost/studio/api/threads/tOther"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("admin 不存在 thread → 404", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue(null);
    const res = await getDetail(new NextRequest("http://localhost/studio/api/threads/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("无 studio.access → 403", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await getDetail(new NextRequest("http://localhost/studio/api/threads/t1"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });
});
