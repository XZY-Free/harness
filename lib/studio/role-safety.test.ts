import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 02-2c：防自锁判定测试（grant 化）。
 * mock settings-queries 层（listUsersWithActionBindings），
 * 断言 assertRoleUpdateSafe(tenantId, actor, target, nextTemplateKeys) 的三类错误码与通过路径。
 * 不再依赖 legacy lib/db/queries 的角色/权限表。
 */

const settingsQueries = vi.hoisted(() => ({
  listUsersWithActionBindings: vi.fn(),
}));

vi.mock("@/lib/identity/settings-queries", () => ({
  listUsersWithActionBindings: settingsQueries.listUsersWithActionBindings,
}));

import { RoleSafetyError, assertRoleUpdateSafe } from "@/lib/studio/role-safety";

const TENANT = "t1";

const MANAGER = {
  id: "u1",
  email: "u1@x.com",
  displayName: "U1",
  externalSubject: "u1",
  grantSignatures: ["user.manage|tenant"],
};

const NON_MANAGER = {
  id: "u2",
  email: "u2@x.com",
  displayName: "U2",
  externalSubject: "u2",
  grantSignatures: ["skill.read|tenant"],
};

beforeEach(() => {
  vi.clearAllMocks();
  settingsQueries.listUsersWithActionBindings.mockResolvedValue([MANAGER, NON_MANAGER]);
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
  it("nextTemplateKeys 非数组 → invalid_roles", async () => {
    await expect(
      assertRoleUpdateSafe(TENANT, "u1", "u2", "admin" as unknown as string[]),
    ).rejects.toMatchObject({ code: "invalid_roles" });
    expect(settingsQueries.listUsersWithActionBindings).not.toHaveBeenCalled();
  });

  it("含非字符串元素 → invalid_roles", async () => {
    await expect(
      assertRoleUpdateSafe(TENANT, "u1", "u2", ["admin", 1 as unknown as string]),
    ).rejects.toMatchObject({ code: "invalid_roles" });
  });

  it("重复模板 key → invalid_roles", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u2", ["admin", "admin"])).rejects.toMatchObject({
      code: "invalid_roles",
    });
  });

  it("未知模板 key → invalid_roles", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u2", ["nope"])).rejects.toMatchObject({
      code: "invalid_roles",
    });
    expect(settingsQueries.listUsersWithActionBindings).not.toHaveBeenCalled();
  });
});

describe("assertRoleUpdateSafe — self_lockout", () => {
  it("当前用户把自身降为 member（无 user.manage）→ self_lockout", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u1", ["member"])).rejects.toMatchObject({
      code: "self_lockout",
    });
    // 自锁应在最后管理员检查前短路
    expect(settingsQueries.listUsersWithActionBindings).not.toHaveBeenCalled();
  });

  it("当前用户清空自身角色 → self_lockout", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u1", [])).rejects.toMatchObject({
      code: "self_lockout",
    });
    expect(settingsQueries.listUsersWithActionBindings).not.toHaveBeenCalled();
  });

  it("当前用户保留自身 admin（含 user.manage）→ 通过自锁检查", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u1", ["admin"])).resolves.toBeUndefined();
    expect(settingsQueries.listUsersWithActionBindings).toHaveBeenCalledWith(TENANT);
  });
});

describe("assertRoleUpdateSafe — last_manager", () => {
  it("操作者把唯一 manager 降为 member → 系统 0 个 user.manage → last_manager", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u2", "u1", ["member"])).rejects.toMatchObject({
      code: "last_manager",
    });
    expect(settingsQueries.listUsersWithActionBindings).toHaveBeenCalledWith(TENANT);
  });

  it("更新别人且系统仍有 manager → 通过", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u2", ["member"])).resolves.toBeUndefined();
  });

  it("允许把别人置为无角色,只要系统仍有 manager", async () => {
    await expect(assertRoleUpdateSafe(TENANT, "u1", "u2", [])).resolves.toBeUndefined();
  });
});
