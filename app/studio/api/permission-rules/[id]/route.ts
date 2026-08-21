import { deletePermissionRule, updatePermissionRule } from "@/lib/db/queries";
import { jsonError, jsonOk } from "@/lib/http";
import { requireStudioAction } from "@/lib/identity/studio-access";
import {
  PermissionRuleValidationError,
  validateUpdateInput,
} from "@/lib/studio/permission-rule-validation";
import type { NextRequest } from "next/server";

/**
 * S1（07-P2-5）：单条 permission rule 管理(PATCH 更新 / DELETE 删除)。
 *
 * 调现有 updatePermissionRule/deletePermissionRule(同事务落审计),传 actorUserId 触发审计。
 * 规则不存在 → 函数返回 null/false,本路由据此 404。
 */

/** PATCH /studio/api/permission-rules/[id] → 更新规则(全字段可选)。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  let patch: ReturnType<typeof validateUpdateInput> | undefined;
  try {
    patch = validateUpdateInput(body);
  } catch (error) {
    if (error instanceof PermissionRuleValidationError) {
      return jsonError(400, error.code, error.message);
    }
    throw error;
  }
  if (Object.keys(patch).length === 0) {
    return jsonError(400, "empty_patch", "无待更新字段");
  }

  const rule = await updatePermissionRule(id, patch, actorUserId);
  if (!rule) return jsonError(404, "rule_not_found", "权限规则不存在");
  return jsonOk({ rule });
}

/** DELETE /studio/api/permission-rules/[id] → 删除规则(二次确认 + 审计)。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requireStudioAction(req, "policy.write");
  if (!r.ok) return r.response;
  const actorUserId = r.principal.userIdentityId;
  const { id } = await params;

  // 二次确认:破坏性操作防误触(对齐 07-P2-7 模式)
  const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };
  if (body.confirm !== true) {
    return jsonError(400, "confirm_required", "删除规则需传 confirm: true 二次确认");
  }

  const deleted = await deletePermissionRule(id, actorUserId);
  if (!deleted) return jsonError(404, "rule_not_found", "权限规则不存在");
  return jsonOk({ id, deleted: true });
}
