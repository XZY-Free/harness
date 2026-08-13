import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { getEffectRecordByToolCall } from "@/lib/capability/effect-queries";
import { getToolCallById } from "@/lib/capability/tool-call-queries";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
/**
 * GET /admin/api/v1/tool-calls/{tool_call_id}/effects — 查询 ToolCall 的 EffectRecord（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 ToolCall 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 getEffectRecordByToolCall（1:1 关系：每个 ToolCall 至多一条 EffectRecord）。
 * - 不存在 EffectRecord → 返回 { item: null }（ToolCall 可能尚未产生副作用）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - ToolCall 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ tool_call_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { tool_call_id: toolCallId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 校验父 ToolCall 存在且属于当前租户
  const toolCall = await getToolCallById({
    tenantId: principal.tenantId,
    toolCallId,
  });
  if (!toolCall) {
    return resourceNotFound(requestId, `ToolCall 不存在或无权访问: ${toolCallId}`);
  }

  const effect = await getEffectRecordByToolCall(principal.tenantId, toolCallId);

  if (!effect) {
    return apiSuccess({ item: null }, { headers: { [REQUEST_ID_HEADER]: requestId } });
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

  return apiSuccess({ item: body }, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
