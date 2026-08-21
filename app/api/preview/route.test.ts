import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-3 Stage D：preview API owner guard（正式 v1 鉴权）。
 *
 * mock 员工身份 / thread-queries / preview runtime，验证 foreign thread → 404 且不启动副作用，
 * owned thread → start/stop 正常调用。
 *
 * 02-2b / 02-3：授权契约迁到正式 Employee Principal（resolveEmployeePrincipal + owner 校验），
 * 不再依赖已删的 requireThreadForUser / workspace-access。
 */

const auth = vi.hoisted(() => ({
  resolveEmployeePrincipal: vi.fn(),
}));
const threadQueries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
}));
const preview = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
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

import { POST } from "@/app/api/preview/route";
import { AuthenticationError } from "@/lib/identity/resolver";

/** resolveEmployeePrincipal 返回的 Principal（Employee 身份）。 */
const PRINCIPAL = { tenantId: "t1", userIdentityId: "u1" };
const OWNED = { id: "t1", tenantId: "t1", ownerUserId: "u1", lifecycleState: "active" };

function req(body: unknown): Request {
  return new Request("http://localhost/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.resolveEmployeePrincipal.mockResolvedValue(PRINCIPAL);
  threadQueries.getThreadById.mockResolvedValue(OWNED);
  registry.resolveRuntimes.mockReturnValue({ preview });
});

describe("POST /api/preview owner guard (正式 v1)", () => {
  it("foreign thread → 404 且不 startPreview", async () => {
    threadQueries.getThreadById.mockResolvedValue(null);
    const res = await POST(req({ threadId: "t1", action: "start" }));
    expect(res.status).toBe(404);
    expect(preview.start).not.toHaveBeenCalled();
    expect(preview.stop).not.toHaveBeenCalled();
  });

  it("owned thread + start → 调 startPreview 一次", async () => {
    preview.start.mockResolvedValue({ url: "http://x", port: 1, kind: "static" });
    const res = await POST(req({ threadId: "t1", action: "start" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 静态页面显式指向 index.html，保证相对 CSS/JS 仍落在 thread 目录内。
    expect(body.data).toMatchObject({ status: "ready", url: "/preview/t1/index.html" });
    // 正式 Thread 无 runtimeType 列，落全局默认 host。
    expect(registry.resolveRuntimes).toHaveBeenCalledWith("t1", "host");
    expect(preview.start).toHaveBeenCalledTimes(1);
    expect(preview.start).toHaveBeenCalledWith("t1");
  });

  it("owned thread + stop → 调 stopPreview 一次", async () => {
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
    expect(auth.resolveEmployeePrincipal).not.toHaveBeenCalled();
    expect(preview.start).not.toHaveBeenCalled();
  });

  it("缺身份 → 401，不查 thread / 不启 preview", async () => {
    auth.resolveEmployeePrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少身份"),
    );
    const res = await POST(req({ threadId: "t1", action: "start" }));
    expect(res.status).toBe(401);
    expect(threadQueries.getThreadById).not.toHaveBeenCalled();
    expect(preview.start).not.toHaveBeenCalled();
  });
});
