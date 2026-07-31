import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage E：子代理 run 列表 API 守卫。
 * 权限路径覆盖 200 / 401 / 403 / 404，与既有 tasks route 测试风格一致。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  listSubagentRunsByThread: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  listSubagentRunsByThread: queries.listSubagentRunsByThread,
}));

import { GET } from "@/app/studio/api/threads/[id]/subagents/route";
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
  queries.listSubagentRunsByThread.mockResolvedValue([]);
});

describe("GET /studio/api/threads/[id]/subagents (Stage E)", () => {
  it("owner → 200 + { threadId, subagents }", async () => {
    queries.listSubagentRunsByThread.mockResolvedValue([
      {
        id: "sr1",
        definitionId: "def-1",
        goal: "explore routes",
        status: "completed",
        writeScope: null,
        resultSummary: "found 3",
        outputArtifactId: "art-1",
        transcriptPath: ".snow/runtime/t1/subagents/sr1/transcript.json",
        errorMessage: null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
      },
    ]);
    const res = await GET(req("http://x/studio/api/threads/t1/subagents"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { threadId: string; subagents: unknown[] } };
    expect(body.data.threadId).toBe("t1");
    expect(body.data.subagents).toHaveLength(1);
  });

  it("空状态 → 200 + subagents:[]", async () => {
    const res = await GET(req("http://x/studio/api/threads/t1/subagents"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subagents: unknown[] } };
    expect(body.data.subagents).toEqual([]);
  });

  it("admin（thread.read.all）→ 200，走 getThreadById", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "t1", userId: "other" });
    const res = await GET(req("http://x/studio/api/threads/t1/subagents"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("t1");
  });

  it("foreign thread（member 不持有）→ 404，不泄露存在性", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://x/studio/api/threads/t1/subagents"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(404);
    expect(queries.listSubagentRunsByThread).not.toHaveBeenCalled();
  });

  it("无 Studio 权限 → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("Forbidden", { status: 403 }),
    });
    const res = await GET(req("http://x/studio/api/threads/t1/subagents"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });
    const res = await GET(req("http://x/studio/api/threads/t1/subagents"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });
});
