import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getEffectRecordById } from "@/lib/capability/effect-queries";
/**
 * GET /admin/api/v1/effects/{effect_id} — EffectRecord 单资源详情（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 调用 getEffectRecordById（按 tenantId 过滤实现跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - EffectRecord 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ effect_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { effect_id: effectId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const effect = await getEffectRecordById(principal.tenantId, effectId);
  if (!effect) {
    return resourceNotFound(requestId, `EffectRecord 不存在或无权访问: ${effectId}`);
  }

  const body = {
    id: effect.id,
    tenant_id: effect.tenantId,
    tool_call_id: effect.toolCallId,
    effect_type: effect.effectType,
    target_summary_json: effect.targetSummaryJson,
    effect_state: effect.effectState,
    external_idempotency_key: effect.externalIdempotencyKey,
    external_result_ref: effect.externalResultRef,
    verification_method: effect.verificationMethod,
    verified_at: effect.verifiedAt?.toISOString() ?? null,
    evidence_json: effect.evidenceJson,
    version_no: effect.versionNo,
    created_at: effect.createdAt.toISOString(),
    updated_at: effect.updatedAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
