import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { getUsageRecordById } from "@/lib/v11/operations/usage-queries";
/**
 * GET /admin/api/v1/usage-records/{record_id} — UsageRecord 单资源详情（S11-W07）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 UsageRecord 存在且属于当前租户（跨租户隐藏为 404）。
 * - 投影为 snake_case + bigint 字段序列化为 string。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - UsageRecord 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ record_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { record_id: recordId } = await context.params;

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const record = await getUsageRecordById(principal.tenantId, recordId);
  if (!record) {
    return resourceNotFound(requestId, `UsageRecord 不存在或无权访问: ${recordId}`);
  }

  const body = {
    id: record.id,
    tenant_id: record.tenantId,
    dimension: record.dimension,
    scope_type: record.scopeType,
    scope_ref: record.scopeRef,
    agent_revision_id: record.agentRevisionId,
    model_ref: record.modelRef,
    tool_provider_id: record.toolProviderId,
    environment_id: record.environmentId,
    job_id: record.jobId,
    invocation_id: record.invocationId,
    quantity: record.quantity.toString(),
    unit_cost_micros: record.unitCostMicros ? record.unitCostMicros.toString() : null,
    total_cost_micros: record.totalCostMicros ? record.totalCostMicros.toString() : null,
    observed_at: record.observedAt.toISOString(),
    created_at: record.createdAt.toISOString(),
  };

  return apiSuccess(body, { headers: { [REQUEST_ID_HEADER]: requestId } });
}
