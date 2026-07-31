/**
 * V10 Phase 8：Desktop 设备撤销 API route 测试。
 *
 * 覆盖维度：
 * - 鉴权失败 → 401
 * - 非 owner → 404
 * - 设备不存在 → 404
 * - 设备已 revoked → 409（幂等拒绝）
 * - 成功撤销 → 200 + 返回设备信息
 * - 成功撤销后调用 BridgeServer.kickDevice 主动断开 WS
 * - GET 方法 → 405
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

// Mock 依赖
vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: vi.fn(),
  authErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/db/desktop-device-queries", () => ({
  getDeviceForUser: vi.fn(),
  revokeDevice: vi.fn(),
}));
vi.mock("@/lib/desktop-bridge/bridge-server", () => ({
  getBridgeServer: vi.fn(() => null),
}));
vi.mock("@/lib/http", () => ({
  jsonError: vi.fn((status, code, message) =>
    Response.json({ ok: false, error: { code, message } }, { status }),
  ),
}));

import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { getDeviceForUser, revokeDevice } from "@/lib/db/desktop-device-queries";
import { getBridgeServer } from "@/lib/desktop-bridge/bridge-server";

const mockUser = { id: "u1", email: "test@example.com" };

const mockDevice = {
  id: "rec-1",
  userId: "u1",
  deviceId: "desktop-aaa",
  publicKey: "pk",
  name: "MBP",
  version: "1.0.0",
  status: "active" as const,
  lastActiveAt: new Date("2026-07-13T10:00:00Z"),
  revokedAt: null,
  createdAt: new Date("2026-07-13T09:00:00Z"),
  updatedAt: new Date("2026-07-13T10:00:00Z"),
};

function makeRequest(method: "POST" | "GET" = "POST"): Request {
  return new Request("http://localhost/api/desktop/devices/desktop-aaa/revoke", { method });
}

describe("POST /api/desktop/devices/[deviceId]/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUserFromRequest).mockResolvedValue(mockUser as never);
    vi.mocked(getDeviceForUser).mockResolvedValue(mockDevice as never);
    vi.mocked(revokeDevice).mockResolvedValue({
      ...mockDevice,
      status: "revoked",
      revokedAt: new Date(),
    } as never);
    vi.mocked(getBridgeServer).mockReturnValue(null);
  });

  it("鉴权失败返回 401", async () => {
    vi.mocked(getCurrentUserFromRequest).mockRejectedValue(new Error("unauthorized"));
    vi.mocked(authErrorResponse).mockReturnValue(new Response(null, { status: 401 }));

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "desktop-aaa" }),
    });
    expect(resp.status).toBe(401);
  });

  it("非 owner 返回 404", async () => {
    vi.mocked(getDeviceForUser).mockResolvedValue(null);

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "desktop-aaa" }),
    });
    expect(resp.status).toBe(404);
    const json = await resp.json();
    expect(json.error.code).toBe("device_not_found");
  });

  it("设备不存在返回 404", async () => {
    vi.mocked(getDeviceForUser).mockResolvedValue(null);

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "non-existent" }),
    });
    expect(resp.status).toBe(404);
  });

  it("成功撤销返回 200 + 设备信息", async () => {
    const revokedAt = new Date("2026-07-13T11:00:00Z");
    vi.mocked(revokeDevice).mockResolvedValue({
      ...mockDevice,
      status: "revoked",
      revokedAt,
      updatedAt: revokedAt,
    } as never);

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "desktop-aaa" }),
    });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.data.deviceId).toBe("desktop-aaa");
    expect(json.data.status).toBe("revoked");
    expect(json.data.revokedAt).toBeTruthy();
  });

  it("设备已 revoked 返回 409（幂等拒绝）", async () => {
    // getDeviceForUser 返回 status=revoked 的设备
    vi.mocked(getDeviceForUser).mockResolvedValue({
      ...mockDevice,
      status: "revoked",
      revokedAt: new Date("2026-07-13T10:30:00Z"),
    } as never);

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "desktop-aaa" }),
    });
    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.error.code).toBe("device_already_revoked");
  });

  it("成功撤销后调用 BridgeServer.kickDevice 主动断开 WS", async () => {
    const mockKickDevice = vi.fn(() => true);
    vi.mocked(getBridgeServer).mockReturnValue({ kickDevice: mockKickDevice } as never);

    await POST(makeRequest(), { params: Promise.resolve({ deviceId: "desktop-aaa" }) });

    expect(mockKickDevice).toHaveBeenCalledWith("desktop-aaa");
  });

  it("BridgeServer 未运行时不抛错", async () => {
    vi.mocked(getBridgeServer).mockReturnValue(null);

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "desktop-aaa" }),
    });
    expect(resp.status).toBe(200);
  });

  it("revokeDevice 返回 null（并发删除）返回 404", async () => {
    vi.mocked(revokeDevice).mockResolvedValue(null);

    const resp = await POST(makeRequest(), {
      params: Promise.resolve({ deviceId: "desktop-aaa" }),
    });
    expect(resp.status).toBe(404);
    const json = await resp.json();
    expect(json.error.code).toBe("device_not_found");
  });
});

describe("GET /api/desktop/devices/[deviceId]/revoke", () => {
  it("GET 方法返回 405", async () => {
    const resp = await GET();
    expect(resp.status).toBe(405);
  });
});
