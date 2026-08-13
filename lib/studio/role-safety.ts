/**
 * 用户角色覆盖更新的防自锁判定。
 *
 * Settings PUT 用户 roles 在写入前必须通过 `assertRoleUpdateSafe`，避免：
 * 1. 当前用户移除自身的 `studio.access` / `user.manage` → 自己锁死在 Settings 门外。
 * 2. 系统失去最后一个 `user.manage` 用户 → 无人能再进 Settings。
 *
 * 设计为薄判定层：依赖 `lib/db/queries` 的纯数据查询，不做权限常量过滤（角色权限
 * 由 RolePermission 表决定；本层只关心两个关键权限字符串是否在并集中）。
 */
import {
  countUsersWithPermission,
  getPermissionsForRoleIds,
  listRolesWithPermissions,
} from "@/lib/db/queries";

export type RoleSafetyErrorCode = "invalid_roles" | "self_lockout" | "last_manager";

/** 防自锁失败。route 层据 code 映射 400/409。 */
export class RoleSafetyError extends Error {
  readonly code: RoleSafetyErrorCode;
  constructor(code: RoleSafetyErrorCode, message: string) {
    super(message);
    this.name = "RoleSafetyError";
    this.code = code;
  }
}

/**
 * 校验「覆盖目标用户角色集合为 nextRoleIds」是否安全。
 *
 * 规则：
 * 1. roleIds 必须是非重复 string 数组，且全部存在于 Role 表 → 否则 `invalid_roles`。
 * （允许空数组：表示无角色用户；由规则 2/3 兜底防止锁死。）
 * 2. 当前操作者修改自己时，变更后权限并集必须仍含 `studio.access` 与 `user.manage`
 * → 否则 `self_lockout`。
 * 3. 替换后系统必须至少保留 1 个 `user.manage` 用户 → 否则 `last_manager`。
 */
export async function assertRoleUpdateSafe(
  actorUserId: string,
  targetUserId: string,
  nextRoleIds: string[],
): Promise<void> {
  // 1. roleIds 合法性
  if (!Array.isArray(nextRoleIds) || nextRoleIds.some((r) => typeof r !== "string")) {
    throw new RoleSafetyError("invalid_roles", "roleIds 必须是字符串数组");
  }
  const dedup = new Set(nextRoleIds);
  if (dedup.size !== nextRoleIds.length) {
    throw new RoleSafetyError("invalid_roles", "roleIds 存在重复");
  }
  const roles = await listRolesWithPermissions();
  const validIds = new Set(roles.map((r) => r.id));
  for (const rid of nextRoleIds) {
    if (!validIds.has(rid)) {
      throw new RoleSafetyError("invalid_roles", `角色不存在: ${rid}`);
    }
  }

  // 2. 自锁：操作者改自己
  if (actorUserId === targetUserId) {
    const perms = new Set(await getPermissionsForRoleIds(nextRoleIds));
    if (!perms.has("studio.access") || !perms.has("user.manage")) {
      throw new RoleSafetyError("self_lockout", "不能移除自身的 studio.access 或 user.manage 权限");
    }
  }

  // 3. 最后管理员：替换后全局仍需 ≥1 个 user.manage 用户
  const managers = await countUsersWithPermission("user.manage", {
    userId: targetUserId,
    roleIds: nextRoleIds,
  });
  if (managers < 1) {
    throw new RoleSafetyError("last_manager", "系统必须至少保留 1 个 user.manage 用户");
  }
}
