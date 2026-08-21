import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-3 Stage D：preview API owner guard。
 *
 * mock auth / queries / preview runtime，验证 foreign thread → 404 且不启动副作用，
 * owned thread → start/stop 正常调用。
 *
 * Phase 5 Stage A：route 已切到 `resolveRuntimes(threadId).preview`（PreviewRuntime interface），
 * mock 随之从 `@/lib/preview/manager` 迁到 `@/lib/runtime/registry`。
 *
 * 02-2b：授权契约迁到正式 Principal 解析（resolveStudioPrincipal + authErrorResponse）。
 */

const studio = vi.hoisted(() => ({
  resolveStudioPrincipal: vi.fn(),
}));
const resolver = vi.hoisted(() => ({
  authErrorResponse: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  requireThreadForUser: vi.fn(),
}));
const preview = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  resolveRuntimes: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/identity/resolver", () => ({
  authErrorResponse: resolver.authErrorResponse,
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

import { POST } from "@/app/api/preview/route";

/** resolveStudioPrincipal 返回的 Principal：路由读取 userIdentityId 作 owner guard。 */
const PRINCIPAL = {
  id: "u1",
  email: "a@x",
  name: "A",
  externalId: "u1",
  createdAt: new Date(),
  userIdentityId: "u1",
  tenantId: "t1",
};
const OWNED = { id: "t1", userId: "u1" };

function req(body: unknown): Request {
  return new Request("http://localhost/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  resolver.authErrorResponse.mockReturnValue(null);
  registry.resolveRuntimes.mockReturnValue({ preview });
});

describe("POST /api/preview owner guard (Phase 4-3)", () => {
  it("foreign thread → 404 且不 startPreview", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await POST(req({ threadId: "t1", action: "start" }));
    expect(res.status).toBe(404);
    expect(preview.start).not.toHaveBeenCalled();
    expect(preview.stop).not.toHaveBeenCalled();
  });

  it("owned thread + start → 调 startPreview 一次", async () => {
    queries.requireThreadForUser.mockResolvedValue(OWNED);
    preview.start.mockResolvedValue({ url: "http://x", port: 1, kind: "static" });
    const res = await POST(req({ threadId: "t1", action: "start" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 静态页面显式指向 index.html，保证相对 CSS/JS 仍落在 thread 目录内。
    expect(body.data).toMatchObject({ status: "ready", url: "/preview/t1/index.html" });
    expect(registry.resolveRuntimes).toHaveBeenCalledWith("t1", "host");
    expect(preview.start).toHaveBeenCalledTimes(1);
    expect(preview.start).toHaveBeenCalledWith("t1");
  });

  it("owned thread + runtimeType=container → 用 container preview runtime", async () => {
    queries.requireThreadForUser.mockResolvedValue({ ...OWNED, runtimeType: "container" });
    preview.start.mockResolvedValue({ url: "http://x", port: 41000, kind: "dev-server" });
    const res = await POST(req({ threadId: "t1", action: "start" }));

    expect(res.status).toBe(200);
    expect(registry.resolveRuntimes).toHaveBeenCalledWith("t1", "container");
    expect(preview.start).toHaveBeenCalledWith("t1");
  });

  it("owned thread + stop → 调 stopPreview 一次", async () => {
    queries.requireThreadForUser.mockResolvedValue(OWNED);
    preview.stop.mockResolvedValue(undefined);
    const res = await POST(req({ threadId: "t1", action: "stop" }));
    expect(res.status).toBe(200);
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(preview.stop).toHaveBeenCalledWith("t1");
    expect(preview.start).not.toHaveBeenCalled();
  });

  it("缺 threadId → 400，不触发 auth / preview", async () => {
    const res = await POST(req({ action: "start" }));
    expect(res.status).toBe(400);
    expect(studio.resolveStudioPrincipal).not.toHaveBeenCalled();
    expect(preview.start).not.toHaveBeenCalled();
  });

  it("缺 SSO 身份 → 401，不查 thread / 不启 preview", async () => {
    studio.resolveStudioPrincipal.mockRejectedValue(new Error("缺少 SSO 用户标识"));
    resolver.authErrorResponse.mockReturnValue(new Response(null, { status: 401 }));
    const res = await POST(req({ threadId: "t1", action: "start" }));
    expect(res.status).toBe(401);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
    expect(preview.start).not.toHaveBeenCalled();
  });
});
