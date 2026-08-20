import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity/resolver", () => ({
  resolvePrincipal: vi.fn(),
  authErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/identity/device-queries", () => ({
  registerDevice: vi.fn(),
}));

import { registerDevice } from "@/lib/identity/device-queries";
import { authErrorResponse, resolvePrincipal } from "@/lib/identity/resolver";
import { POST } from "./route";

const PRINCIPAL = {
  tenantId: "tenant-1",
  tenantKey: "t1",
  userIdentityId: "user-1",
  externalSubject: "ext-1",
  email: "user@example.com",
  displayName: null,
  audience: "employee",
};
const DEVICE = {
  id: "record-1",
  tenantId: PRINCIPAL.tenantId,
  userId: PRINCIPAL.userIdentityId,
  deviceKey: "device-123",
  publicKey: "cHVibGljLWtleQ==",
  deviceName: "MacBook Pro",
  appVersion: "0.1.0",
  deviceState: "active" as const,
  lastActiveAt: new Date(),
  revokedAt: null,
  createdAt: new Date(),
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/desktop/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 符合 registrationSchema 的请求体（deviceId/name/version 映射自正式字段）。 */
const BODY = {
  deviceId: DEVICE.deviceKey,
  publicKey: DEVICE.publicKey,
  name: DEVICE.deviceName,
  version: DEVICE.appVersion,
};

describe("POST /api/desktop/devices/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolvePrincipal).mockResolvedValue(PRINCIPAL as never);
    vi.mocked(registerDevice).mockResolvedValue(DEVICE as never);
  });

  it("使用当前主体（tenantId + userIdentityId）注册 Desktop 公钥", async () => {
    const response = await POST(
      request({
        deviceId: DEVICE.deviceKey,
        publicKey: DEVICE.publicKey,
        name: DEVICE.deviceName,
        version: DEVICE.appVersion,
      }),
    );

    expect(response.status).toBe(200);
    // 正式字段映射：deviceId→deviceKey、name→deviceName、version→appVersion
    expect(registerDevice).toHaveBeenCalledWith({
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userIdentityId,
      deviceKey: DEVICE.deviceKey,
      publicKey: DEVICE.publicKey,
      deviceName: DEVICE.deviceName,
      appVersion: DEVICE.appVersion,
    });
    const json = await response.json();
    expect(json.data).toEqual({
      deviceId: DEVICE.deviceKey,
      status: "active",
      tenantId: PRINCIPAL.tenantId,
    });
    // 不暴露 publicKey 及内部 id
    expect(JSON.stringify(json)).not.toContain(DEVICE.publicKey);
    expect(JSON.stringify(json)).not.toContain(DEVICE.id);
  });

  it("鉴权失败返回认证响应", async () => {
    vi.mocked(resolvePrincipal).mockRejectedValue(new Error("unauthorized"));
    vi.mocked(authErrorResponse).mockReturnValue(new Response(null, { status: 401 }));

    const response = await POST(request(BODY));

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

  it("拒绝 deviceKey 已绑定到其他用户", async () => {
    vi.mocked(registerDevice).mockResolvedValue({ ...DEVICE, userId: "other-user" } as never);

    const response = await POST(request(BODY));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("device_binding_conflict");
  });

  it("拒绝同一 deviceKey 的公钥发生变化", async () => {
    vi.mocked(registerDevice).mockResolvedValue({ ...DEVICE, publicKey: "other-key" } as never);

    const response = await POST(request(BODY));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("device_binding_conflict");
  });

  it("拒绝已撤销设备重新激活", async () => {
    vi.mocked(registerDevice).mockResolvedValue({
      ...DEVICE,
      deviceState: "revoked" as const,
    } as never);

    const response = await POST(request(BODY));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("device_revoked");
  });
});
