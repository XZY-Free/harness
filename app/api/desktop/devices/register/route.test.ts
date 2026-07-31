import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: vi.fn(),
  authErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/db/desktop-device-queries", () => ({
  registerDevice: vi.fn(),
}));

import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { registerDevice } from "@/lib/db/desktop-device-queries";
import { POST } from "./route";

const USER = { id: "user-1", email: "user@example.com" };
const DEVICE = {
  id: "record-1",
  userId: USER.id,
  deviceId: "device-123",
  publicKey: "cHVibGljLWtleQ==",
  name: "MacBook Pro",
  version: "0.1.0",
  status: "active" as const,
  lastActiveAt: new Date(),
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/desktop/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/desktop/devices/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUserFromRequest).mockResolvedValue(USER as never);
    vi.mocked(registerDevice).mockResolvedValue(DEVICE as never);
  });

  it("使用当前登录用户绑定 Desktop 公钥", async () => {
    const response = await POST(
      request({
        deviceId: DEVICE.deviceId,
        publicKey: DEVICE.publicKey,
        name: DEVICE.name,
        version: DEVICE.version,
      }),
    );

    expect(response.status).toBe(200);
    expect(registerDevice).toHaveBeenCalledWith({
      userId: USER.id,
      deviceId: DEVICE.deviceId,
      publicKey: DEVICE.publicKey,
      name: DEVICE.name,
      version: DEVICE.version,
    });
    const json = await response.json();
    expect(json.data).toEqual({ deviceId: DEVICE.deviceId, status: "active" });
    expect(JSON.stringify(json)).not.toContain(DEVICE.publicKey);
  });

  it("鉴权失败返回认证响应", async () => {
    vi.mocked(getCurrentUserFromRequest).mockRejectedValue(new Error("unauthorized"));
    vi.mocked(authErrorResponse).mockReturnValue(new Response(null, { status: 401 }));

    const response = await POST(request(DEVICE));

    expect(response.status).toBe(401);
    expect(registerDevice).not.toHaveBeenCalled();
  });

  it("拒绝缺失或超长字段", async () => {
    const response = await POST(
      request({ deviceId: "", publicKey: "", name: "x".repeat(257), version: "" }),
    );

    expect(response.status).toBe(400);
    expect(registerDevice).not.toHaveBeenCalled();
  });

  it("拒绝 deviceId 已绑定到其他用户", async () => {
    vi.mocked(registerDevice).mockResolvedValue({ ...DEVICE, userId: "other-user" } as never);

    const response = await POST(request(DEVICE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("device_binding_conflict");
  });

  it("拒绝同一 deviceId 的公钥发生变化", async () => {
    vi.mocked(registerDevice).mockResolvedValue({ ...DEVICE, publicKey: "other-key" } as never);

    const response = await POST(request(DEVICE));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("device_binding_conflict");
  });
});
