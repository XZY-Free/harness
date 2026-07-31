import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.6 Stage E：QA 证据 API 守卫。覆盖 200 / 401 / 403 / 404 / admin 跨 thread / 证据代理。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  listQaEventsByThread: vi.fn(),
}));
const artifact = vi.hoisted(() => ({ readQaArtifact: vi.fn() }));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  listQaEventsByThread: queries.listQaEventsByThread,
}));
vi.mock("@/lib/qa/artifact", () => ({
  readQaArtifact: artifact.readQaArtifact,
}));

import { GET } from "@/app/studio/api/threads/[id]/qa/route";
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
  queries.listQaEventsByThread.mockResolvedValue([]);
  artifact.readQaArtifact.mockResolvedValue(null);
});

describe("GET /studio/api/threads/[id]/qa (Stage E)", () => {
  it("owner + 空 → 200 + { events: [] }", async () => {
    const res = await GET(req("http://localhost/studio/api/threads/t1/qa"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.events).toEqual([]);
    expect(queries.listQaEventsByThread).toHaveBeenCalledWith("t1");
  });

  it("owner + 有 QA 事件 → 200 + 事件列表", async () => {
    queries.listQaEventsByThread.mockResolvedValue([
      {
        id: "e1",
        threadId: "t1",
        type: "qa.check_failed",
        payload: {
          checkId: "gate-abc",
          kind: "gate",
          viewports: [375, 1280],
          failures: [{ type: "console_error", viewport: 1280, detail: "boom" }],
          durationMs: 300,
        },
        sequence: 5,
        createdAt: new Date(),
      },
    ]);
    const res = await GET(req("http://localhost/studio/api/threads/t1/qa"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0].type).toBe("qa.check_failed");
  });

  it("非 owner → 404，不查 QA 事件", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/studio/api/threads/tOther/qa"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(404);
    expect(queries.listQaEventsByThread).not.toHaveBeenCalled();
  });

  it("无 studio.access → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/qa"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(req("http://localhost/studio/api/threads/t1/qa"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("admin(thread.read.all) → 可访问任意 thread", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    const res = await GET(req("http://localhost/studio/api/threads/tOther/qa"), {
      params: Promise.resolve({ id: "tOther" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("tOther");
  });

  it("?artifact=xxx.png → 代理返回 image/png", async () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    artifact.readQaArtifact.mockResolvedValue(pngBuf);
    const res = await GET(
      req("http://localhost/studio/api/threads/t1/qa?artifact=t1/qa/gate-abc-1280.png"),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(artifact.readQaArtifact).toHaveBeenCalledWith("t1", "t1/qa/gate-abc-1280.png");
  });

  it("?artifact=xxx.json → 代理返回 application/json", async () => {
    const jsonBuf = Buffer.from('{"ok":true}');
    artifact.readQaArtifact.mockResolvedValue(jsonBuf);
    const res = await GET(
      req("http://localhost/studio/api/threads/t1/qa?artifact=t1/qa/gate-abc.json"),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("?artifact=不存在 → 404", async () => {
    artifact.readQaArtifact.mockResolvedValue(null);
    const res = await GET(
      req("http://localhost/studio/api/threads/t1/qa?artifact=t1/qa/missing.png"),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(404);
  });
});
