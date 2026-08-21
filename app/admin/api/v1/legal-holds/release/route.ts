import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * POST /admin/api/v1/legal-holds/release — 解除 Legal Hold（S12-W06）。
 *
 * 事实源：docs/architecture/security.md §6
 *         （Legal Hold 解除：写审计，恢复原保留策略计算）。
 *
 * 行为：
 * - 解析 admin 主体（安全管理员）。
 * - 校验 action scope: legal_hold.manage + resource { type: "tenant", id: tenantId }。
 * - 必填字段：id / released_by / release_reason。
 * - 调用 releaseLegalHold：状态 holdState=released + 写审计（legal_hold.manage）。
 * - 解除后该目标恢复原保留策略计算。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少必填字段 → 400 REQUEST_SCHEMA_INVALID
 * - Hold 不存在 → 404 RESOURCE_NOT_FOUND
 * - Hold 已解除 → 409 BUSINESS_CONSTRAINT_VIOLATION
 */
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import { LegalHoldError, releaseLegalHold } from "@/lib/identity/legal-hold-queries";

export const dynamic = "force-dynamic";

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    released_by?: string;
    release_reason?: string;
  } | null;

  const id = body?.id?.trim();
  if (!id) {
    return schemaInvalidTable(requestId, "缺少必填字段 id");
  }

  const releasedBy = body?.released_by?.trim();
  if (!releasedBy) {
    return schemaInvalidTable(requestId, "缺少必填字段 released_by");
  }

  const releaseReason = body?.release_reason?.trim();
  if (!releaseReason) {
    return schemaInvalidTable(requestId, "缺少必填字段 release_reason");
  }

  // action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "legal_hold.manage",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  try {
    const released = await releaseLegalHold({
      tenantId: principal.tenantId,
      id,
      releasedBy,
      releaseReason,
      actor: actorFromAdminPrincipal(principal),
      requestId,
    });

    return apiSuccess(
      {
        id: released.id,
        target_type: released.targetType,
        target_id: released.targetId,
        hold_state: released.holdState,
        reason: released.reason,
        created_by: released.createdBy,
        approved_by: released.approvedBy,
        valid_until: released.validUntil.toISOString(),
        created_at: released.createdAt.toISOString(),
        released_at: released.releasedAt?.toISOString() ?? null,
        released_by: released.releasedBy ?? null,
        release_reason: released.releaseReason ?? null,
      },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof LegalHoldError && err.code === "hold_not_found") {
      return apiError("RESOURCE_NOT_FOUND", err.message, { requestId });
    }
    if (err instanceof LegalHoldError && err.code === "hold_already_released") {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    throw err;
  }
}
