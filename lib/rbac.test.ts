import { DEFAULT_USER_ID } from "@/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 Stage A：RBAC 权限解析与守卫单测。
 *
 * mock @/lib/db/queries#getPermissionsForUserRaw（纯数据查询）与 @/lib/auth#getCurrentUserFromRequest，
 * 断言策略层：devOpen 注入、member 权限并集、requirePermission 通过 / 403 / AuthError→401。
 */

const mocks = vi.hoisted(() => ({
  // getPermissionsForUserRaw 返回原始权限名数组（未经 Permission 过滤）
  permsRaw: vi.fn(),
  getCurrentUserFromRequest: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  getPermissionsForUserRaw: mocks.permsRaw,
}));
vi.mock("@/lib/auth", () => ({
  // 真实 AuthError / authErrorResponse 保留语义；仅 getCurrentUserFromRequest 可控
  AuthError: class AuthError extends Error {
    constructor(
      public readonly code: "missing_identity" | "missing_email",
      message: string,
    ) {
      super(message);
    }
  },
  authErrorResponse: (error: unknown) => {
    if (error instanceof Error && error.message.startsWith("AUTH:")) {
      return new Response(error.message, { status: 401 });
    }
    return null;
  },
  getCurrentUserFromRequest: mocks.getCurrentUserFromRequest,
}));

import { AuthError } from "@/lib/auth";
import {
  ADMIN_PERMISSIONS,
  MEMBER_PERMISSIONS,
  PERMISSIONS,
  getPermissionsForUser,
  hasPermission,
  requirePermission,
} from "@/lib/rbac";

const ORIG_STUDIO_OPEN = process.env.SNOW_STUDIO_OPEN;

function setStudioOpen(value: string) {
  process.env.SNOW_STUDIO_OPEN = value;
}

beforeEach(() => {
  mocks.permsRaw.mockReset();
  mocks.getCurrentUserFromRequest.mockReset();
  // 默认开启 devOpen（test 环境 isProd=false）
  setStudioOpen("true");
});

afterEach(() => {
  // 还原原值（不使用 delete，避免 noDelete 规则）
  process.env.SNOW_STUDIO_OPEN = ORIG_STUDIO_OPEN;
});

describe("PERMISSIONS 常量 (切片 B1)", () => {
  it("含 agent.read / provider.read", () => {
    expect(PERMISSIONS).toContain("agent.read");
    expect(PERMISSIONS).toContain("provider.read");
  });

  it("MEMBER_PERMISSIONS 含 2 项新只读权限", () => {
    expect(MEMBER_PERMISSIONS).toContain("agent.read");
    expect(MEMBER_PERMISSIONS).toContain("provider.read");
  });

  it("ADMIN_PERMISSIONS = 全集（含 2 项新权限）", () => {
    expect(ADMIN_PERMISSIONS).toEqual([...PERMISSIONS]);
    expect(ADMIN_PERMISSIONS).toContain("agent.read");
    expect(ADMIN_PERMISSIONS).toContain("provider.read");
  });
});

describe("PERMISSIONS 常量 (切片 B2)", () => {
  it("含 workspace.read / workspace.write", () => {
    expect(PERMISSIONS).toContain("workspace.read");
    expect(PERMISSIONS).toContain("workspace.write");
  });

  it("MEMBER_PERMISSIONS 含 workspace.read，不含 workspace.write", () => {
    expect(MEMBER_PERMISSIONS).toContain("workspace.read");
    expect(MEMBER_PERMISSIONS).not.toContain("workspace.write");
  });

  it("ADMIN_PERMISSIONS = 全集（含 workspace.write）", () => {
    expect(ADMIN_PERMISSIONS).toEqual([...PERMISSIONS]);
    expect(ADMIN_PERMISSIONS).toContain("workspace.read");
    expect(ADMIN_PERMISSIONS).toContain("workspace.write");
  });
});

describe("PERMISSIONS 常量 (切片 C)", () => {
  it("含 audit.read", () => {
    expect(PERMISSIONS).toContain("audit.read");
  });

  it("ADMIN_PERMISSIONS 含 audit.read", () => {
    expect(ADMIN_PERMISSIONS).toEqual([...PERMISSIONS]);
    expect(ADMIN_PERMISSIONS).toContain("audit.read");
  });

  it("MEMBER_PERMISSIONS 不含 audit.read", () => {
    expect(MEMBER_PERMISSIONS).not.toContain("audit.read");
  });
});

