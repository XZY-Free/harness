import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stage B1：Settings API 守卫与覆盖语义测试（grant 化，关口02 02-2c）。
 * mock 正式授权层(requireStudioAction) + settings-queries + role-templates + role-safety，
 * 断言：
 * - 无 user.manage → 403。
 * - GET 成功返回 users/roles（新 SettingsUserRolesView 形状）。
 * - PUT 成功覆盖 grant（roleIds 模板 key）+ succeeded 审计含 before/after roleIds。
 * - PUT 自锁/最后管理员 → 409 且不调用 replaceUserGrantsWithAudit。
 * - PUT 非法 roleIds / 非法 body → 400。
 */

const access = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const settings = vi.hoisted(() => ({
  listSettingsUserRolesView: vi.fn(),
  listUsersWithActionBindings: vi.fn(),
  replaceUserGrantsWithAudit: vi.fn(),
  deriveTemplateKeys: vi.fn(),
}));
const identity = vi.hoisted(() => ({ getUserIdentityForTenant: vi.fn() }));
const templates = vi.hoisted(() => ({ grantsForTemplates: vi.fn() }));
const safety = vi.hoisted(() => {
  class FakeRoleSafetyError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { RoleSafetyError: FakeRoleSafetyError, assertRoleUpdateSafe: vi.fn() };
});
const audit = vi.hoisted(() => ({
  recordAdminAudit: vi.fn(),
  summarizeRoleChange: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: access.requireStudioAction,
  hasStudioAction: access.hasStudioAction,
  resolveStudioPrincipal: access.resolveStudioPrincipal,
}));
vi.mock("@/lib/identity/settings-queries", () => ({
  listSettingsUserRolesView: settings.listSettingsUserRolesView,
  listUsersWithActionBindings: settings.listUsersWithActionBindings,
  replaceUserGrantsWithAudit: settings.replaceUserGrantsWithAudit,
  deriveTemplateKeys: settings.deriveTemplateKeys,
}));
vi.mock("@/lib/identity/user-identity-queries", () => ({
  getUserIdentityForTenant: identity.getUserIdentityForTenant,
}));
vi.mock("@/lib/identity/role-templates", () => ({
  grantsForTemplates: templates.grantsForTemplates,
}));
vi.mock("@/lib/studio/role-safety", () => ({
  RoleSafetyError: safety.RoleSafetyError,
  assertRoleUpdateSafe: safety.assertRoleUpdateSafe,
}));
vi.mock("@/lib/studio/admin-audit", () => ({
  recordAdminAudit: audit.recordAdminAudit,
  summarizeRoleChange: audit.summarizeRoleChange,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PUT } from "@/app/studio/api/settings/users/[id]/roles/route";
import { GET } from "@/app/studio/api/settings/users/route";
import { NextRequest } from "next/server";

const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
} as const;

/** 目标用户（u2）：路由只读 email 与存在性。 */
const TARGET_USER = { id: "u2", email: "u2@x" };

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  access.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  identity.getUserIdentityForTenant.mockResolvedValue(TARGET_USER);
  settings.listUsersWithActionBindings.mockResolvedValue([
    { id: "u2", email: "u2@x", displayName: null, externalSubject: "u2", grantSignatures: [] },
  ]);
  settings.deriveTemplateKeys.mockReturnValue(["r-member"]);
  templates.grantsForTemplates.mockReturnValue([]);
  safety.assertRoleUpdateSafe.mockResolvedValue(undefined);
  settings.replaceUserGrantsWithAudit.mockResolvedValue(undefined);
  audit.recordAdminAudit.mockResolvedValue(undefined);
  audit.summarizeRoleChange.mockImplementation((before, after) => ({
    roleIdsBefore: before,
    roleIdsAfter: after,
  }));
});

