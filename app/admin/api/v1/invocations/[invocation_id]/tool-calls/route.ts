import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";
import { listToolCallsByInvocation } from "@/lib/v11/capability/tool-call-queries";
/**
 * GET /admin/api/v1/invocations/{invocation_id}/tool-calls — 列出 Invocation 的 ToolCall（S11-W04）。
 *
 * 行为：
 * - 解析 admin 主体（读操作，无需专门 action scope）。
 * - 校验 Invocation 存在且属于当前租户（跨租户隐藏为 404）。
 * - 调用 listToolCallsByInvocation（对象参数 { tenantId, invocationId }，按 call_sequence 升序）。
 * - 投影为 snake_case。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Invocation 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
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
    return resourceNotFound(requestId, `Invocation 不存在或无权访问: ${invocationId}`);
  }

  const toolCalls = await listToolCallsByInvocation({
    tenantId: principal.tenantId,
    invocationId,
  });

  const projected = toolCalls.map((t) => ({
    id: t.id,
    tenant_id: t.tenantId,
    invocation_id: t.invocationId,
    thread_id: t.threadId,
    turn_id: t.turnId,
    job_id: t.jobId,
    call_sequence: t.callSequence,
    tool_id: t.toolId,
    tool_schema_revision_id: t.toolSchemaRevisionId,
    schema_hash: t.schemaHash,
    call_state: t.callState,
    operation_id: t.operationId,
    arguments_redacted_json: t.argumentsRedactedJson,
    arguments_hash: t.argumentsHash,
    environment_lease_id: t.environmentLeaseId,
    result_summary_json: t.resultSummaryJson,
    result_artifact_id: t.resultArtifactId,
    item_id: t.itemId,
    error_code: t.errorCode,
    error_summary: t.errorSummary,
    started_at: t.startedAt?.toISOString() ?? null,
    finished_at: t.finishedAt?.toISOString() ?? null,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  }));

  return apiSuccess(
    { items: projected, total: projected.length },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
