import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5 Stage D：预览反向代理 /preview/[threadId]/* 测试。
 * mock auth / queries / registry / global fetch，覆盖 owner guard 404、未 ready 503、ready 转发 200 + path 透传。
 */

const auth = vi.hoisted(() => ({ getCurrentUserFromRequest: vi.fn() }));
const queries = vi.hoisted(() => ({
  requireThreadForUser: vi.fn(),
}));
const preview = vi.hoisted(() => ({ status: vi.fn() }));
const registry = vi.hoisted(() => ({
  resolveRuntimes: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: auth.getCurrentUserFromRequest,
  authErrorResponse: (error: unknown) =>
    error instanceof Error && error.message.includes("SSO")
      ? new Response(null, { status: 401 })
      : null,
}));
vi.mock("@/lib/db/queries", () => ({
  requireThreadForUser: queries.requireThreadForUser,
}));
vi.mock("@/lib/runtime/registry", () => ({
  resolveRuntimeTypeForThread: (
    thread: { runtimeType?: string | null },
    version: { runtimeType?: string | null } | null,
  ) => thread.runtimeType ?? version?.runtimeType ?? "host",
  resolveRuntimes: registry.resolveRuntimes,
}));

import { GET } from "@/app/preview/[threadId]/[[...path]]/route";

function req(threadId: string, path?: string[]): Request {
  const urlPath = `/preview/${threadId}/${path ? path.join("/") : ""}`;
  return new Request(`http://localhost${urlPath}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUserFromRequest.mockResolvedValue({ id: "u1" });
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  registry.resolveRuntimes.mockReturnValue({ preview });
});

describe("GET /preview/[threadId]/* 反向代理 (Phase 5 Stage D)", () => {
  it("foreign thread → 404", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(404);
    expect(preview.status).not.toHaveBeenCalled();
  });

  it("缺 SSO 身份 → 401", async () => {
    auth.getCurrentUserFromRequest.mockRejectedValue(new Error("缺少 SSO 用户标识"));
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(401);
  });

  it("未 ready → 503", async () => {
    preview.status.mockReturnValue({ state: "starting", port: 41000, kind: "dev-server" });
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(503);
  });

  it("thread runtimeType=container → 用 container preview status registry", async () => {
    queries.requireThreadForUser.mockResolvedValue({
      id: "t1",
      userId: "u1",
      runtimeType: "container",
    });
    preview.status.mockReturnValue({ state: "starting", port: 41000, kind: "dev-server" });
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });

    expect(res.status).toBe(503);
    expect(registry.resolveRuntimes).toHaveBeenCalledWith("t1", "container");
    expect(preview.status).toHaveBeenCalledWith("t1");
  });

  it("无 status（预览未启动）→ 503", async () => {
    preview.status.mockReturnValue(null);
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(503);
  });

  it("ready → 转发到 127.0.0.1:{port}，透传 status + body", async () => {
    preview.status.mockReturnValue({ state: "ready", port: 41000, kind: "static" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:41000/", expect.objectContaining({}));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>ok</html>");
    vi.unstubAllGlobals();
  });

  it("path 透传：/preview/t1/foo/bar.js → 转发 /foo/bar.js", async () => {
    preview.status.mockReturnValue({ state: "ready", port: 41001, kind: "static" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("js", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await GET(req("t1", ["foo", "bar.js"]), {
      params: Promise.resolve({ threadId: "t1", path: ["foo", "bar.js"] }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:41001/foo/bar.js",
      expect.objectContaining({}),
    );
    vi.unstubAllGlobals();
  });
});
