import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 5 Stage D：预览反向代理 /preview/[threadId]/* 测试（正式 v1 鉴权）。
 * mock 员工身份 / thread-queries / registry / global fetch，覆盖 owner guard 404、
 * 未 ready 503、ready 转发 200 + path 透传。
 *
 * 02-2b / 02-3：授权契约迁到正式 Employee Principal（resolveEmployeePrincipal + owner 校验），
 * 不再依赖已删的 requireThreadForUser / workspace-access。
 */

const auth = vi.hoisted(() => ({ resolveEmployeePrincipal: vi.fn() }));
const threadQueries = vi.hoisted(() => ({ getThreadById: vi.fn() }));
const preview = vi.hoisted(() => ({ status: vi.fn() }));
const registry = vi.hoisted(() => ({
  resolveRuntimes: vi.fn(),
}));

vi.mock("@/lib/conversations/route-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/conversations/route-helpers")>();
  return { ...original, resolveEmployeePrincipal: auth.resolveEmployeePrincipal };
});
vi.mock("@/lib/conversations/thread-queries", () => ({
  getThreadById: threadQueries.getThreadById,
}));
vi.mock("@/lib/runtime/registry", () => ({
  resolveRuntimeTypeForThread: () => "host",
  resolveRuntimes: registry.resolveRuntimes,
}));

import { GET } from "@/app/preview/[threadId]/[[...path]]/route";
import { AuthenticationError } from "@/lib/identity/resolver";

const PRINCIPAL = { tenantId: "t1", userIdentityId: "u1" };
const OWNED = { id: "t1", tenantId: "t1", ownerUserId: "u1", lifecycleState: "active" };

function req(threadId: string, path?: string[]): Request {
  const urlPath = `/preview/${threadId}/${path ? path.join("/") : ""}`;
  return new Request(`http://localhost${urlPath}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.resolveEmployeePrincipal.mockResolvedValue(PRINCIPAL);
  threadQueries.getThreadById.mockResolvedValue(OWNED);
  registry.resolveRuntimes.mockReturnValue({ preview });
});

describe("GET /preview/[threadId]/* 反向代理 (Phase 5 Stage D, 正式 v1)", () => {
  it("foreign thread → 404", async () => {
    threadQueries.getThreadById.mockResolvedValue(null);
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(404);
    expect(preview.status).not.toHaveBeenCalled();
  });

  it("缺身份 → 401", async () => {
    auth.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少身份"),
    );
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(401);
  });

  it("未 ready → 503", async () => {
    preview.status.mockReturnValue({ state: "starting", port: 41000, kind: "dev-server" });
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(503);
  });

  it("用全局默认 runtime 类型（host）查 status registry", async () => {
    preview.status.mockReturnValue({ state: "starting", port: 41000, kind: "dev-server" });
    const res = await GET(req("t1"), { params: Promise.resolve({ threadId: "t1" }) });

    expect(res.status).toBe(503);
    // 正式 Thread 无 runtimeType 列，落全局默认 host。
    expect(registry.resolveRuntimes).toHaveBeenCalledWith("t1", "host");
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
