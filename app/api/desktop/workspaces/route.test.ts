import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/conversations/route-helpers", () => ({
  resolveEmployeePrincipal: vi.fn(),
  employeeAuthErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/workspace/desktop-workspace-queries", () => ({
  ensureDesktopWorkspace: vi.fn(),
}));

import {
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { ensureDesktopWorkspace } from "@/lib/workspace/desktop-workspace-queries";
import { POST } from "./route";

const principal = {
  tenantId: "tenant-1",
  userIdentityId: "user-1",
  audience: "employee",
};
const body = {
  device_id: "device-key-1",
  display_name: "snow_harness",
  location_fingerprint: `sha256:${"a".repeat(64)}`,
};

function request(value: unknown): Request {
  return new Request("http://localhost/api/desktop/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("POST /api/desktop/workspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveEmployeePrincipal).mockResolvedValue(principal as never);
    vi.mocked(ensureDesktopWorkspace).mockResolvedValue({
      workspaceId: "workspace-1",
      bindingId: "binding-1",
      displayName: "snow_harness",
    });
  });

  it("按当前员工和已注册设备登记目录指纹，不接收绝对路径", async () => {
    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(ensureDesktopWorkspace).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userId: "user-1",
      deviceKey: "device-key-1",
      displayName: "snow_harness",
      locationFingerprint: body.location_fingerprint,
    });
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        workspace_id: "workspace-1",
        binding_id: "binding-1",
        display_name: "snow_harness",
      },
    });
  });

  it("拒绝绝对路径字段和非法指纹", async () => {
    const response = await POST(
      request({ ...body, path: "/Users/example/project", location_fingerprint: "bad" }),
    );

    expect(response.status).toBe(400);
    expect(ensureDesktopWorkspace).not.toHaveBeenCalled();
  });

  it("鉴权失败时不登记", async () => {
    vi.mocked(resolveEmployeePrincipal).mockRejectedValue(new Error("unauthorized"));
    vi.mocked(employeeAuthErrorResponse).mockReturnValue(new Response(null, { status: 401 }));

    const response = await POST(request(body));

    expect(response.status).toBe(401);
    expect(ensureDesktopWorkspace).not.toHaveBeenCalled();
  });
});
