import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stage A2：防自锁判定测试。
 * mock queries 层（listRolesWithPermissions / getPermissionsForRoleIds / countUsersWithPermission），
 * 断言 assertRoleUpdateSafe 的三类错误码与通过路径。
 */

const queries = vi.hoisted(() => ({
  listRolesWithPermissions: vi.fn(),
  getPermissionsForRoleIds: vi.fn(),
  countUsersWithPermission: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  listRolesWithPermissions: queries.listRolesWithPermissions,
  getPermissionsForRoleIds: queries.getPermissionsForRoleIds,
  countUsersWithPermission: queries.countUsersWithPermission,
}));

import { RoleSafetyError, assertRoleUpdateSafe } from "@/lib/studio/role-safety";

const ROLES = [
  { id: "r-admin", key: "admin", name: "Admin", isSystem: true, permissions: [] },
  { id: "r-member", key: "member", name: "Member", isSystem: true, permissions: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  queries.listRolesWithPermissions.mockResolvedValue(ROLES);
  queries.getPermissionsForRoleIds.mockResolvedValue([]);
  queries.countUsersWithPermission.mockResolvedValue(1);
});

describe("RoleSafetyError", () => {
  it("携带 code 与 message，且是 Error 子类", () => {
    const e = new RoleSafetyError("self_lockout", "x");
    expect(e.code).toBe("self_lockout");
    expect(e.message).toBe("x");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("assertRoleUpdateSafe — invalid_roles", () => {
  it("roleIds 含不存在的 id → invalid_roles", async () => {
    await expect(assertRoleUpdateSafe("u1", "u2", ["nope"])).rejects.toMatchObject({
      code: "invalid_roles",
    });
    expect(queries.countUsersWithPermission).not.toHaveBeenCalled();
  });

  it("roleIds 重复 → invalid_roles", async () => {
    await expect(assertRoleUpdateSafe("u1", "u2", ["r-admin", "r-admin"])).rejects.toMatchObject({
      code: "invalid_roles",
    });
  });

  it("roleIds 含非字符串 → invalid_roles", async () => {
    await expect(
      assertRoleUpdateSafe("u1", "u2", ["r-admin", 1 as unknown as string]),
    ).rejects.toMatchObject({ code: "invalid_roles" });
  });

  it("roleIds 非数组 → invalid_roles", async () => {
    await expect(
      assertRoleUpdateSafe("u1", "u2", "r-admin" as unknown as string[]),
    ).rejects.toMatchObject({ code: "invalid_roles" });
  });
});

describe("assertRoleUpdateSafe — self_lockout", () => {
  it("当前用户移除自身 user.manage → self_lockout", async () => {
    queries.getPermissionsForRoleIds.mockResolvedValue(["studio.access", "skill.read"]);
    await expect(assertRoleUpdateSafe("u1", "u1", ["r-member"])).rejects.toMatchObject({
      code: "self_lockout",
    });
    // 自锁应在最后管理员检查前短路
    expect(queries.countUsersWithPermission).not.toHaveBeenCalled();
  });

  it("当前用户移除自身 studio.access → self_lockout", async () => {
    queries.getPermissionsForRoleIds.mockResolvedValue(["user.manage"]);
    await expect(assertRoleUpdateSafe("u1", "u1", ["r-admin"])).rejects.toMatchObject({
      code: "self_lockout",
    });
  });

  it("当前用户清空自身角色 → self_lockout", async () => {
    queries.getPermissionsForRoleIds.mockResolvedValue([]);
    await expect(assertRoleUpdateSafe("u1", "u1", [])).rejects.toMatchObject({
      code: "self_lockout",
    });
  });

  it("当前用户保留两权限 → 通过自锁检查", async () => {
    queries.getPermissionsForRoleIds.mockResolvedValue(["studio.access", "user.manage"]);
    queries.countUsersWithPermission.mockResolvedValue(1);
    await expect(assertRoleUpdateSafe("u1", "u1", ["r-admin"])).resolves.toBeUndefined();
    expect(queries.countUsersWithPermission).toHaveBeenCalledWith("user.manage", {
      userId: "u1",
      roleIds: ["r-admin"],
    });
  });
});

describe("assertRoleUpdateSafe — last_manager", () => {
  it("更新别人但替换后系统 0 个 manager → last_manager", async () => {
    queries.countUsersWithPermission.mockResolvedValue(0);
    await expect(assertRoleUpdateSafe("u1", "u2", ["r-member"])).rejects.toMatchObject({
      code: "last_manager",
    });
    expect(queries.countUsersWithPermission).toHaveBeenCalledWith("user.manage", {
      userId: "u2",
      roleIds: ["r-member"],
    });
  });

  it("更新别人且系统仍有 manager → 通过", async () => {
    queries.countUsersWithPermission.mockResolvedValue(2);
    await expect(assertRoleUpdateSafe("u1", "u2", ["r-member"])).resolves.toBeUndefined();
  });

  it("允许把别人置为无角色,只要系统仍有 manager", async () => {
    queries.countUsersWithPermission.mockResolvedValue(1);
    await expect(assertRoleUpdateSafe("u1", "u2", [])).resolves.toBeUndefined();
  });
});
