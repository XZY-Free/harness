import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.3a Stage E：context summaries 列表 API 守卫。覆盖 200 / 401 / 403 / 404 / admin 跨 thread / supersede 链 / 空状态。
 */

const studioAccess = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  listSummariesByThread: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studioAccess.requireStudioAction,
  hasStudioAction: studioAccess.hasStudioAction,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  listSummariesByThread: queries.listSummariesByThread,
}));

import { GET } from "@/app/studio/api/threads/[id]/context/summaries/route";
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
  queries.listSummariesByThread.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/context/summaries (Stage E)", () => {
  it("owner + 空 → 200 + summaries: []", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/context/summaries"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summaries).toEqual([]);
    expect(queries.listSummariesByThread).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ limit: 50, includeSuperseded: true }),
    );
  });

  it("owner + 有 summary → 200 + 压缩比 + supersede 标记", async () => {
    queries.listSummariesByThread.mockResolvedValue([
      {
        id: "s1",
        threadId: "t1",
        type: "turn",
        scope: { messageIds: ["m1", "m2"] },
        summaryText: "用户目标: 实现登录页",
        tokenEstimate: 20,
        originalTokenEstimate: 200,
        protectedRefs: [],
        supersededById: null,
        createdAt: new Date(),
      },
      {
        id: "s0",
        threadId: "t1",
        type: "turn",
        scope: { messageIds: ["m1"] },
        summaryText: "旧摘要",
        tokenEstimate: 5,
        originalTokenEstimate: 50,
        protectedRefs: [],
        supersededById: "s1",
        createdAt: new Date(),
      },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/context/summaries"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summaries).toHaveLength(2);
    const active = body.data.summaries[0];
    expect(active.isSuperseded).toBe(false);
    expect(active.compressionRatio).toBe(0.1); // 20/200
    const old = body.data.summaries[1];
    expect(old.isSuperseded).toBe(true);
    expect(old.supersededById).toBe("s1");
  });

  it("非 owner → 404，不查 summaries", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/context/summaries"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.listSummariesByThread).not.toHaveBeenCalled();
  });

  it("admin（thread.read.all）跨 thread → 200", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    queries.listSummariesByThread.mockResolvedValue([]);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/context/summaries"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
  });

  it("admin 但 thread 不存在 → 404", async () => {
    studioAccess.hasStudioAction.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/ghost/context/summaries"), {
      params: Promise.resolve({ id: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("无 studio.access → 403", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/context/summaries"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
    expect(queries.listSummariesByThread).not.toHaveBeenCalled();
  });

  it("未登录 → 401", async () => {
    studioAccess.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/context/summaries"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });
});
