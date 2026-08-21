import { beforeEach, describe, expect, it, vi } from "vitest";

const studio = vi.hoisted(() => ({
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));

import { AuthenticationError } from "@/lib/identity/resolver";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  studio.hasStudioAction.mockResolvedValue(true);
});

describe("requireStudioPagePermission", () => {
  it("有权限时返回当前 principal", async () => {
    const result = await requireStudioPagePermission("skill.read");
    expect(result).toEqual({ ok: true, principal: PRINCIPAL });
    expect(studio.hasStudioAction).toHaveBeenCalledWith(PRINCIPAL, "skill.read");
  });

  it("无权限时返回 403 gate 数据", async () => {
    studio.hasStudioAction.mockResolvedValue(false);
    const result = await requireStudioPagePermission("policy.read");
    expect(result).toEqual({ ok: false, status: 403, message: "无 policy.read 权限" });
  });

  it("认证失败时返回 401 gate 数据", async () => {
    studio.resolveStudioPrincipal.mockRejectedValue(
      new AuthenticationError("missing_identity", "缺少 SSO 用户标识"),
    );
    const result = await requireStudioPagePermission("studio.access");
    expect(result).toEqual({ ok: false, status: 401, message: "未认证：缺少 SSO 身份" });
    expect(studio.hasStudioAction).not.toHaveBeenCalled();
  });
});
