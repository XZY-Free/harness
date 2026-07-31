/**
 * S13-W03 旧 RBAC permission → V11 actionCode 映射。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/13-migration-mapping-baseline.md §identity
 * - lib/rbac.ts PERMISSIONS（旧权限目录）
 * - lib/v11/identity/action-codes.ts ACTION_CODES（V11 稳定动作目录）
 *
 * 旧 permission 是"功能访问权限"（粗粒度），V11 actionCode 是"管理操作动作"（细粒度）。
 * 只有语义可证明对应的旧 permission 才映射；无法映射的入异常队列（不猜测）。
 */

/** 旧 permission → V11 actionCode 映射表（一对多）。 */
const PERMISSION_TO_ACTION_CODES: ReadonlyMap<string, readonly string[]> = new Map([
  // Skill 域：写权限拆分为创建+更新
  ["skill.write", ["skill.create", "skill.update"]],
  ["skill.write.all", ["skill.create", "skill.update"]],
  ["skill.publish", ["skill.publish"]],
  // Policy 域：写权限映射为发布
  ["policy.write", ["policy.publish"]],
  // Audit 域：读取映射为导出读取
  ["audit.read", ["admin.export.read"]],
]);

/** 旧 permission → V11 actionCode 列表；无对应返回 null。 */
export function mapPermissionToActionCodes(permission: string): readonly string[] | null {
  return PERMISSION_TO_ACTION_CODES.get(permission) ?? null;
}

/** 判断旧 permission 是否有对应的 V11 actionCode。 */
export function isPermissionMappable(permission: string): boolean {
  return PERMISSION_TO_ACTION_CODES.has(permission);
}

/** 返回所有可映射的旧 permission 列表。 */
export function getMappablePermissions(): readonly string[] {
  return [...PERMISSION_TO_ACTION_CODES.keys()];
}
