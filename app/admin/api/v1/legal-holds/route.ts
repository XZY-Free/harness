/**
 * POST/GET /admin/api/v1/legal-holds — Legal Hold 管理（S12-W06）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §6
 *         （Legal Hold 明确对象范围、原因、创建人、批准人、有效期和解除审计）。
 *
 * 行为：
 * - POST：创建 Legal Hold（active 状态，需双人审批）。
 * - GET：列出 Legal Hold（cursor 分页，支持 target_type / hold_state 过滤）。
 * - action scope: legal_hold.manage + resource { type: "tenant", id: tenantId }。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少必填字段 → 400 REQUEST_SCHEMA_INVALID
 * - Hold 已存在 → 409 BUSINESS_CONSTRAINT_VIOLATION
 * - 有效期已过 → 400 REQUEST_SCHEMA_INVALID
 * - 双人审批不满足 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, apiError, apiSuccess, getRequestId } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import { LegalHoldError, createLegalHold, listLegalHolds } from "@/lib/identity/legal-hold-queries";
import {
  LEGAL_HOLD_TARGET_TYPES,
  type LegalHoldTargetType,
} from "@/lib/persistence/schema/retention-policy";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";

export const dynamic = "force-dynamic";

const VALID_TARGET_TYPES = new Set<string>(LEGAL_HOLD_TARGET_TYPES);

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
    target_type?: string;
    target_id?: string;
    reason?: string;
    approved_by?: string;
    valid_until?: string;
  } | null;

  const targetType = body?.target_type?.trim();
  if (!targetType || !VALID_TARGET_TYPES.has(targetType)) {
    return schemaInvalidTable(
      requestId,
      "缺少或非法 target_type（期望 tenant/thread/invocation/job/artifact/agent_revision）",
    );
  }

  const targetId = body?.target_id?.trim();
  if (!targetId) {
    return schemaInvalidTable(requestId, "缺少必填字段 target_id");
  }

  const reason = body?.reason?.trim();
  if (!reason) {
    return schemaInvalidTable(requestId, "缺少必填字段 reason");
  }

  const approvedBy = body?.approved_by?.trim();
  if (!approvedBy) {
    return schemaInvalidTable(requestId, "缺少必填字段 approved_by（需双人审批）");
  }

  const validUntilStr = body?.valid_until?.trim();
  if (!validUntilStr) {
    return schemaInvalidTable(requestId, "缺少必填字段 valid_until");
  }
  const validUntil = new Date(validUntilStr);
  if (Number.isNaN(validUntil.getTime())) {
    return schemaInvalidTable(requestId, "valid_until 非合法 RFC 3339 时间");
  }

  const createdBy =
    "userIdentityId" in principal ? principal.userIdentityId : (principal.serviceId ?? "unknown");

  // action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "legal_hold.manage",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  try {
    const hold = await createLegalHold({
      tenantId: principal.tenantId,
      targetType: targetType as LegalHoldTargetType,
      targetId,
      reason,
      createdBy,
      approvedBy,
      validUntil,
      actor: actorFromAdminPrincipal(principal),
      requestId,
    });

    return apiSuccess(
      {
        id: hold.id,
        target_type: hold.targetType,
        target_id: hold.targetId,
        hold_state: hold.holdState,
        reason: hold.reason,
        created_by: hold.createdBy,
        approved_by: hold.approvedBy,
        valid_until: hold.validUntil.toISOString(),
        created_at: hold.createdAt.toISOString(),
      },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof LegalHoldError && err.code === "hold_already_exists") {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (
      err instanceof LegalHoldError &&
      (err.code === "hold_expired" || err.code === "invalid_target")
    ) {
      return schemaInvalidTable(requestId, err.message);
    }
    throw err;
  }
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const url = new URL(request.url);
  const targetTypeParam = url.searchParams.get("target_type") ?? undefined;
  const targetId = url.searchParams.get("target_id") ?? undefined;
  const holdStateParam = url.searchParams.get("hold_state") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  if (targetTypeParam && !VALID_TARGET_TYPES.has(targetTypeParam)) {
    return schemaInvalidTable(requestId, "非法 target_type 查询参数");
  }
  if (holdStateParam && holdStateParam !== "active" && holdStateParam !== "released") {
    return schemaInvalidTable(requestId, "非法 hold_state 查询参数");
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return schemaInvalidTable(requestId, "非法 limit 查询参数");
  }

  // action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "legal_hold.manage",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const page = await listLegalHolds({
    tenantId: principal.tenantId,
    targetType: targetTypeParam as LegalHoldTargetType | undefined,
    targetId,
    holdState: holdStateParam as "active" | "released" | undefined,
    limit,
    cursor,
  });

  return apiSuccess(
    {
      items: page.items.map((h) => ({
        id: h.id,
        target_type: h.targetType,
        target_id: h.targetId,
        hold_state: h.holdState,
        reason: h.reason,
        created_by: h.createdBy,
        approved_by: h.approvedBy,
        valid_until: h.validUntil.toISOString(),
        created_at: h.createdAt.toISOString(),
        released_at: h.releasedAt?.toISOString() ?? null,
        released_by: h.releasedBy ?? null,
        release_reason: h.releaseReason ?? null,
      })),
      next_cursor: page.nextCursor,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
