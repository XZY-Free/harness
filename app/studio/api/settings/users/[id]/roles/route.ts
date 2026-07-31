import { getUserById, getUserRoleIds, replaceUserRolesWithAudit } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { logger } from "@/lib/logger";
import { requirePermission } from "@/lib/rbac";
import { recordAdminAudit, summarizeRoleChange } from "@/lib/studio/admin-audit";
import { RoleSafetyError, assertRoleUpdateSafe } from "@/lib/studio/role-safety";
import type { NextRequest } from "next/server";

/**
 * PUT /studio/api/settings/users/[id]/roles → 覆盖目标用户的角色集合。
 *
 * 守卫与校验顺序：
 * 1. requirePermission(user.manage) → 401/403（不审计）。
 * 2. body 必须是 { roleIds: string[] } → 否则 400 invalid_body（不审计）。
 * 3. getUserById → 404 user_not_found（不审计；目标不存在不算业务写意图）。
 * 4. assertRoleUpdateSafe（actor=target 用户 id 校验）：
 *    - invalid_roles → 400 + failed 审计 reasonCode
 *    - self_lockout → 409 + failed 审计 reasonCode
 *    - last_manager → 409 + failed 审计 reasonCode
 * 5. replaceUserRolesWithAudit：角色替换 + succeeded 审计同事务；
 *    审计写失败 → 整事务回滚 → 500 audit_failed（业务 mutation 不提交）。
 *
 * 审计（切片 C）：成功路径 succeeded 与业务失败路径 failed 都记录；
 * 401/403/invalid_body/user_not_found 不审计。失败路径审计 best-effort（不掩盖业务响应）。
 * 不创建/删除用户，不创建/删除角色，不编辑 RolePermission。
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePermission(req, "user.manage");
  if (!r.ok) return r.response;
  const actorUserId = r.user.id;
  const { id: targetUserId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }
  if (!isObject(body)) {
    return jsonError(400, "invalid_body", "roleIds 必须是字符串数组");
  }
  const { roleIds } = body;
  if (!Array.isArray(roleIds) || roleIds.some((x) => typeof x !== "string")) {
    return jsonError(400, "invalid_body", "roleIds 必须是字符串数组");
  }

  const target = await getUserById(targetUserId);
  if (!target) {
    return jsonError(404, "user_not_found", "目标用户不存在");
  }

  const roleIdsBefore = await getUserRoleIds(targetUserId);

  try {
    await assertRoleUpdateSafe(actorUserId, targetUserId, roleIds);
  } catch (error) {
    if (error instanceof RoleSafetyError) {
      // 业务失败审计：best-effort，不掩盖 RoleSafety 响应
      try {
        await recordAdminAudit({
          actorUserId,
          action: "settings.user_roles.updated",
          targetType: "user",
          targetId: targetUserId,
          outcome: "failed",
          metadata: {
            reasonCode: error.code,
            ...summarizeRoleChange(roleIdsBefore, roleIds),
            targetEmail: target.email,
          },
        });
      } catch (auditError) {
        logger.error("admin audit write failed (user_roles failed path)", {
          targetUserId,
          code: error.code,
          error: String(auditError),
        });
      }
      const status = error.code === "invalid_roles" ? 400 : 409;
      return jsonError(status, error.code, error.message);
    }
    throw error;
  }

  // 成功路径：角色替换 + succeeded 审计同事务；audit 失败 → 回滚 → 500 audit_failed
  try {
    await replaceUserRolesWithAudit(targetUserId, roleIds, {
      actorUserId,
      action: "settings.user_roles.updated",
      targetId: targetUserId,
      metadata: {
        ...summarizeRoleChange(roleIdsBefore, roleIds),
        targetEmail: target.email,
      },
    });
  } catch (error) {
    logger.error("admin audit write failed (user_roles success path)", {
      targetUserId,
      error: String(error),
    });
    return jsonError(500, "audit_failed", "审计写入失败");
  }
  return jsonOk({ userId: targetUserId, roleIds });
}
