import { REQUEST_ID_HEADER, getRequestId, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { getIngressByInvocation } from "@/lib/v11/runtime/event-ingress-queries";
import { getInvocationById } from "@/lib/v11/runtime/invocation-queries";
/**
 * GET /admin/api/v1/invocations/{invocation_id}/ingress — 列出 Invocation 的 RuntimeEventIngress（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Invocation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 支持查询参数 after_sequence、limit。
 * - 调用 getIngressByInvocation（跨租户隔离）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - limit / after_sequence 非法 → 400 REQUEST_SCHEMA_INVALID
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invocation_id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocation_id: invocationId } = await context.params;

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
    return v11NotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const afterSequenceParam = url.searchParams.get("after_sequence");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }
  let afterSequence: number | undefined;
  if (afterSequenceParam) {
    afterSequence = Number.parseInt(afterSequenceParam, 10);
    if (!Number.isFinite(afterSequence)) {
      return v11SchemaInvalid(requestId, "after_sequence 必须是整数");
    }
  }

  const ingress = await getIngressByInvocation(principal.tenantId, invocationId, {
    afterSequence,
    limit,
  });

  const projected = ingress.map((g) => ({
    id: g.id,
    invocation_id: g.invocationId,
    tenant_id: g.tenantId,
    producer_event_id: g.producerEventId,
    producer_sequence: g.producerSequence,
    candidate_type: g.candidateType,
    schema_version: g.schemaVersion,
    payload_hash: g.payloadHash,
    payload_json: g.payloadJson,
    ingress_state: g.ingressState,
    mapped_item_id: g.mappedItemId,
    mapped_thread_event_id: g.mappedThreadEventId,
    mapped_job_event_id: g.mappedJobEventId,
    received_at: g.receivedAt.toISOString(),
    mapped_at: g.mappedAt?.toISOString() ?? null,
    rejected_reason: g.rejectedReason,
  }));

  return v11Ok(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
