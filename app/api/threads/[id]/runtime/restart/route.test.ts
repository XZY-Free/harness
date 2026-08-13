import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

// Mock 依赖
vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: vi.fn(),
  authErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/db/queries", () => ({
  requireThreadForUser: vi.fn(),
  getThreadByIdForUser: vi.fn(),
}));
const mockPreview = {
  start: vi.fn().mockResolvedValue({ port: 3001, token: "tok", kind: "static" }),
  stop: vi.fn().mockResolvedValue(undefined),
  status: vi.fn(() => ({ state: "ready", port: 3001, token: "tok", kind: "static" })),
};
const mockRuntimeHandle = { preview: mockPreview };

vi.mock("@/lib/runtime/registry", () => ({
  resolveRuntimeTypeForThread: vi.fn(() => "host"),
  resolveRuntimes: vi.fn(() => mockRuntimeHandle),
}));
vi.mock("@/lib/http", () => ({
  jsonError: vi.fn((status, code, message) =>
    Response.json({ ok: false, error: { code, message } }, { status }),
  ),
}));

import { getCurrentUserFromRequest } from "@/lib/auth";
import { getThreadByIdForUser, requireThreadForUser } from "@/lib/db/queries";

const mockUser = { id: "u1", email: "test@example.com" };

function makeRequest(method: "POST" | "GET" = "POST"): Request {
  return new Request("http://localhost/api/threads/t1/runtime/restart", { method });
}

describe("POST /api/threads/[id]/runtime/restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUserFromRequest).mockResolvedValue(mockUser as any);
    vi.mocked(requireThreadForUser).mockResolvedValue({
      id: "t1",
      userId: "u1",
      previewUrl: "/preview/t1/index.html",
      runtimeType: null,
    } as any);
    vi.mocked(getThreadByIdForUser).mockResolvedValue({
      id: "t1",
      userId: "u1",
      previewUrl: "/preview/t1/index.html",
      runtimeType: null,
    } as any);
  });

  it("鉴权失败返回 401", async () => {
    vi.mocked(getCurrentUserFromRequest).mockRejectedValue(new Error("unauthorized"));
    const { authErrorResponse } = await import("@/lib/auth");
    vi.mocked(authErrorResponse).mockReturnValue(new Response(null, { status: 401 }));

    const resp = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "t1" }) });
    expect(resp.status).toBe(401);
  });

  it("非 owner 返回 404", async () => {
    vi.mocked(requireThreadForUser).mockResolvedValue(null);
    const resp = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "t1" }) });
    expect(resp.status).toBe(404);
  });

  it("owner 成功重启：先 stop 再 start，返回 ok", async () => {
    const resp = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "t1" }) });
    const json = await resp.json();

    expect(resp.status).toBe(200);
    expect(json.ok).toBe(true);
    // 验证 stop 被调用
    expect(mockPreview.stop).toHaveBeenCalledWith("t1");
    expect(mockPreview.start).toHaveBeenCalledWith("t1");
  });

  it("无 previewUrl 时仍允许重启（可能用户手动启动了 runtime 但未走 reportReady）", async () => {
    vi.mocked(getThreadByIdForUser).mockResolvedValue({
      id: "t1",
      userId: "u1",
      previewUrl: null,
      runtimeType: null,
    } as any);
    const resp = await POST(makeRequest("POST"), { params: Promise.resolve({ id: "t1" }) });
    expect(resp.status).toBe(200);
  });
});

describe("GET /api/threads/[id]/runtime/restart", () => {
  it("GET 方法返回 405", async () => {
    const resp = await GET();
    expect(resp.status).toBe(405);
  });
});
