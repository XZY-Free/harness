import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { listEffectRecordsByInvocation } from "@/lib/capability/effect-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
/**
 * GET /admin/api/invocations/{invocationId}/effects — 列出 Invocation 的 EffectRecord（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Invocation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 listEffectRecordsByInvocation：直接按 EffectRecord.invocationId 读取
 *   tool_call 与 job_step 两类 owner（内连接 ToolCall 会静默丢掉 job_step 记录）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invocationId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocationId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验父 Invocation 存在且属于当前租户
  const invocation = await getInvocationById(principal.tenantId, invocationId);
  if (!invocation) {
    return resourceNotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  const effects = await listEffectRecordsByInvocation(principal.tenantId, invocationId);

  const projected = effects.map((e) => ({
    id: e.id,
    tenant_id: e.tenantId,
    owner_kind: e.ownerKind,
    owner_ref: e.ownerRef,
    invocation_id: e.invocationId,
    operation_key: e.operationKey,
    request_digest: e.requestDigest,
    dispatch_intent_at: e.dispatchIntentAt?.toISOString() ?? null,
    dispatch_evidence: e.dispatchEvidence ?? null,
    effect_type: e.effectType,
    target_summary_json: e.targetSummaryJson,
    effect_state: e.effectState,
    external_idempotency_key: e.externalIdempotencyKey,
    external_result_ref: e.externalResultRef,
    verification_method: e.verificationMethod,
    verified_at: e.verifiedAt?.toISOString() ?? null,
    evidence_json: e.evidenceJson,
    version_no: e.versionNo,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
