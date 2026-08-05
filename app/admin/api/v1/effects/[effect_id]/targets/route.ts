import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getEffectRecordById, listEffectTargets } from "@/lib/v11/capability/effect-queries";
/**
 * GET /admin/api/v1/effects/{effect_id}/targets — 列出 EffectRecord 的所有 EffectTarget（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 EffectRecord 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 listEffectTargets（按 created_at 升序）。
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

  // 校验父 EffectRecord 存在且属于当前租户
  const effect = await getEffectRecordById(principal.tenantId, effectId);
  if (!effect) {
    return resourceNotFound(requestId, `EffectRecord 不存在或无权访问: ${effectId}`);
  }

  const targets = await listEffectTargets(principal.tenantId, effectId);

  const projected = targets.map((t) => ({
    id: t.id,
    tenant_id: t.tenantId,
    effect_record_id: t.effectRecordId,
    target_ref: t.targetRef,
    target_hash: t.targetHash,
    target_state: t.targetState,
    external_result_ref: t.externalResultRef,
    verified_at: t.verifiedAt?.toISOString() ?? null,
    evidence_json: t.evidenceJson,
    notes: t.notes,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