describe("GET /studio/api/settings/users (切片 B3)", () => {
  it("user.manage 通过 → 200 + users/roles（新 view 形状）", async () => {
    settings.listSettingsUserRolesView.mockResolvedValue({
      users: [
        {
          id: "u1",
          email: "a@x",
          displayName: "A",
          externalSubject: "u1",
          templateKeys: ["admin"],
        },
      ],
      roles: [{ key: "admin", name: "Admin", isSystem: true, actions: ["user.manage"] }],
    });
    const res = await GET(req("http://localhost/studio/api/settings/users"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.users).toHaveLength(1);
    expect(body.data.roles[0].key).toBe("admin");
    expect(access.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "user.manage");
  });

  it("无 user.manage → 403，不查 DB", async () => {
    access.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/settings/users"));
    expect(res.status).toBe(403);
    expect(settings.listSettingsUserRolesView).not.toHaveBeenCalled();
  });
});

describe("PUT /studio/api/settings/users/[id]/roles (切片 B3)", () => {
  function put(id: string, body: unknown) {
    return req(`http://localhost/studio/api/settings/users/${id}/roles`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("通过 → 200 + 覆盖 grant + succeeded 审计含 before/after roleIds", async () => {
    const res = await PUT(put("u2", { roleIds: ["r-admin"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ userId: "u2", roleIds: ["r-admin"] });
    expect(safety.assertRoleUpdateSafe).toHaveBeenCalledWith("t1", "u1", "u2", ["r-admin"]);
    expect(settings.replaceUserGrantsWithAudit).toHaveBeenCalledTimes(1);
    const call = settings.replaceUserGrantsWithAudit.mock.calls[0];
    expect(call?.[0]).toBe("t1");
    expect(call?.[1]).toBe("u2");
    const auditArg = call?.[3] as { actorUserId: string; metadata: Record<string, unknown> };
    expect(auditArg.actorUserId).toBe("u1");
    expect(auditArg.metadata).toMatchObject({
      roleIdsBefore: ["r-member"],
      roleIdsAfter: ["r-admin"],
      targetEmail: "u2@x",
    });
  });

  it("无 user.manage → 403，不校验不写入不审计", async () => {
    access.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await PUT(put("u2", { roleIds: ["r-admin"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(403);
    expect(safety.assertRoleUpdateSafe).not.toHaveBeenCalled();
    expect(settings.replaceUserGrantsWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("非法 JSON body → 400 invalid_body", async () => {
    const r = req("http://localhost/studio/api/settings/users/u2/roles", {
      method: "PUT",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const res = await PUT(r, { params: Promise.resolve({ id: "u2" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  it("roleIds 非数组 → 400 invalid_body", async () => {
    const res = await PUT(put("u2", { roleIds: "r-admin" }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  it("body 为 null → 400 invalid_body，不触发查询/写入/审计", async () => {
    const res = await PUT(put("u2", null), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
    expect(identity.getUserIdentityForTenant).not.toHaveBeenCalled();
    expect(safety.assertRoleUpdateSafe).not.toHaveBeenCalled();
    expect(settings.replaceUserGrantsWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("roleIds 含非字符串 → 400 invalid_body", async () => {
    const res = await PUT(put("u2", { roleIds: ["r-admin", 1] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  it("目标用户不存在 → 404 user_not_found，不校验不写入不审计", async () => {
    identity.getUserIdentityForTenant.mockResolvedValue(null);
    const res = await PUT(put("missing-user", { roleIds: [] }), {
      params: Promise.resolve({ id: "missing-user" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("user_not_found");
    expect(safety.assertRoleUpdateSafe).not.toHaveBeenCalled();
    expect(settings.replaceUserGrantsWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("invalid_roles → 400 且不写入，写 failed 审计含 reasonCode", async () => {
    safety.assertRoleUpdateSafe.mockRejectedValue(
      new safety.RoleSafetyError("invalid_roles", "角色不存在"),
    );
    const res = await PUT(put("u2", { roleIds: ["nope"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_roles");
    expect(settings.replaceUserGrantsWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.user_roles.updated",
        outcome: "failed",
        targetId: "u2",
        metadata: expect.objectContaining({ reasonCode: "invalid_roles" }),
      }),
    );
  });

  it("self_lockout → 409 且不写入，写 failed 审计", async () => {
    safety.assertRoleUpdateSafe.mockRejectedValue(
      new safety.RoleSafetyError("self_lockout", "自锁"),
    );
    const res = await PUT(put("u1", { roleIds: ["r-member"] }), {
      params: Promise.resolve({ id: "u1" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("self_lockout");
    expect(settings.replaceUserGrantsWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        metadata: expect.objectContaining({ reasonCode: "self_lockout" }),
      }),
    );
  });

  it("last_manager → 409 且不写入，写 failed 审计", async () => {
    safety.assertRoleUpdateSafe.mockRejectedValue(
      new safety.RoleSafetyError("last_manager", "最后管理员"),
    );
    const res = await PUT(put("u2", { roleIds: ["r-member"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("last_manager");
    expect(settings.replaceUserGrantsWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reasonCode: "last_manager" }),
      }),
    );
  });

  it("审计写入失败（事务回滚）→ 500 audit_failed", async () => {
    settings.replaceUserGrantsWithAudit.mockRejectedValue(new Error("audit write failed"));
    const res = await PUT(put("u2", { roleIds: ["r-admin"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("audit_failed");
  });
});
