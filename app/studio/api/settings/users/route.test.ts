import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stage B1：Settings API 守卫与覆盖语义测试。
 * mock rbac(requirePermission) + queries + role-safety，断言：
 * - 无 user.manage → 403。
 * - GET 成功返回 users/roles。
 * - PUT 成功覆盖角色。
 * - PUT 自锁/最后管理员 → 409 且不调用 replaceUserRoles。
 * - PUT 非法 roleIds / 非法 body → 400。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUserRoleIds: vi.fn(),
  listUsersWithRoles: vi.fn(),
  listRolesWithPermissions: vi.fn(),
  replaceUserRolesWithAudit: vi.fn(),
}));
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
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/rbac", () => ({ requirePermission: rbac.requirePermission }));
vi.mock("@/lib/db/queries", () => ({
  getUserById: queries.getUserById,
  getUserRoleIds: queries.getUserRoleIds,
  listUsersWithRoles: queries.listUsersWithRoles,
  listRolesWithPermissions: queries.listRolesWithPermissions,
  replaceUserRolesWithAudit: queries.replaceUserRolesWithAudit,
}));
vi.mock("@/lib/studio/role-safety", () => ({
  RoleSafetyError: safety.RoleSafetyError,
  assertRoleUpdateSafe: safety.assertRoleUpdateSafe,
}));
vi.mock("@/lib/studio/admin-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio/admin-audit")>();
  return { ...actual, recordAdminAudit: audit.recordAdminAudit };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PUT } from "@/app/studio/api/settings/users/[id]/roles/route";
import { GET } from "@/app/studio/api/settings/users/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  queries.getUserById.mockResolvedValue({ ...USER, id: "u2", email: "u2@x" });
  queries.getUserRoleIds.mockResolvedValue(["r-member"]);
  safety.assertRoleUpdateSafe.mockResolvedValue(undefined);
  queries.replaceUserRolesWithAudit.mockResolvedValue(undefined);
  audit.recordAdminAudit.mockResolvedValue(undefined);
});

describe("GET /studio/api/settings/users (切片 B3)", () => {
  it("user.manage 通过 → 200 + users/roles", async () => {
    queries.listUsersWithRoles.mockResolvedValue([
      { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date(), roles: [] },
    ]);
    queries.listRolesWithPermissions.mockResolvedValue([
      { id: "r-admin", key: "admin", name: "Admin", isSystem: true, permissions: ["user.manage"] },
    ]);
    const res = await GET(req("http://localhost/studio/api/settings/users"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.users).toHaveLength(1);
    expect(body.data.roles[0].key).toBe("admin");
    expect(rbac.requirePermission).toHaveBeenCalledWith(expect.anything(), "user.manage");
  });

  it("无 user.manage → 403，不查 DB", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/settings/users"));
    expect(res.status).toBe(403);
    expect(queries.listUsersWithRoles).not.toHaveBeenCalled();
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

  it("通过 → 200 + 覆盖写入 + succeeded 审计含 before/after roleIds", async () => {
    const res = await PUT(put("u2", { roleIds: ["r-admin"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ userId: "u2", roleIds: ["r-admin"] });
    expect(safety.assertRoleUpdateSafe).toHaveBeenCalledWith("u1", "u2", ["r-admin"]);
    expect(queries.replaceUserRolesWithAudit).toHaveBeenCalledTimes(1);
    const call = queries.replaceUserRolesWithAudit.mock.calls[0];
    expect(call?.[0]).toBe("u2");
    expect(call?.[1]).toEqual(["r-admin"]);
    const auditArg = call?.[2] as { actorUserId: string; metadata: Record<string, unknown> };
    expect(auditArg.actorUserId).toBe("u1");
    expect(auditArg.metadata).toMatchObject({
      roleIdsBefore: ["r-member"],
      roleIdsAfter: ["r-admin"],
      targetEmail: "u2@x",
    });
  });

  it("无 user.manage → 403，不校验不写入不审计", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await PUT(put("u2", { roleIds: ["r-admin"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(403);
    expect(safety.assertRoleUpdateSafe).not.toHaveBeenCalled();
    expect(queries.replaceUserRolesWithAudit).not.toHaveBeenCalled();
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
    expect(queries.getUserById).not.toHaveBeenCalled();
    expect(safety.assertRoleUpdateSafe).not.toHaveBeenCalled();
    expect(queries.replaceUserRolesWithAudit).not.toHaveBeenCalled();
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
    queries.getUserById.mockResolvedValue(null);
    const res = await PUT(put("missing-user", { roleIds: [] }), {
      params: Promise.resolve({ id: "missing-user" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("user_not_found");
    expect(safety.assertRoleUpdateSafe).not.toHaveBeenCalled();
    expect(queries.replaceUserRolesWithAudit).not.toHaveBeenCalled();
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
    expect(queries.replaceUserRolesWithAudit).not.toHaveBeenCalled();
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
    expect(queries.replaceUserRolesWithAudit).not.toHaveBeenCalled();
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
    expect(queries.replaceUserRolesWithAudit).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reasonCode: "last_manager" }),
      }),
    );
  });

  it("审计写入失败（事务回滚）→ 500 audit_failed", async () => {
    queries.replaceUserRolesWithAudit.mockRejectedValue(new Error("audit write failed"));
    const res = await PUT(put("u2", { roleIds: ["r-admin"] }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("audit_failed");
  });
});
