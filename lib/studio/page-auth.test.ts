import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getCurrentUserFromRequest: vi.fn() }));
const rbac = vi.hoisted(() => ({ hasPermission: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  AuthError: class AuthError extends Error {
    constructor(
      public readonly code: "missing_identity" | "missing_email",
      message: string,
    ) {
      super(message);
    }
  },
  getCurrentUserFromRequest: auth.getCurrentUserFromRequest,
}));

vi.mock("@/lib/rbac", () => ({
  hasPermission: rbac.hasPermission,
}));

import { AuthError } from "@/lib/auth";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUserFromRequest.mockResolvedValue(USER);
  rbac.hasPermission.mockResolvedValue(true);
});

describe("requireStudioPagePermission", () => {
  it("有权限时返回当前用户", async () => {
    const result = await requireStudioPagePermission("skill.read");
    expect(result).toEqual({ ok: true, user: USER });
    expect(rbac.hasPermission).toHaveBeenCalledWith("u1", "skill.read");
  });

  it("无权限时返回 403 gate 数据", async () => {
    rbac.hasPermission.mockResolvedValue(false);
    const result = await requireStudioPagePermission("policy.read");
    expect(result).toEqual({ ok: false, status: 403, message: "无 policy.read 权限" });
  });

  it("认证失败时返回 401 gate 数据", async () => {
    auth.getCurrentUserFromRequest.mockRejectedValue(
      new AuthError("missing_identity", "缺少 SSO 用户标识"),
    );
    const result = await requireStudioPagePermission("studio.access");
    expect(result).toEqual({ ok: false, status: 401, message: "未认证：缺少 SSO 身份" });
    expect(rbac.hasPermission).not.toHaveBeenCalled();
  });
});
