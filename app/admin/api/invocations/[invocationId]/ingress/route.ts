import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getIngressByInvocation } from "@/lib/runtime/application/ingress-runtime-events";
/**
 * GET /admin/api/invocations/{invocationId}/ingress — 列出 Invocation 的 RuntimeEventIngress（S11-W04）。
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

  // 解析查询参数
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const afterSequenceParam = url.searchParams.get("after_sequence");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
  }
  let afterSequence: bigint | undefined;
  if (afterSequenceParam) {
    if (!/^(0|[1-9][0-9]*)$/.test(afterSequenceParam)) {
      return schemaInvalidTable(requestId, "after_sequence 必须是整数");
    }
    afterSequence = BigInt(afterSequenceParam);
  }

  const ingress = await getIngressByInvocation(principal.tenantId, invocationId, {
    afterSequence,
    limit,
  });

  const projected = ingress.map((g) => ({
    id: g.id,
    invocationId: g.invocationId,
    tenant_id: g.tenantId,
    producer_event_id: g.producerEventId,
    producer_sequence: String(g.producerSequence),
    candidate_type: g.candidateType,
    schema_version: g.schemaVersion,
    payload_hash: g.payloadHash,
    payload_json: g.payloadJson,
    accepted_attempt_id: g.acceptedAttemptId,
    accepted_ownership_id: g.acceptedOwnershipId,
    accepted_session_id: g.acceptedSessionId,
    accepted_epoch: String(g.acceptedEpoch),
    receipt_json: g.receiptJson,
    recovery_version_after: g.recoveryVersionAfter,
    received_at: g.receivedAt.toISOString(),
    accepted_at: g.acceptedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
