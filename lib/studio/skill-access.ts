import { jsonError } from "@/lib/http";
import type { Principal } from "@/lib/identity/resolver";
import { hasStudioAction } from "@/lib/identity/studio-access";

/**
 * skill owner 权限检查（共享版）。
 *
 * 审计修复()：从 skills/[id]/route.ts 提取为共享模块，
 * 供 files/versions/publish/rollback 等子路由统一使用。
 *
 * 非 admin(无 skill.write tenant 授权)只能改/删自己 ownerUserId 的 skill;
 * admin 可改所有。公共 skill(ownerUserId null)只有 admin 能改。
 *
 * @returns null=放行;Response=拒绝(403)
 */
export async function assertSkillWriteAccess(
  sk: { id: string; ownerUserId: string | null },
  principal: Principal,
): Promise<Response | null> {
  const isSkillAdmin = await hasStudioAction(principal, "skill.write");
  if (isSkillAdmin) return null;
  if (sk.ownerUserId === principal.userIdentityId) return null;
  return jsonError(403, "not_owner", "非 skill 所有者,无权修改");
}