describe("getPermissionsForUser (Stage A)", () => {
  it("devOpen + DEFAULT_USER_ID → 注入全部权限，不查 DB", async () => {
    const perms = await getPermissionsForUser(DEFAULT_USER_ID);
    expect(perms.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(perms.has(p)).toBe(true);
    expect(mocks.permsRaw).not.toHaveBeenCalled();
  });

  it("关闭 devOpen → DEFAULT_USER_ID 走 DB 查询", async () => {
    setStudioOpen("false");
    mocks.permsRaw.mockResolvedValue([
      "studio.access",
      "skill.read",
      "analytics.read.self",
      "policy.read",
    ]);
    const perms = await getPermissionsForUser(DEFAULT_USER_ID);
    expect(perms.has("studio.access")).toBe(true);
    expect(perms.has("skill.write")).toBe(false); // member 无写权限
    expect(mocks.permsRaw).toHaveBeenCalledWith(DEFAULT_USER_ID);
  });

  it("非默认用户始终走 DB（不受 devOpen 影响）", async () => {
    mocks.permsRaw.mockResolvedValue(["studio.access"]);
    const perms = await getPermissionsForUser("user-other");
    expect(perms.has("studio.access")).toBe(true);
    expect(perms.size).toBe(1);
  });

  it("DB 返回未知权限名被过滤掉（只保留固定集合）", async () => {
    setStudioOpen("false");
    mocks.permsRaw.mockResolvedValue(["studio.access", "bogus.perm", "skill.read"]);
    const perms = await getPermissionsForUser(DEFAULT_USER_ID);
    expect(perms.has("studio.access")).toBe(true);
    expect(perms.has("bogus.perm" as never)).toBe(false);
    expect(perms.size).toBe(2);
  });

  it("无角色用户 → 空权限集", async () => {
    setStudioOpen("false");
    mocks.permsRaw.mockResolvedValue([]);
    const perms = await getPermissionsForUser(DEFAULT_USER_ID);
    expect(perms.size).toBe(0);
  });
});

describe("hasPermission (Stage A)", () => {
  it("admin 用户对任意权限返回 true", async () => {
    for (const p of PERMISSIONS) {
      expect(await hasPermission(DEFAULT_USER_ID, p)).toBe(true);
    }
  });

  it("member 用户对 skill.write 返回 false", async () => {
    setStudioOpen("false");
    mocks.permsRaw.mockResolvedValue([
      "studio.access",
      "skill.read",
      "analytics.read.self",
      "policy.read",
    ]);
    expect(await hasPermission(DEFAULT_USER_ID, "skill.read")).toBe(true);
    expect(await hasPermission(DEFAULT_USER_ID, "skill.write")).toBe(false);
  });
});

describe("requirePermission (Stage A)", () => {
  it("有权限 → { ok:true, user }", async () => {
    const user = {
      id: DEFAULT_USER_ID,
      email: "a@x",
      name: "A",
      externalId: DEFAULT_USER_ID,
      createdAt: new Date(),
    };
    mocks.getCurrentUserFromRequest.mockResolvedValue(user);
    const r = await requirePermission({ headers: new Headers() }, "studio.access");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.id).toBe(DEFAULT_USER_ID);
  });

  it("无权限 → { ok:false, response 403 }", async () => {
    setStudioOpen("false");
    mocks.permsRaw.mockResolvedValue(["studio.access"]);
    mocks.getCurrentUserFromRequest.mockResolvedValue({
      id: DEFAULT_USER_ID,
      email: "a@x",
      name: "A",
      externalId: DEFAULT_USER_ID,
      createdAt: new Date(),
    });
    const r = await requirePermission({ headers: new Headers() }, "skill.write");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      const body = await r.response.json();
      expect(body.ok).toBe(false);
    }
  });

  it("无 agent.read → 403（切片 B1 新权限守卫）", async () => {
    setStudioOpen("false");
    mocks.permsRaw.mockResolvedValue(["studio.access"]); // 无 agent.read
    mocks.getCurrentUserFromRequest.mockResolvedValue({
      id: DEFAULT_USER_ID,
      email: "a@x",
      name: "A",
      externalId: DEFAULT_USER_ID,
      createdAt: new Date(),
    });
    const r = await requirePermission({ headers: new Headers() }, "agent.read");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("AuthError → { ok:false, response 401 }", async () => {
    mocks.getCurrentUserFromRequest.mockRejectedValue(
      new AuthError("missing_identity", "AUTH: 缺少 SSO 用户标识"),
    );
    const r = await requirePermission({ headers: new Headers() }, "studio.access");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
});
