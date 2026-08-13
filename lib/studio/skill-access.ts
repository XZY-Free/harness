import { jsonError } from "@/lib/http";
import { hasPermission } from "@/lib/rbac";

/**
 * skill owner 权限检查（共享版）。
 *
 * 审计修复()：从 skills/[id]/route.ts 提取为共享模块，
 * 供 files/versions/publish/rollback 等子路由统一使用。
 *
 * 非 admin(无 skill.write.all)只能改/删自己 ownerUserId 的 skill;
 * admin(skill.write.all)可改所有。公共 skill(ownerUserId null)只有 admin 能改。
 *
 * @returns null=放行;Response=拒绝(403)
 */
export async function assertSkillWriteAccess(
  sk: { id: string; ownerUserId: string | null },
  actorUserId: string,
): Promise<Response | null> {
  const isSkillAdmin = await hasPermission(actorUserId, "skill.write.all");
  if (isSkillAdmin) return null;
  if (sk.ownerUserId === actorUserId) return null;
  return jsonError(403, "not_owner", "非 skill 所有者,无权修改");
}
