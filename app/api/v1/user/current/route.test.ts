import { describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  resolveCurrentUserContext: vi.fn(),
}));

vi.mock("@/lib/identity/resolver", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/identity/resolver")>("@/lib/identity/resolver");
  return { ...actual, resolveCurrentUserContext: auth.resolveCurrentUserContext };
});

import { GET } from "./route";

describe("GET /api/v1/user/current", () => {
  it("只返回标准身份和企业资料健康状态，不下发企业字段", async () => {
    auth.resolveCurrentUserContext.mockResolvedValue({
      tenantId: "tenant-1",
      tenantKey: "default",
      userIdentityId: "user-1",
      externalSubject: "subject-1",
      email: "user@example.com",
      displayName: "员工",
      audience: "employee",
      profileStatus: "fresh",
      lastVerifiedAt: new Date("2026-09-05T00:00:00.000Z"),
      enterpriseAttributes: {
        employeeNo: "E-001",
        enterprisePermissions: ["payroll.read"],
        dataScopes: ["factory-a"],
      },
    });

    const response = await GET(new Request("http://localhost/api/v1/user/current"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "员工",
      },
      profileStatus: "fresh",
      lastVerifiedAt: "2026-09-05T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("employeeNo");
    expect(JSON.stringify(body)).not.toContain("enterprisePermissions");
    expect(JSON.stringify(body)).not.toContain("dataScopes");
  });
});
