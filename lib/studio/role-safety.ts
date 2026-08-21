/**
 * 用户角色覆盖更新的防自锁判定（grant 化）。
 *
 * 关口02 02-2c：Settings PUT 用户 roles 在写入前必须通过 `assertRoleUpdateSafe`，避免：
 * 1. 当前操作者移除自身的 `user.manage` → 自己锁死在 Settings 门外（self_lockout）。
 * 2. 系统失去最后一个 `user.manage` 用户 → 无人能再进 Settings（last_manager）。
 *
 * 正式身份模型没有「角色表」：用户权限 = principalBinding 上的 roleActionBinding（grant）。
 * 本层把请求的角色模板（ADMIN/MEMBER）展开为 grant 签名集，再与正式绑定层
 * （lib/identity/settings-queries）比对，不碰 legacy role/rolePermission/userRole。
 */
import {
  grantSignature,
  grantsForTemplates,
  isRoleTemplateKey,
} from "@/lib/identity/role-templates";
import { listUsersWithActionBindings } from "@/lib/identity/settings-queries";

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

/** 签名集是否包含 user.manage 的 grant（所有 user.manage 绑定均为 tenant scope）。 */
function includesUserManage(grantSignatures: string[]): boolean {
  return grantSignatures.some((s) => s.startsWith("user.manage|"));
}

/**
 * 校验「覆盖目标用户角色模板集合为 nextTemplateKeys」是否安全。
 *
 * 规则：
 * 1. templateKeys 必须是非重复 string 数组，且全部是已知角色模板 → 否则 `invalid_roles`。
 * （允许空数组：表示无角色用户；由规则 2/3 兜底防止锁死。）
 * 2. 当前操作者修改自己时，变更后的 grant 并集必须仍含 `user.manage`
 * → 否则 `self_lockout`。
 * 3. 替换后系统必须至少保留 1 个持有 `user.manage` 的用户 → 否则 `last_manager`。
 */
export async function assertRoleUpdateSafe(
  tenantId: string,
  actorUserId: string,
  targetUserId: string,
  nextTemplateKeys: string[],
): Promise<void> {
  // 1. 模板 key 合法性
  if (!Array.isArray(nextTemplateKeys) || nextTemplateKeys.some((k) => typeof k !== "string")) {
    throw new RoleSafetyError("invalid_roles", "roleIds 必须是字符串数组");
  }
  const dedup = new Set(nextTemplateKeys);
  if (dedup.size !== nextTemplateKeys.length) {
    throw new RoleSafetyError("invalid_roles", "roleIds 存在重复");
  }
  for (const key of nextTemplateKeys) {
    if (!isRoleTemplateKey(key)) {
      throw new RoleSafetyError("invalid_roles", `角色模板不存在: ${key}`);
    }
  }

  // 把所选模板展开为并集 grant 签名（用户变更后的权限快照）。
  const nextSignatures = grantsForTemplates(nextTemplateKeys).map((g) =>
    grantSignature(g.actionCode, g.resourceScope),
  );

  // 2. 自锁：操作者改自己，变更后自身仍须保有 user.manage
  if (actorUserId === targetUserId) {
    if (!includesUserManage(nextSignatures)) {
      throw new RoleSafetyError("self_lockout", "不能移除自身的 user.manage 权限");
    }
  }

  // 3. 最后管理员：替换后全局仍须 ≥1 个 user.manage 用户
  const users = await listUsersWithActionBindings(tenantId);
  let managers = 0;
  for (const u of users) {
    const sigs = u.id === targetUserId ? nextSignatures : u.grantSignatures;
    if (includesUserManage(sigs)) managers += 1;
  }
  if (managers < 1) {
    throw new RoleSafetyError("last_manager", "系统必须至少保留 1 个 user.manage 用户");
  }
}
