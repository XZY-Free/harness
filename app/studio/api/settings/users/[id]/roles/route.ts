import { jsonError, jsonOk } from "@/lib/http";
import { grantsForTemplates } from "@/lib/identity/role-templates";
import {
  deriveTemplateKeys,
  listUsersWithActionBindings,
  replaceUserGrantsWithAudit,
} from "@/lib/identity/settings-queries";
import { requireStudioAction } from "@/lib/identity/studio-access";
import { getUserIdentityForTenant } from "@/lib/identity/user-identity-queries";
import { logger } from "@/lib/logger";
import { recordAdminAudit, summarizeRoleChange } from "@/lib/studio/admin-audit";
import { RoleSafetyError, assertRoleUpdateSafe } from "@/lib/studio/role-safety";
import type { NextRequest } from "next/server";

/**
 * PUT /studio/api/settings/users/[id]/roles → 覆盖目标用户的角色模板（物化为 grant）。
 *
 * 关口02 02-2c：从 legacy replaceUserRolesWithAudit（role/rolePermission/userRole）迁到
 * 正式身份模型。roleIds 现为「角色模板 key」（admin/member），服务端把所选模板的 grant
 * 并集物化为 roleActionBinding（覆盖式：撤销现有有效绑定 + 按模板授予）。
 *
 * 守卫与校验顺序：
 * 1. requireStudioAction(user.manage) → 401/403（不审计）。
 * 2. body 必须是 { roleIds: string[] } → 否则 400 invalid_body（不审计）。
 * 3. getUserIdentityForTenant → 404 user_not_found（不审计；目标不存在不算业务写意图）。
 * 4. assertRoleUpdateSafe（tenantId + actor=target id 校验）：
 *    - invalid_roles → 400 + failed 审计 reasonCode
 *    - self_lockout → 409 + failed 审计 reasonCode
 *    - last_manager → 409 + failed 审计 reasonCode
 * 5. replaceUserGrantsWithAudit：grant 覆盖 + succeeded 审计同事务；
 *    审计写失败 → 整事务回滚 → 500 audit_failed（业务 mutation 不提交）。
 *
 * 审计（切片 C）：成功路径 succeeded 与业务失败路径 failed 都记录；
 * 401/403/invalid_body/user_not_found 不审计。失败路径审计 best-effort（不掩盖业务响应）。
 * 不创建/删除用户，不创建/删除角色模板，不编辑 RoleActionBinding 之外的权限。
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "user.manage");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;
  const tenantId = r.principal.tenantId;
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

  const target = await getUserIdentityForTenant(targetUserId, tenantId);
  if (!target) {
    return jsonError(404, "user_not_found", "目标用户不存在");
  }

  // 目标用户当前的模板 key（审计 roleIdsBefore / 覆盖语义用）。
  const allUsers = await listUsersWithActionBindings(tenantId);
  const targetRow = allUsers.find((u) => u.id === targetUserId);
  const templateKeysBefore = targetRow ? deriveTemplateKeys(targetRow) : [];

  try {
    await assertRoleUpdateSafe(tenantId, actorUserId, targetUserId, roleIds);
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
            ...summarizeRoleChange(templateKeysBefore, roleIds),
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

  // 成功路径：grant 覆盖 + succeeded 审计同事务；audit 失败 → 回滚 → 500 audit_failed
  const grants = grantsForTemplates(roleIds);
  try {
    await replaceUserGrantsWithAudit(tenantId, targetUserId, grants, {
      actorUserId,
      action: "settings.user_roles.updated",
      targetId: targetUserId,
      metadata: {
        ...summarizeRoleChange(templateKeysBefore, roleIds),
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
